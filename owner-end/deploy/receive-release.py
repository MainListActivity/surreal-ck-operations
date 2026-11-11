#!/usr/bin/python3
"""Root SSH forced-command receiver. No shell, paths or service names come from CI."""
from __future__ import annotations

import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path('/opt/sck-owner')
MAX_ARCHIVE = 20 * 1024 * 1024
ASSETS = {'server.js', 'server-cron.js'}
FILES = ASSETS | {'manifest.json'}
SHA = r'[0-9a-f]{40}'
NUM = r'(?:0|[1-9][0-9]*)'
PRE = r'(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
SEMVER = rf'{NUM}\.{NUM}\.{NUM}(?:-{PRE}(?:\.{PRE})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?'
COMMAND = re.compile(rf'deploy ({SHA}) ({SEMVER})', re.ASCII)


class Rejected(Exception):
    pass


def parse_command(args: list[str], environ: dict[str, str]) -> tuple[str, str]:
    if len(args) > 1:
        raise Rejected('只接受一个固定部署命令')
    original = environ.get('SSH_ORIGINAL_COMMAND', '')
    command = args[0] if args else original
    if original and args and original != command:
        raise Rejected('部署命令不一致')
    if len(command) > 176:
        raise Rejected('部署命令超过长度限制')
    match = COMMAND.fullmatch(command)
    if not match or len(match.group(2)) > 128:
        raise Rejected('命令必须为 deploy <40位小写SHA> <semver>')
    return match.group(1), match.group(2)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Rejected('manifest 存在重复字段')
        result[key] = value
    return result


def decode_manifest(data: bytes) -> dict:
    if len(data) > 65536:
        raise Rejected('manifest 超过大小限制')
    try:
        value = json.loads(data.decode('utf-8'), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError):
        raise Rejected('manifest 不是有效 JSON') from None
    if not isinstance(value, dict):
        raise Rejected('manifest 必须是对象')
    return value


