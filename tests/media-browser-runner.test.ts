import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyError } from '../src/core-errors.ts';
import { BrowserStudio, runWithSpawn } from '../src/media/browser.ts';

// Spawn-level stub for the real runner protocol (task 9bba6851 contract §2.3):
// a programmable child whose stdout/stderr/exit/error sequence the test drives.
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: Array<string | undefined> = [];
  kill(signal?: string) { this.kills.push(signal); return true; }
}

const spawnOf = (child: FakeChild, seen?: { bin?: string; args?: string[]; opts?: unknown }) =>
  ((bin: string, args: string[], opts: unknown) => {
    if (seen) { seen.bin = bin; seen.args = args; seen.opts = opts; }
    return child;
  }) as unknown as typeof spawn;

const run = (child: FakeChild, timeoutMs = 60_000, graceMs = 30_000) =>
  runWithSpawn(spawnOf(child), '/fake/ego-browser', ['nodejs', '-e', 'script'], timeoutMs, graceMs);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('runWithSpawn: ego-browser stream protocol', () => {
  test('T1: marker on stderr + exit 0 parses the result (real channel, probe P1 bytes)', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stderr.emit('data', '__RESULT__{"ok":true,"probe":"stdout-check","at":"2026-10-15"}\n\n');
    child.emit('close', 0, null);
    const r = await p;
    expect(r.ok).toBe(true);
    expect((r as { probe?: string }).probe).toBe('stdout-check');
  });

  test('T2: marker only on stdout still parses (fallback if the CLI changes back)', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stdout.emit('data', '__RESULT__{"ok":true,"via":"canvas"}\n');
    child.emit('close', 0, null);
    expect((await p).ok).toBe(true);
  });

  test('T3: stderr wins over stdout; last marker wins within one stream (probe P5 bytes)', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stdout.emit('data', '__RESULT__{"ok":false,"code":"stdout-loser"}\n');
    child.stderr.emit('data', '__RESULT__{"ok":false,"code":"first"}\nnoise\n__RESULT__{"ok":true,"code":"last"}\n');
    child.emit('close', 0, null);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.code).toBe('last');
  });

  test('T4: stderr marker + exit 1 (probe P8 emit-then-crash) fails closed, marker is diagnostic only', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stderr.emit('data', "Error: post-marker-crash\n    at file:////[eval2]:1:124\n__RESULT__{\"ok\":true,\"probe\":\"emit-then-crash\"}\n\nego's nodejs process exited with code 1.\n");
    child.emit('close', 1, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('failed');
    expect(r.message).toContain('进程异常结束(exit=1');
    expect(r.message).toContain('已产出结果被丢弃'); // presence flag only
    expect(r.message).not.toContain('emit-then-crash'); // marker payload never echoed
    expect(r.message).not.toContain('post-marker-crash'); // raw stderr never echoed
  });

  test('T5: our SIGKILL settles as timeout; an earlier marker does not count', async () => {
    const child = new FakeChild();
    const p = run(child, 5, 20); // kill timer fires ~25ms in
    child.stderr.emit('data', '__RESULT__{"ok":true}\n');
    await sleep(80);
    expect(child.kills).toEqual(['SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('脚本超时已终止');
  });

  test('T6: no marker + exit 1 (probe P3 signature) is an abnormal exit with the stderr tail', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stderr.emit('data', 'Error: probe-crash at [eval]:1\n');
    child.emit('close', 1, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('进程异常结束(exit=1');
    expect(r.message).not.toContain('probe-crash'); // stderr content must not leak
  });

  test('T6b: no marker + clean exit 0 is 脚本无结果输出', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stderr.emit('data', 'some diagnostic noise\n');
    child.emit('close', 0, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('脚本无结果输出');
    expect(r.message).not.toContain('some diagnostic noise'); // stderr content must not leak
  });

  test('T7: spawn error settles once; a later close cannot override', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.emit('error', new Error('spawn /fake/ego-browser ENOENT'));
    child.emit('close', 1, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ego-browser 启动失败');
    expect(r.message).toContain('ENOENT');
  });

  test('T8: close before the deadline clears the kill timer', async () => {
    const child = new FakeChild();
    const p = run(child, 5, 20); // would kill ~25ms in if the timer were not cleared
    child.stderr.emit('data', '__RESULT__{"ok":true}\n');
    child.emit('close', 0, null);
    await p;
    await sleep(80);
    expect(child.kills).toHaveLength(0);
  });

  test('T9: bad JSON / non-object / missing ok / wrong-typed fields all fail closed as 结果解析失败', async () => {
    for (const line of [
      '__RESULT__not-json', '__RESULT__123', '__RESULT__[1,2]', '__RESULT__{"code":"x"}', '__RESULT__{"ok":"yes"}',
      // QA return R1: supported fields with wrong types must not pass as success or error
      '__RESULT__{"ok":true,"file":17,"bytes":"bad","message":{},"url":[],"code":42}',
      '__RESULT__{"ok":false,"code":42}',
      '__RESULT__{"ok":true,"notebooks":{"id":"x"}}',
      '__RESULT__{"ok":true,"notebook":[1,2]}',
      '__RESULT__{"ok":true,"extra":{"nested":"object"}}',
    ]) {
      const child = new FakeChild();
      const p = run(child);
      child.stderr.emit('data', `${line}\n`);
      child.emit('close', 0, null);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.message).toBe('结果解析失败');
    }
  });

  test('T10: ok:false business error + exit 0 passes code through untouched', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stderr.emit('data', '__RESULT__{"ok":false,"code":"login_required","message":"notebook.google.com 需要重新登录"}\n');
    child.emit('close', 0, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.code).toBe('login_required');
    expect(r.message).toContain('需要重新登录');
  });

  test('R1: all supported RunResult field shapes pass through unchanged', async () => {
    for (const [line, check] of [
      ['__RESULT__{"ok":true,"file":"/x.png","bytes":2,"via":"canvas"}', (r: { file?: string; via?: string }) => r.file === '/x.png' && r.via === 'canvas'],
      ['__RESULT__{"ok":true,"notebook":{"id":"n1","title":"梦痕纪元"},"url":"https://notebook.google.com/notebook/n1"}', (r: { url?: string }) => r.url!.includes('n1')],
      ['__RESULT__{"ok":true,"notebooks":[{"id":"a"}]}', (r: { notebooks?: unknown }) => Array.isArray(r.notebooks) && r.notebooks.length === 1],
      ['__RESULT__{"ok":true,"text":"章节正文……","notebook":"nb-id"}', (r: { text?: string }) => r.text === '章节正文……'],
    ] as const) {
      const child = new FakeChild();
      const p = run(child);
      child.stderr.emit('data', `${line}\n`);
      child.emit('close', 0, null);
      const r = await p;
      expect(r.ok).toBe(true);
      expect(check(r)).toBe(true);
    }
  });

  test('R2: private stderr/marker content never appears in failure messages', async () => {
    const SECRET = 'PRIVATE-CHAPTER-老板正文-sentinel-7f3a';
    // abnormal exit with page content + marker on stderr
    let child = new FakeChild();
    let p = run(child);
    child.stderr.emit('data', `page dump ${SECRET}\n__RESULT__{"ok":true,"text":"${SECRET}"}\n`);
    child.emit('close', 1, null);
    let r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(SECRET);
    // clean exit with noisy stderr but no marker
    child = new FakeChild();
    p = run(child);
    child.stderr.emit('data', `login wall text ${SECRET}\n`);
    child.emit('close', 0, null);
    r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('脚本无结果输出');
    expect(r.message).not.toContain(SECRET);
    // killed after writing private content
    child = new FakeChild();
    p = run(child, 5, 20);
    child.stderr.emit('data', `${SECRET}\n`);
    await sleep(80);
    child.emit('close', null, 'SIGKILL');
    r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(SECRET);
  });

  test('fragmented marker chunks and mid-line lookalikes: only line-start markers count', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.stderr.emit('data', 'page log line\n__RES');
    child.stderr.emit('data', 'ULT__{"ok":true,"via":"canvas"}');
    child.stderr.emit('data', '\ntrailing noise with a fake __RESULT__{"ok":false} mid-line\n');
    child.emit('close', 0, null);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.via).toBe('canvas');
  });

  test('external signal (not our kill) is an abnormal exit, not 脚本超时已终止', async () => {
    const child = new FakeChild();
    const p = run(child);
    child.emit('close', null, 'SIGTERM');
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('进程异常结束(signal=SIGTERM');
  });
});

