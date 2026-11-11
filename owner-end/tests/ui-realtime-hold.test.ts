import { expect, test } from 'bun:test';
import { holdLive, setLiveTransportForTest, subscribeLive } from '../src/ui/realtime.ts';
import type { LiveHandlers } from '../src/ui/source.ts';

let opened = 0;
let closed = 0;
let handlers: LiveHandlers | undefined;
setLiveTransportForTest((h) => {
  opened++;
  handlers = h;
  h.state('live');
  return () => { closed++; };
});

test('登录期间切换页面（旧页监听清零、新页再订阅）不关闭也不重建实时连接；释放后才关闭', () => {
  const release = holdLive();
  expect(opened).toBe(1);
  const seen: string[][] = [];
  const offTasks = subscribeLive((t) => seen.push(t));
  offTasks(); // 离开执行任务页：页面监听清零
  const offNotes = subscribeLive((t) => seen.push(['notes', ...t]));
  expect({ opened, closed }).toEqual({ opened: 1, closed: 0 });
  handlers!.change(['lane_note']);
  expect(seen).toEqual([['notes', 'lane_note']]);
  offNotes();
  expect(closed).toBe(0);
  release();
  release(); // 重复释放无副作用
  expect({ opened, closed }).toEqual({ opened: 1, closed: 1 });
});

test('没有持有时仍按旧行为：最后一个监听离开即关闭', () => {
  const before = { opened, closed };
  const off = subscribeLive(() => undefined);
  expect(opened).toBe(before.opened + 1);
  off();
  expect(closed).toBe(before.closed + 1);
});