def validate_payload(data: bytes, sha: str, version: str) -> dict[str, bytes]:
    if len(data) > MAX_ARCHIVE:
        raise Rejected('发布包超过 20 MiB')
    contents = {}
    last_end = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
            for member in archive:
                if (member.name not in FILES or member.name in contents or
                        not member.isreg() or member.pax_headers or member.issparse() or
                        member.offset != last_end or member.offset_data != member.offset + 512 or
                        member.size < 0 or member.size > MAX_ARCHIVE):
                    raise Rejected('发布包包含非白名单文件、重复文件或特殊条目')
                source = archive.extractfile(member)
                if source is None:
                    raise Rejected('发布包文件不可读取')
                contents[member.name] = source.read(MAX_ARCHIVE + 1)
                if len(contents[member.name]) != member.size:
                    raise Rejected('发布包文件不完整')
                last_end = member.offset_data + ((member.size + 511) // 512) * 512
    except (tarfile.TarError, OSError, EOFError):
        raise Rejected('发布包必须是完整、未压缩的 tar') from None
    # tarfile 会忽略结束标记后数据；显式拒绝拼接包和隐藏条目。
    if (set(contents) != FILES or len(data) - last_end < 1024 or
            len(data) % 512 or any(data[last_end:])):
        raise Rejected('发布包文件集合或结束标记不正确')
    manifest = decode_manifest(contents['manifest.json'])
    if (set(manifest) != {'schema', 'sha', 'version', 'files'} or
            type(manifest['schema']) is not int or manifest['schema'] != 1 or
            manifest['sha'] != sha or manifest['version'] != version or
            not isinstance(manifest['files'], dict) or set(manifest['files']) != ASSETS):
        raise Rejected('manifest 与部署命令不匹配')
    for name in ASSETS:
        meta = manifest['files'][name]
        if (not isinstance(meta, dict) or set(meta) != {'sha256', 'size'} or
                type(meta['size']) is not int or meta['size'] != len(contents[name]) or
                meta['sha256'] != hashlib.sha256(contents[name]).hexdigest()):
            raise Rejected('发布文件的大小或 SHA256 不匹配')
    return contents


def systemctl(action: str) -> None:
    result = subprocess.run(['/usr/bin/systemctl', action, 'sck-owner-backend.service'],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=40, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
    if result.returncode:
        raise Rejected('后端服务操作失败')


def healthy(sha: str, version: str) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with opener.open('http://127.0.0.1:39125/healthz', timeout=2) as response:
                body = json.loads(response.read(65537))
                if (response.status == 200 and isinstance(body, dict) and body.get('ok') is True and
                        body.get('sha') == sha and body.get('version') == version):
                    return True
        except (OSError, ValueError):
            pass
        time.sleep(1)
    return False


def fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Receiver:
    """Injectable filesystem/service boundary for regression tests; CLI always uses ROOT."""
    def __init__(self, root: Path = ROOT, control=systemctl, probe=healthy):
        self.root, self.control, self.probe = root, control, probe

    def switch(self, target: Path) -> None:
        link = self.root / '.current-next'
        link.unlink(missing_ok=True)
        link.symlink_to(target)
        os.replace(link, self.root / 'current')
        fsync_dir(self.root)

    def restart(self) -> None:
        # A crashed candidate may exhaust StartLimitBurst; don't let that prevent
        # the known previous version from starting during rollback.
        self.control('reset-failed')
        self.control('restart')

    def deploy(self, sha: str, version: str, contents: dict[str, bytes]) -> None:
        releases = self.root / 'releases'
        if not self.root.is_dir() or self.root.is_symlink():
            raise Rejected('部署根目录尚未由管理员初始化')
        if releases.is_symlink():
            raise Rejected('releases 不允许是链接')
        releases.mkdir(mode=0o755, exist_ok=True)
        with (self.root / '.deploy.lock').open('a') as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Rejected('已有发布正在执行') from None
            current = self.root / 'current'
            previous = None
            previous_manifest = None
            if current.is_symlink():
                previous = current.resolve(strict=True)
                if previous.parent != releases.resolve() or not re.fullmatch(SHA, previous.name):
                    raise Rejected('current 不在受控 release 目录')
                previous_manifest = decode_manifest((previous / 'manifest.json').read_bytes())
                if (previous_manifest.get('sha') != previous.name or
                        not re.fullmatch(SEMVER, str(previous_manifest.get('version', '')))):
                    raise Rejected('旧版本元数据不正确')
            elif current.exists():
                raise Rejected('current 必须是符号链接')
            release = releases / sha
            expected = {**contents, 'release.env':
                        f'OWNER_RELEASE_VERSION={version}\nOWNER_RELEASE_SHA={sha}\n'.encode()}
            if release.exists() or release.is_symlink():
                if (release.is_symlink() or not release.is_dir() or
                        set(p.name for p in release.iterdir()) != set(expected) or
                        any((release / name).is_symlink() or not (release / name).is_file() or
                            (release / name).read_bytes() != body for name, body in expected.items())):
                    raise Rejected('相同 SHA 已存在不同或不安全的产物')
            else:
                stage = Path(tempfile.mkdtemp(prefix='.staging-', dir=releases))
                try:
                    stage.chmod(0o755)
                    for name, body in expected.items():
                        with (stage / name).open('xb') as dest:
                            os.fchmod(dest.fileno(), 0o644)
                            dest.write(body)
                            dest.flush()
                            os.fsync(dest.fileno())
                    fsync_dir(stage)
                    os.rename(stage, release)
                    fsync_dir(releases)
                finally:
                    if stage.exists():
                        shutil.rmtree(stage)
            try:
                self.switch(release)
                self.restart()
                if not self.probe(sha, version):
                    raise Rejected('新版本健康检查未通过')
            except Exception:
                try:
                    if previous is not None:
                        self.switch(previous)
                        self.restart()
                        if not self.probe(previous_manifest['sha'], previous_manifest['version']):
                            raise Rejected('旧版本健康检查未通过')
                    else:
                        current.unlink()
                        fsync_dir(self.root)
                        self.control('stop')
                except Exception:
                    raise Rejected('发布失败，旧版本恢复未通过验证；需要检查服务状态') from None
                raise Rejected('发布失败，已恢复发布前状态') from None


def main() -> int:
    try:
        sha, version = parse_command(sys.argv[1:], os.environ)
        if os.geteuid() != 0:
            raise Rejected('接收器只能由 root forced-command 调用')
        os.umask(0o022)
        def timeout(_signum, _frame):
            raise Rejected('发布包接收超时')
        signal.signal(signal.SIGALRM, timeout)
        signal.alarm(60)
        data = sys.stdin.buffer.read(MAX_ARCHIVE + 1)
        signal.alarm(0)
        payload = validate_payload(data, sha, version)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        Receiver().deploy(sha, version, payload)
        print(json.dumps({'status': 'healthy', 'sha': sha, 'version': version}))
        return 0
    except Rejected as error:
        print(str(error), file=sys.stderr)
    except Exception:
        # Never emit exception objects, subprocess output, config contents or a traceback.
        print('部署接收失败，请检查接收器与服务状态', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
