import { getState, setState } from './db.ts';
import { TZ } from './config.ts';

/**
 * Демо-часы. «Сегодня» можно переопределить служебной панелью, чтобы показать
 * открытие онбординга и просрочку без ожидания реальных дней.
 * В реальной версии этого модуля нет — везде обычная системная дата.
 */

/** Дата в часовом поясе компании (не UTC) — иначе вечером даты съезжают на день. */
const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

export function today(): string {
  const o = getState('now_override');
  return o && /^\d{4}-\d{2}-\d{2}$/.test(o) ? o : fmt(new Date());
}

export function isOverridden(): boolean {
  const o = getState('now_override');
  return !!o && /^\d{4}-\d{2}-\d{2}$/.test(o);
}

/** Отметка времени для аудита: дата демо-часов + реальное время суток. */
export function stamp(): string {
  return `${today()}T${new Date().toISOString().slice(11)}`;
}

export function setToday(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
  setState('now_override', date);
}

export function advanceDays(days: number) {
  setToday(addDays(today(), days));
}

/** Убрать переопределение — вернуться к реальной системной дате. */
export function clearOverride() {
  setState('now_override', '');
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** date1 > date2 ? (обе в формате YYYY-MM-DD) */
export const isAfter = (date1: string, date2: string) => date1 > date2;

/** Сколько календарных дней прошло от `from` до `to` (обе даты YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
}
