"""Offline queue contract tests; no real GitHub calls or runtime writes."""
import argparse
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import multiprocessing
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/queue.py"
spec = importlib.util.spec_from_file_location("queue_under_test", SOURCE)
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


def hold_lock(runtime, entered, release):
    queue.RUNTIME = Path(runtime)
    with queue.lock():
        entered.set()
        release.wait(10)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "agents").mkdir()
        self.registry = {"employees": {
            name: {"role": role, "agent_id": name + "-session", "status": "active",
                   "capabilities": ["execute", "review"]}
            for name, role in [("qa-a", "qa"), ("qa-b", "qa"), ("eng-a", "engineering")]}}
        self.write_registry()
        self.evidence = self.root / "evidence.md"
        self.evidence.write_text("Synthetic test evidence. Results and limitations are recorded without customer data.")
        self.issues = {n: self.make_issue(n) for n in [101, 102]}
        self.calls = []
        self.failure = None
        for target, value in [("ROOT", self.root), ("RUNTIME", self.root / "runtime")]:
            mock = patch.object(queue, target, value)
            mock.start()
            self.addCleanup(mock.stop)
        mock = patch.object(queue.subprocess, "run", side_effect=self.github)
        mock.start()
        self.addCleanup(mock.stop)

    def write_registry(self):
        (self.root / "agents/registry.json").write_text(json.dumps(self.registry))

    def make_issue(self, number):
        meta = {"version": 2, "executor_role": "qa", "reviewer_role": "engineering", "depends_on": []}
        return {"number": number, "title": "Synthetic task", "state": "OPEN",
                "body": "<!-- company-task: " + json.dumps(meta) + " -->", "comments": [],
                "labels": [{"name": x} for x in ["role:qa", "state:ready", "executor:qa"]]}

    def github(self, args, **kwargs):
        self.calls.append(copy.deepcopy(args))
        if args[:3] == ["gh", "issue", "view"]:
            return subprocess.CompletedProcess(args, 0, json.dumps(self.issues[int(args[3])]), "")
        if args[:3] == ["gh", "issue", "comment"]:
            kind = "comment"
            n = int(args[3])
            def apply():
                self.issues[n]["comments"].append({"body": Path(args[-1]).read_text()})
        elif args[:4] == ["gh", "api", "--method", "PATCH"]:
            kind = "patch"
            n = int(args[4].rsplit("/", 1)[1])
            payload = json.loads(kwargs["input"])
            def apply():
                self.issues[n]["body"] = payload["body"]
                self.issues[n]["labels"] = [{"name": x} for x in payload["labels"]]
                if "state" in payload:
                    self.issues[n]["state"] = payload["state"].upper()
        else:
            raise AssertionError("Unexpected external command: " + repr(args))
        failure = self.failure
        if failure and failure[0] == kind:
            self.failure = None
            if failure[1] == "after":
                apply()
            return subprocess.CompletedProcess(args, 1, "", "synthetic transport failure")
        apply()
        return subprocess.CompletedProcess(args, 0, "{}", "")

    def run_action(self, command, employee="qa-a", number=101, agent=None):
        args = argparse.Namespace(command=command, employee=employee,
            agent=agent or self.registry["employees"][employee]["agent_id"],
            issue=number, body_file=str(self.evidence), to=None, role=None)
        with contextlib.redirect_stdout(io.StringIO()):
            queue.run(args)

    def test_same_role_employees_can_claim_different_tasks(self):
        self.run_action("claim")
        self.run_action("claim", "qa-b", 102)
        leases = queue.read_leases()
        self.assertEqual({x["employee"] for x in leases.values()}, {"qa-a", "qa-b"})
        self.assertNotEqual(leases["101"]["delivery"], leases["102"]["delivery"])

    def test_one_employee_cannot_claim_two_tasks(self):
        self.run_action("claim")
        with self.assertRaises(ValueError):
            self.run_action("claim", number=102)
        self.assertIn("state:ready", queue.names(self.issues[102]))

    def test_same_task_cannot_be_stolen_even_after_expiry(self):
        self.run_action("claim")
        leases = queue.read_leases()
        leases["101"]["expires_at"] = 0
        queue.save_leases(leases)
        before = copy.deepcopy(self.issues)
        with self.assertRaises(ValueError):
            self.run_action("claim", "qa-b")
        self.assertEqual(queue.read_leases(), leases)
        self.assertEqual(self.issues, before)

    def test_unregistered_session_rejected_before_github(self):
        with self.assertRaises(ValueError):
            self.run_action("claim", agent="unregistered-session")
        self.assertEqual(self.calls, [])

    def test_repeated_claim_preserves_delivery(self):
        self.run_action("claim")
        delivery = queue.read_leases()["101"]["delivery"]
        self.run_action("claim")
        self.assertEqual(queue.read_leases()["101"]["delivery"], delivery)

    def test_employee_cannot_self_review_after_session_and_role_change(self):
        self.run_action("claim")
        self.run_action("submit")
        self.registry["employees"]["qa-a"].update(agent_id="replacement-session", role="engineering")
        self.write_registry()
        for command in ["claim", "accept", "return"]:
            with self.subTest(command=command), self.assertRaises(ValueError):
                self.run_action(command)
        self.assertIn("state:review", queue.names(self.issues[101]))

    def test_independent_reviewer_accepts_and_duplicate_accept_is_noop(self):
        self.run_action("claim")
        self.run_action("submit")
        self.run_action("claim", "eng-a")
        self.run_action("accept", "eng-a")
        self.assertEqual(self.issues[101]["state"], "CLOSED")
        self.assertEqual(queue.metadata(self.issues[101])["accepted_by"], "eng-a")
        before = copy.deepcopy(self.issues)
        self.run_action("accept", "eng-a")
        self.assertEqual(self.issues, before)

    def test_duplicate_submit_has_no_write_side_effects(self):
        self.run_action("claim")
        self.run_action("submit")
        before = copy.deepcopy(self.issues)
        self.calls.clear()
        self.run_action("submit")
        self.assertEqual(self.issues, before)
        self.assertTrue(all(c[:3] == ["gh", "issue", "view"] for c in self.calls))

    def check_handoff_failure(self, kind, timing):
        self.run_action("claim")
        delivery = queue.read_leases()["101"]["delivery"]
        self.failure = (kind, timing)
        with self.assertRaisesRegex(RuntimeError, "synthetic transport failure"):
            self.run_action("submit")
        lease = queue.read_leases()["101"]
        self.assertEqual(lease["pending"]["action"], "submit")
        self.assertFalse(lease.get("released", False))
        self.run_action("submit")
        self.assertEqual(queue.names(self.issues[101]), {"role:engineering", "state:review", "executor:qa"})
        self.assertEqual(len(self.issues[101]["comments"]), 1)
        self.assertIn(delivery, self.issues[101]["comments"][0]["body"])
        lease = queue.read_leases()["101"]
        self.assertTrue(lease["released"])
        self.assertNotIn("pending", lease)
        self.run_action("submit")
        self.assertEqual(len(self.issues[101]["comments"]), 1)

    def test_comment_failure_before_write_recovers(self):
        self.check_handoff_failure("comment", "before")

    def test_comment_response_lost_after_write_deduplicates(self):
        self.check_handoff_failure("comment", "after")

    def test_patch_failure_before_write_recovers(self):
        self.check_handoff_failure("patch", "before")

    def test_patch_response_lost_after_write_recovers(self):
        self.check_handoff_failure("patch", "after")

    def test_retry_does_not_overwrite_unrelated_remote_handoff(self):
        self.run_action("claim")
        self.failure = ("patch", "before")
        with self.assertRaises(RuntimeError):
            self.run_action("submit")
        self.issues[101]["labels"] = [{"name": "role:gm"}, {"name": "state:blocked"}]
        before = copy.deepcopy(self.issues)
        with self.assertRaises(ValueError):
            self.run_action("submit")
        self.assertEqual(self.issues, before)

    def test_pending_handoff_cannot_be_reclaimed(self):
        self.run_action("claim")
        self.failure = ("comment", "before")
        with self.assertRaises(RuntimeError):
            self.run_action("submit")
        with self.assertRaises(ValueError):
            self.run_action("claim")

    def test_real_file_lock_serializes_processes(self):
        ctx = multiprocessing.get_context("fork")
        entered1, entered2, release = ctx.Event(), ctx.Event(), ctx.Event()
        processes = [ctx.Process(target=hold_lock, args=(str(queue.RUNTIME), entered, release))
                     for entered in [entered1, entered2]]
        try:
            processes[0].start()
            self.assertTrue(entered1.wait(3), "first process failed to acquire lock")
            processes[1].start()
            self.assertFalse(entered2.wait(0.3), "second process bypassed held lock")
            release.set()
            self.assertTrue(entered2.wait(3), "second process did not acquire released lock")
            for process in processes:
                process.join(3)
                self.assertEqual(process.exitcode, 0)
        finally:
            release.set()
            for process in processes:
                if process.pid is not None:
                    if process.is_alive():
                        process.terminate()
                    process.join(3)


if __name__ == "__main__":
    print("queue.py SHA256:", hashlib.sha256(SOURCE.read_bytes()).hexdigest(), flush=True)
    unittest.main(verbosity=2)
