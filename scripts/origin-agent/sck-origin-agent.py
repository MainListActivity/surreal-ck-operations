#!/usr/bin/env python3
"""Forced command behind the ops broker's origin key (authorized_keys: command="…",restrict).

The broker sends one JSON request as the SSH command; sshd hands it over in SSH_ORIGINAL_COMMAND
and runs this file instead. Only fixed, read-only operations exist, every argument is validated,
nothing goes through a shell, and output is redacted and size-capped. The account has no sudo:
it reads the journal through the systemd-journal group.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

# Services an employee may inspect. Proxies, monitoring and the subscription gateway stay out.
SERVICES = ("surreal-ck-hono", "surrealdb", "caddy")
HEALTH = {
    "surreal-ck-hono": "http://127.0.0.1:8080/health",
    "surrealdb": "http://127.0.0.1:8000/health",
    "status-face": "http://127.0.0.1:18778/healthz",
}
MAX_LINES = 500
MAX_HOURS = 72
MAX_BYTES = 40_000

SECRETS = [
    (re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "[jwt]"),
    (re.compile(r"(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 [redacted]"),
    (re.compile(r"(?i)((?:pass(?:word)?|passwd|secret|token|api[_-]?key|key|auth(?:orization)?|cookie|session|code)\"?\s*[:=]\s*\"?)[^\s\"&,;}]+"), r"\1[redacted]"),
    (re.compile(r"[A-Fa-f0-9]{32,}"), "[hex]"),
    (re.compile(r"[A-Za-z0-9+/_-]{40,}={0,2}"), "[blob]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[email]"),
]


def redact(text: str) -> str:
    for pattern, repl in SECRETS:
        text = pattern.sub(repl, text)
    return text


def fail(code: str, message: str) -> None:
    print(json.dumps({"ok": False, "code": code, "error": message}))
    sys.exit(0)


def run(argv, timeout=20):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "SYSTEMD_COLORS": "0"})


def service_state(name: str) -> dict:
    props = "ActiveState,SubState,ActiveEnterTimestamp,NRestarts,MemoryCurrent,MainPID"
    out = run(["systemctl", "show", name, "-p", props, "--no-pager"]).stdout
    fields = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    memory = fields.get("MemoryCurrent", "")
    return {
        "active": fields.get("ActiveState"), "sub": fields.get("SubState"), "since": fields.get("ActiveEnterTimestamp") or None,
        "restarts": int(fields["NRestarts"]) if fields.get("NRestarts", "").isdigit() else None,
        "memoryMB": round(int(memory) / 1048576) if memory.isdigit() else None,
    }


def status(_req: dict) -> dict:
    disk = shutil.disk_usage("/")
    meminfo = {}
    with open("/proc/meminfo") as f:
        for line in f:
            key, value = line.split(":", 1)
            meminfo[key] = int(value.split()[0])
    with open("/proc/loadavg") as f:
        load = f.read().split()[:3]
    with open("/proc/uptime") as f:
        uptime = float(f.read().split()[0])
    return {
        "services": {name: service_state(name) for name in SERVICES},
        "disk": {"path": "/", "usedPct": round(100 * disk.used / disk.total, 1), "freeGB": round(disk.free / 1e9, 1)},
        "memory": {"totalMB": meminfo["MemTotal"] // 1024, "availableMB": meminfo["MemAvailable"] // 1024},
        "load": [float(x) for x in load],
        "uptimeHours": round(uptime / 3600, 1),
    }


def health(_req: dict) -> dict:
    results = {}
    for name, url in HEALTH.items():
        started = time.monotonic()
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                code, body = r.status, r.read(600).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            code, body = e.code, e.read(600).decode("utf-8", "replace")
        except Exception as e:  # unreachable: report the kind, not the text
            results[name] = {"reachable": False, "error": type(e).__name__}
            continue
        results[name] = {"reachable": True, "status": code, "ms": round((time.monotonic() - started) * 1000), "body": redact(body[:500])}
    return {"checks": results}


def logs(req: dict) -> dict:
    service = req.get("service")
    if service not in SERVICES:
        fail("invalid", f"service must be one of {', '.join(SERVICES)}")
    since = str(req.get("since", "30m"))
    m = re.fullmatch(r"(\d{1,4})([mh])", since)
    if not m:
        fail("invalid", "since must look like 30m or 6h")
    minutes = int(m.group(1)) * (60 if m.group(2) == "h" else 1)
    if not 1 <= minutes <= MAX_HOURS * 60:
        fail("invalid", f"since must be at most {MAX_HOURS}h")
    lines = req.get("lines", 200)
    if type(lines) is not int or not 1 <= lines <= MAX_LINES:
        fail("invalid", f"lines must be an integer from 1 to {MAX_LINES}")
    grep = req.get("grep")
    if grep is not None and (not isinstance(grep, str) or not 1 <= len(grep) <= 100):
        fail("invalid", "grep must be 1-100 characters (plain text, case-insensitive)")
    priority = req.get("priority")
    if priority is not None and priority not in ("err", "warning", "info"):
        fail("invalid", "priority must be err, warning or info")
    argv = ["journalctl", "-u", service, "--since", f"-{minutes}min", "--no-pager", "-o", "short-iso", "-q"]
    if priority:
        argv += ["-p", priority]
    out = run(argv, timeout=30).stdout.splitlines()
    if grep:
        needle = grep.lower()
        out = [line for line in out if needle in line.lower()]
    matched = len(out)
    picked = [redact(line[:2000]) for line in out[-lines:]]
    size, kept = 0, []
    for line in reversed(picked):
        size += len(line.encode()) + 1
        if size > MAX_BYTES:
            break
        kept.append(line)
    kept.reverse()
    return {"service": service, "since": since, "matched": matched, "returned": len(kept), "truncated": len(kept) < matched, "lines": kept}


OPS = {"status": status, "health": health, "logs": logs}


def main() -> None:
    raw = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if len(raw) > 2000:
        fail("invalid", "request too large")
    try:
        req = json.loads(raw)
    except ValueError:
        fail("invalid", "request must be one JSON object")
    if not isinstance(req, dict) or req.get("op") not in OPS:
        fail("invalid", f"op must be one of {', '.join(OPS)}")
    try:
        result = OPS[req["op"]](req)
    except subprocess.TimeoutExpired:
        fail("timeout", "the host did not answer in time")
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
