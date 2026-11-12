import { expect, test } from 'bun:test';
import { inWorkHours, parseWorkHours, workHoursText } from '../src/work-hours.ts';

// 本地时间构造：2026-11-09 是周一。
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, 9 + ((day + 6) % 7), hour, minute);

test('没有设置即全天；工作日白天按 [开始, 结束) 判定', () => {
  expect(inWorkHours(undefined, at(0, 3))).toBe(true);
  const weekdays = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
  expect(inWorkHours(weekdays, at(1, 9))).toBe(true);
  expect(inWorkHours(weekdays, at(1, 17, 59))).toBe(true);
  expect(inWorkHours(weekdays, at(1, 18))).toBe(false);
  expect(inWorkHours(weekdays, at(1, 8, 59))).toBe(false);
  expect(inWorkHours(weekdays, at(6, 10))).toBe(false);
});

test('跨午夜：开始那天算工作日，次日凌晨属于前一天的班', () => {
  const night = { days: [5], start: '22:00', end: '06:00' };
  expect(inWorkHours(night, at(5, 23))).toBe(true);
  expect(inWorkHours(night, at(6, 5))).toBe(true);
  expect(inWorkHours(night, at(6, 6))).toBe(false);
  expect(inWorkHours(night, at(5, 5))).toBe(false);
  expect(workHoursText(night)).toBe('周五 22:00–次日 06:00');
});

test('校验：时间格式、开始不等于结束、至少一天；天去重排序', () => {
  expect(parseWorkHours({ days: [5, 1, 1], start: '09:00', end: '18:00' })).toEqual({ days: [1, 5], start: '09:00', end: '18:00' });
  expect(parseWorkHours({ days: [], start: '09:00', end: '18:00' })).toBeUndefined();
  expect(parseWorkHours({ days: [1], start: '9:00', end: '18:00' })).toBeUndefined();
  expect(parseWorkHours({ days: [1], start: '09:00', end: '09:00' })).toBeUndefined();
  expect(parseWorkHours({ days: [7], start: '09:00', end: '18:00' })).toBeUndefined();
  expect(workHoursText({ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:30' })).toBe('每天 00:00–23:30');
  expect(workHoursText({ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' })).toBe('周一至周五 09:00–18:00');
  expect(workHoursText({ days: [1, 3], start: '09:00', end: '18:00' })).toBe('周一、周三 09:00–18:00');
});