describe('BrowserStudio through the real default runner (deps.spawn seam)', () => {
  const core = {
    opsScope: async (credential: string, taskId: string) => {
      if (credential !== 'holder') throw new CompanyError('forbidden', 'no lease');
      return { actor: { employeeId: 'emp-1', role: 'engineering', capabilities: ['execute'] }, taskId, project: 'proj-1' };
    },
    auditOps: async () => {},
    opsCount: async () => 0,
  };

  test('notebook_list parses the stderr marker and returns rows; spawn got the real CLI args', async () => {
    const child = new FakeChild();
    const seen: { bin?: string; args?: string[]; opts?: unknown } = {};
    const s = new BrowserStudio({
      core: core as never,
      evidenceRoot: mkdtempSync(join(tmpdir(), 'sck-runner-')),
      spawn: spawnOf(child, seen),
    });
    const p = s.call('holder', 'task-1', 'notebook_list', {}) as Promise<{ notebooks: Array<{ title: string }> }>;
    for (let i = 0; i < 100 && !seen.args; i++) await sleep(5);
    expect(seen.args?.[0]).toBe('nodejs');
    expect(seen.args?.[1]).toBe('-e');
    expect(seen.args?.[2]).toContain('"notebookOp":"list"');
    child.stderr.emit('data', '[error] page noise\n__RESULT__{"ok":true,"notebooks":[{"id":"n1","title":"梦痕纪元"}]}\n');
    child.emit('close', 0, null);
    const value = await p;
    expect(value.notebooks[0].title).toBe('梦痕纪元');
  });

  test('notebook_list surfaces a structured business error, not 脚本无结果输出', async () => {
    const child = new FakeChild();
    const seen: { args?: string[] } = {};
    const s = new BrowserStudio({
      core: core as never,
      evidenceRoot: mkdtempSync(join(tmpdir(), 'sck-runner-')),
      spawn: spawnOf(child, seen),
    });
    const p = s.call('holder', 'task-1', 'notebook_list', {});
    for (let i = 0; i < 100 && !seen.args; i++) await sleep(5);
    child.stderr.emit('data', '__RESULT__{"ok":false,"code":"login_required","message":"notebook.google.com 需要重新登录"}\n');
    child.emit('close', 0, null);
    const error = await p.catch(e => e) as CompanyError;
    expect(error.code).toBe('not_configured'); // login_required maps like the media lane
    expect(error.message).toContain('需要重新登录');
  });
});
