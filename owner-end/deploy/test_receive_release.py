"""Security and rollback checks; no real systemctl, network, root or deployment writes."""
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).with_name('receive-release.py'))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
OLD = 'a' * 40
NEW = 'b' * 40


def payload(sha=NEW, version='0.11.13'):
    files = {'server.js': b'console.log("server");\n', 'server-cron.js': b'console.log("cron");\n'}
    manifest = {'schema': 1, 'sha': sha, 'version': version, 'files': {
        name: {'sha256': hashlib.sha256(body).hexdigest(), 'size': len(body)} for name, body in files.items()}}
    return {**files, 'manifest.json': json.dumps(manifest).encode()}


def tar(files=None, extra=None, fmt=tarfile.USTAR_FORMAT):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=fmt) as archive:
        for name, body in (files or payload()).items():
            entry = tarfile.TarInfo(name)
            entry.size = len(body)
            archive.addfile(entry, io.BytesIO(body))
        if extra:
            entry, body = extra
            archive.addfile(entry, io.BytesIO(body))
    return output.getvalue()


class ArchiveTests(unittest.TestCase):
    def test_command_contract(self):
        command = f'deploy {NEW} 1.2.3-rc.1+build.4'
        self.assertEqual(receiver.parse_command([], {'SSH_ORIGINAL_COMMAND': command}), (NEW, '1.2.3-rc.1+build.4'))
        self.assertEqual(receiver.parse_command([command], {'SSH_ORIGINAL_COMMAND': command}), (NEW, '1.2.3-rc.1+build.4'))
        for bad in ['', command + '\n', command + ';id', f'deploy {NEW} 01.2.3',
                    f'deploy {NEW.upper()} 1.2.3', f'deploy {NEW} 1.2.3-01',
                    f'deploy {NEW} ../../etc', 'bash', command + ' /tmp/a',
                    f'deploy {NEW} 1.2.3-' + 'a' * 200]:
            with self.subTest(bad=bad), self.assertRaises(receiver.Rejected):
                receiver.parse_command([bad], {})
        with self.assertRaises(receiver.Rejected):
            receiver.parse_command([command], {'SSH_ORIGINAL_COMMAND': 'id'})
        with self.assertRaises(receiver.Rejected):
            receiver.parse_command([command, '/tmp'], {})

    def test_only_expected_tar_is_accepted(self):
        self.assertEqual(receiver.validate_payload(tar(), NEW, '0.11.13'), payload())

    def test_paths_links_devices_duplicates_rejected(self):
        for name, kind in [('../server.js', tarfile.REGTYPE), ('/server.js', tarfile.REGTYPE),
                           ('./server.js', tarfile.REGTYPE), ('server.js', tarfile.REGTYPE),
                           ('directory/', tarfile.DIRTYPE), ('server.js', tarfile.SYMTYPE),
                           ('server.js', tarfile.LNKTYPE), ('server.js', tarfile.FIFOTYPE),
                           ('server.js', tarfile.CHRTYPE)]:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.linkname = '/etc/passwd' if kind in [tarfile.SYMTYPE, tarfile.LNKTYPE] else ''
            with self.subTest(name=name, kind=kind), self.assertRaises(receiver.Rejected):
                receiver.validate_payload(tar(extra=(entry, b'')), NEW, '0.11.13')

    def test_hidden_trailing_gzip_and_metadata_rejected(self):
        import gzip
        for data in [tar() + tar(), tar() + b'x' * 512, tar()[:-1], gzip.compress(tar()), b'']:
            with self.subTest(length=len(data)), self.assertRaises(receiver.Rejected):
                receiver.validate_payload(data, NEW, '0.11.13')
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, body in payload().items():
                entry = tarfile.TarInfo(name)
                entry.size = len(body)
                entry.pax_headers = {'comment': 'hidden'}
                archive.addfile(entry, io.BytesIO(body))
        with self.assertRaises(receiver.Rejected):
            receiver.validate_payload(output.getvalue(), NEW, '0.11.13')

    def test_size_hash_and_identity(self):
        for field, value in [('sha', OLD), ('version', '0.11.12'), ('schema', True)]:
            files = payload()
            manifest = json.loads(files['manifest.json'])
            manifest[field] = value
            files['manifest.json'] = json.dumps(manifest).encode()
            with self.subTest(field=field), self.assertRaises(receiver.Rejected):
                receiver.validate_payload(tar(files), NEW, '0.11.13')
        files = payload()
        files['server.js'] += b'changed'
        with self.assertRaises(receiver.Rejected):
            receiver.validate_payload(tar(files), NEW, '0.11.13')
        with self.assertRaises(receiver.Rejected):
            receiver.validate_payload(b'0' * (receiver.MAX_ARCHIVE + 1), NEW, '0.11.13')
        with self.assertRaises(receiver.Rejected):
            receiver.decode_manifest(b'{"sha":"a","sha":"b"}')
        with self.assertRaises(receiver.Rejected):
            receiver.decode_manifest(b'[]')


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.calls = []
        self.receiver = receiver.Receiver(self.root, self.calls.append, lambda sha, version: True)

    def deploy_old(self):
        self.receiver.deploy(OLD, '0.11.12', payload(OLD, '0.11.12'))
        self.calls.clear()

    def test_success_and_identical_retry(self):
        self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertEqual((self.root / 'current').resolve(), self.root / 'releases' / NEW)
        self.assertEqual((self.root / 'current/release.env').read_text(),
                         f'OWNER_RELEASE_VERSION=0.11.13\nOWNER_RELEASE_SHA={NEW}\n')
        self.assertEqual((self.root / 'current/server.js').stat().st_mode & 0o777, 0o644)
        self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertEqual(self.calls, ['reset-failed', 'restart', 'reset-failed', 'restart'])

    def test_bad_health_rolls_back_and_verifies_old(self):
        self.deploy_old()
        probes = []
        def probe(sha, version):
            probes.append((sha, version))
            return sha == OLD
        self.receiver.probe = probe
        with self.assertRaisesRegex(receiver.Rejected, '已恢复'):
            self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertEqual((self.root / 'current').resolve().name, OLD)
        self.assertEqual(self.calls, ['reset-failed', 'restart', 'reset-failed', 'restart'])
        self.assertEqual(probes, [(NEW, '0.11.13'), (OLD, '0.11.12')])

    def test_restart_failure_rolls_back(self):
        self.deploy_old()
        def control(action):
            self.calls.append(action)
            if len(self.calls) == 2:
                raise RuntimeError('simulated')
        self.receiver.control = control
        with self.assertRaisesRegex(receiver.Rejected, '已恢复'):
            self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertEqual((self.root / 'current').resolve().name, OLD)
        self.assertEqual(self.calls, ['reset-failed', 'restart', 'reset-failed', 'restart'])

    def test_reset_failed_error_on_unloaded_unit_is_not_fatal(self):
        def control(action):
            self.calls.append(action)
            if action == 'reset-failed':
                raise receiver.Rejected('unit not loaded')
        self.receiver.control = control
        self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertEqual((self.root / 'current').resolve().name, NEW)
        self.assertEqual(self.calls, ['reset-failed', 'restart'])

    def test_failed_rollback_reports_failure(self):
        self.deploy_old()
        self.receiver.probe = lambda sha, version: False
        with self.assertRaisesRegex(receiver.Rejected, '恢复未通过验证'):
            self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertEqual((self.root / 'current').resolve().name, OLD)

    def test_initial_failure_removes_pointer_and_stops(self):
        self.receiver.probe = lambda sha, version: False
        with self.assertRaisesRegex(receiver.Rejected, '已恢复'):
            self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertFalse((self.root / 'current').exists())
        self.assertEqual(self.calls, ['reset-failed', 'restart', 'stop'])

    def test_same_sha_mismatch_is_rejected_without_restart(self):
        self.receiver.deploy(NEW, '0.11.13', payload())
        self.calls.clear()
        changed = payload()
        changed['server.js'] = b'different'
        with self.assertRaises(receiver.Rejected):
            self.receiver.deploy(NEW, '0.11.13', changed)
        self.assertEqual(self.calls, [])

    def test_untrusted_current_and_release_symlinks(self):
        (self.root / 'current').symlink_to(self.root)
        with self.assertRaises(receiver.Rejected):
            self.receiver.deploy(NEW, '0.11.13', payload())
        (self.root / 'current').unlink()
        (self.root / 'releases' / NEW).symlink_to(self.root)
        with self.assertRaises(receiver.Rejected):
            self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertEqual(self.calls, [])

    def test_concurrent_deploy_is_rejected(self):
        with (self.root / '.deploy.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(receiver.Rejected, '已有发布'):
                self.receiver.deploy(NEW, '0.11.13', payload())
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
