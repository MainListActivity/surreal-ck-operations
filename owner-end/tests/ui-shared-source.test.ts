import { expect, test } from 'bun:test';
import { setLiveTransportForTest } from '../src/ui/realtime.ts';
import type { LiveHandlers } from '../src/ui/source.ts';
import { sharedSource } from '../src/ui/store.ts';

let handlers: LiveHandlers | undefined;
let opened = 0;
setLiveTransportForTest((h) => {
  opened++;
  handlers = h;
  h.state('live');
  return () => { handlers = undefined; };
});

test('三个组件共用一份数据：首次只读一次，每次相关表变化只再读一次；无关表不读；全部离开后撤掉监听', async () => {
  let reads = 0;
  const source = sharedSource(async () => ({ kind: 'ok' as const, result: ++reads }), '失败', ['task']);
  const seen: number[] = [];
  const offs = [1, 2, 3].map(() => source.attach(() => seen.push(reads)));
  await Bun.sleep(0);
  expect(reads).toBe(1);
  expect(opened).toBe(1);
  handlers!.change(['task']);
  await Bun.sleep(0);
  expect(reads).toBe(2);
  handlers!.change(['lane_note']);
  await Bun.sleep(0);
  expect(reads).toBe(2);
  expect(seen.length).toBe(6); // 两次读取 × 三个使用者
  for (const off of offs) off();
  expect(handlers).toBeUndefined();
});

test('读取进行中再来变化：合并为读完后补读一次', async () => {
  let reads = 0;
  let release: () => void = () => {};
  const source = sharedSource(() => new Promise<{ kind: 'ok'; result: number }>((resolve) => {
    reads++;
    release = () => resolve({ kind: 'ok', result: reads });
  }), '失败', ['task']);
  const off = source.attach(() => {});
  handlers!.change(['task']);
  handlers!.change(['task']);
  expect(reads).toBe(1);
  release();
  await Bun.sleep(0);
  expect(reads).toBe(2);
  release();
  await Bun.sleep(0);
  expect(reads).toBe(2);
  off();
});
