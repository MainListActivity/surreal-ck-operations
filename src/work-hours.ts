/**
 * 员工定义的工作时间：哪几天、几点到几点可以派工。按执行端（老板的 Mac）本地时间判定。
 * 没有设置即全天可派。结束早于开始表示跨午夜（如 22:00–06:00，开始那天算作工作日）。
 * 工作时间外不再派新活（不新开会话、不唤醒空闲会话）；正在跑的一轮照常跑完。
 * 纯函数，执行端与老板端页面共用。
 */

export interface WorkHours {
  /** 星期几可以派工：0 = 周日 … 6 = 周六。 */
  days: number[];
  /** 开始与结束，24 小时制 HH:MM。 */
  start: string;
  end: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (time: string): number => {
  const m = TIME.exec(time)!;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** 校验并规范化；不合法返回 undefined。天去重排序，至少一天；开始与结束不能相同。 */
export function parseWorkHours(value: unknown): WorkHours | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.start !== 'string' || typeof raw.end !== 'string' || !TIME.test(raw.start) || !TIME.test(raw.end)) return undefined;
  if (raw.start === raw.end) return undefined;
  if (!Array.isArray(raw.days) || raw.days.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)) return undefined;
  const days = [...new Set(raw.days as number[])].sort((a, b) => a - b);
  if (!days.length) return undefined;
  return { days, start: raw.start, end: raw.end };
}

/** 该时刻是否在工作时间内。没有设置即始终在。`at` 用本地时区解读。 */
export function inWorkHours(hours: WorkHours | undefined, at: Date): boolean {
  if (!hours) return true;
  const start = minutesOf(hours.start), end = minutesOf(hours.end);
  const minute = at.getHours() * 60 + at.getMinutes();
  const day = at.getDay();
  if (start < end) return hours.days.includes(day) && minute >= start && minute < end;
  // 跨午夜：开始那天的 start 之后，或前一天开始、今天 end 之前。
  if (minute >= start) return hours.days.includes(day);
  return minute < end && hours.days.includes((day + 6) % 7);
}

const DAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 一句话说明，如「周一至周五 09:00–18:00」「每天 22:00–次日 06:00」。没有设置为「全天」。 */
export function workHoursText(hours: WorkHours | undefined): string {
  if (!hours) return '全天';
  const { days } = hours;
  const consecutive = days.every((day, i) => i === 0 || day === days[i - 1]! + 1);
  const dayText = days.length === 7 ? '每天'
    : days.length === 5 && days.join() === '1,2,3,4,5' ? '周一至周五'
    : consecutive && days.length > 2 ? `${DAY_ZH[days[0]!]}至${DAY_ZH[days[days.length - 1]!]}`
    : days.map((day) => DAY_ZH[day]).join('、');
  const overnight = minutesOf(hours.end) < minutesOf(hours.start);
  return `${dayText} ${hours.start}–${overnight ? '次日 ' : ''}${hours.end}`;
}
