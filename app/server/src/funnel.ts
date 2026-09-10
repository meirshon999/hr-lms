import { all, one } from './db.ts';
import { daysBetweenStamps } from './clock.ts';
import { regularBlocks, snapshotOf, type Snapshot } from './snapshot.ts';

/**
 * ВОРОНКА ПО ДОЛЖНОСТЯМ.
 *
 * Воронка отвечает на один вопрос: **где мы теряем людей.** Прежняя этого
 * не показывала вовсе — в неё попадали только те, кто учится или уже закончил,
 * а уволенные и не прошедшие выпадали. Воронка без потерь не воронка.
 *
 * Три числа на каждой ступени вместо одного:
 *   дошли  — сколько добрались до неё за всё время;
 *   сейчас — сколько стоят на ней прямо сегодня;
 *   ушли   — сколько на ней и закончились (архив).
 *
 * Отдельно — «применимо». Каркас общий на сеть, но урок может стоять не на всех
 * точках, и тогда блока у человека в снимке просто нет. Раньше такой человек
 * попадал в «не прошёл», и чем сильнее точки различались, тем сильнее воронка
 * занижала цифры. Теперь блок считается только по тем, у кого он есть.
 */

export interface FunnelStep {
  key: string;
  title: string;
  /** Скольких человек эта ступень вообще касается. */
  applicable: number;
  reached: number;
  now: number;
  lost: number;
  /** Средний срок от открытия онбординга до прохождения ступени, в днях. */
  avg_days: number | null;
}

export interface PositionFunnel {
  position_id: string;
  position: string;
  cohort: number;
  steps: FunnelStep[];
}

interface LiveBlock { id: string; title: string; }

/** Блоки живой траектории: каркас общий на сеть, поэтому названия и порядок одни. */
function liveBlocks(positionId: string): LiveBlock[] {
  const traj = one<{ id: string }>('SELECT id FROM trajectories WHERE position_id = ?', positionId);
  if (!traj) return [];
  return all<LiveBlock>(
    `SELECT id, title FROM blocks WHERE trajectory_id = ? AND kind = 'regular' ORDER BY ord`,
    traj.id,
  );
}

/** Блок из снимка сотрудника — или null, если у его точки такого блока нет. */
function mineBlock(snap: Snapshot | null, blockId: string) {
  if (!snap) return null;
  const b = regularBlocks(snap).find((x) => x.block_id === blockId);
  return b && b.lessons.length > 0 ? b : null;
}

/**
 * Прогресс сотрудника — одним запросом.
 *
 * Спрашивать базу про каждый урок отдельно значило бы при восьмистах людях
 * тысячи запросов на один экран. Здесь запрос на человека, дальше поиск в памяти.
 */
function progressOf(employeeId: string): Map<string, string | null> {
  const rows = all<{ lesson_id: string; status: string; passed_at: string | null }>(
    'SELECT lesson_id, status, passed_at FROM lesson_progress WHERE employee_id = ?',
    employeeId,
  );
  const m = new Map<string, string | null>();
  for (const r of rows) if (r.status === 'passed') m.set(r.lesson_id, r.passed_at);
  return m;
}

interface Walked {
  /** Индекс дальней достигнутой ступени: 0 — принят, 1 — начал, дальше блоки. */
  step: number;
  /** Когда ступень была пройдена, по индексу — для среднего срока. */
  doneAt: Array<string | null>;
}

/**
 * Насколько далеко человек прошёл. Блок, которого нет у его точки, ступень
 * не задерживает: он к этому человеку не относится и остановить его не может.
 */
function walk(e: any, snap: Snapshot | null, blocks: LiveBlock[]): Walked {
  const doneAt: Array<string | null> = [e.created_at ?? null];
  if (!e.onboarding_opened_at) return { step: 0, doneAt };

  doneAt.push(e.onboarding_opened_at);
  const passed = progressOf(e.id);
  let step = 1;

  for (const b of blocks) {
    const mine = mineBlock(snap, b.id);
    if (!mine) { step++; doneAt.push(null); continue; }

    let last: string | null = null;
    for (const l of mine.lessons) {
      if (!passed.has(l.lesson_id)) return { step, doneAt };
      const at = passed.get(l.lesson_id);
      if (at && (!last || at > last)) last = at;
    }
    step++;
    doneAt.push(last);
  }

  if (e.stage === 'completed' || e.completed_at) {
    step++;
    doneAt.push(e.completed_at ?? null);
  }
  return { step, doneAt };
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
}

export function funnelByPosition(locationId?: string): PositionFunnel[] {
  const positions = all<{ id: string; name: string }>('SELECT id, name FROM positions ORDER BY name');

  return positions.map((pos) => {
    // В когорту входят ВСЕ, кого когда-либо заводили на должность, включая
    // архив: без ушедших воронка показывала бы одних победителей.
    const cohort = locationId
      ? all<any>('SELECT * FROM employees WHERE position_id = ? AND location_id = ?', pos.id, locationId)
      : all<any>('SELECT * FROM employees WHERE position_id = ?', pos.id);
    if (cohort.length === 0) return null;

    const blocks = liveBlocks(pos.id);
    const titles = ['Принят', 'Начал обучение', ...blocks.map((b) => b.title), 'Аттестация пройдена'];
    const keys = ['hired', 'started', ...blocks.map((b) => `block:${b.id}`), 'attested'];

    // Снимок разбирается из JSON, поэтому берём его по одному разу на человека,
    // а не на каждой ступени заново.
    const walked = cohort.map((e) => {
      const snap = snapshotOf(e.id);
      return { e, snap, w: walk(e, snap, blocks) };
    });

    const steps: FunnelStep[] = titles.map((title, i) => {
      // Ступень блока считается ТОЛЬКО по тем, у кого этот блок есть.
      // Иначе выходит бессмыслица вроде «дошли 2 из 2», где один из двух
      // этого блока и в глаза не видел: у его точки такого урока нет.
      const blockIdx = i - 2;
      const isBlock = blockIdx >= 0 && blockIdx < blocks.length;
      const pool = isBlock
        ? walked.filter(({ snap }) => !!mineBlock(snap, blocks[blockIdx].id))
        : walked;

      // Срок — только у тех, кто ступень действительно прошёл, а не стоит на ней.
      const days: number[] = [];
      if (i >= 1) {
        for (const { e, w } of pool) {
          const at = w.doneAt[i];
          if (w.step > i && at && e.onboarding_opened_at) {
            days.push(daysBetweenStamps(e.onboarding_opened_at, at));
          }
        }
      }

      return {
        key: keys[i],
        title,
        applicable: pool.length,
        reached: pool.filter(({ w }) => w.step >= i).length,
        now: pool.filter(({ e, w }) => w.step === i && e.stage !== 'archived').length,
        lost: pool.filter(({ e, w }) => w.step === i && e.stage === 'archived').length,
        avg_days: i === 0 ? null : avg(days),
      };
    });

    return { position_id: pos.id, position: pos.name, cohort: cohort.length, steps };
  }).filter((x): x is PositionFunnel => x !== null);
}
