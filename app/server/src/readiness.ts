import { all, one, SHARED } from './db.ts';
import { lessonsAt } from './snapshot.ts';

/**
 * ГОТОВНОСТЬ ТРАЕКТОРИИ.
 *
 * Проверка разделена на два уровня, и это не формальность:
 *
 *   Каркас  — общий на сеть: блоки, уроки, аттестация. Сломан каркас — траектория
 *             не публикуется вообще, потому что сломана она у всех сразу.
 *   Точка   — содержимое: у каждого урока, который на этой точке есть, должен
 *             быть материал и тест. Пустой урок на одной точке не должен мешать
 *             остальным трём работать.
 *
 * Отсюда правило: траектория публикуется по каркасу, а онбординг открывается
 * только на тех точках, которые своё заполнили.
 */

export function questionProblems(testId: string, label: string): string[] {
  const qs = all<any>('SELECT * FROM questions WHERE test_id = ?', testId);
  if (qs.length === 0) return [`${label} — в тесте нет вопросов`];
  const out: string[] = [];
  for (const q of qs) {
    const opts = JSON.parse(q.options);
    if (!Array.isArray(opts) || opts.length < 2) out.push(`${label} — у вопроса меньше 2 вариантов`);
    else if (q.correct_index < 0 || q.correct_index >= opts.length)
      out.push(`${label} — не отмечен верный вариант`);
  }
  return out;
}

/** Каркас: то, что обязано быть в траектории независимо от точек. */
export function structureProblems(trajectoryId: string): string[] {
  const problems: string[] = [];
  const blocks = all<any>('SELECT * FROM blocks WHERE trajectory_id = ? ORDER BY ord', trajectoryId);
  const regular = blocks.filter((b) => b.kind === 'regular');
  const attest = blocks.filter((b) => b.kind === 'attestation');

  const withLesson = regular.filter((b) => one('SELECT 1 FROM lessons WHERE block_id = ? LIMIT 1', b.id));
  if (withLesson.length === 0) problems.push('Нет ни одного блока с уроком');

  // Урок «только на выбранных точках», у которого точки не выбраны, не попадёт
  // ни в один снимок — это молча пропавший урок, а не настройка.
  for (const b of regular) {
    for (const l of all<any>('SELECT * FROM lessons WHERE block_id = ? ORDER BY ord', b.id)) {
      if (l.everywhere) continue;
      if (!one('SELECT 1 FROM lesson_locations WHERE lesson_id = ? LIMIT 1', l.id))
        problems.push(`Урок «${l.title}» — не выбрано ни одной точки`);
    }
  }

  if (attest.length === 0) problems.push('Нет блока аттестации');
  else if (attest.length > 1) problems.push('Блоков аттестации больше одного');

  return problems;
}

/** Вариант точки, иначе общий — то же правило, что и при сборке снимка. */
const pick = (table: 'materials' | 'tests', column: string, ownerId: string, locationId: string) =>
  one<any>(
    `SELECT * FROM ${table} WHERE ${column} = ? AND location_id IN (?, ?)
      ORDER BY CASE location_id WHEN ? THEN 1 ELSE 0 END LIMIT 1`,
    ownerId, locationId, SHARED, SHARED,
  );

/** Содержимое: чего не хватает именно этой точке. */
export function locationProblems(trajectoryId: string, locationId: string): string[] {
  const problems: string[] = [];
  const blocks = all<any>('SELECT * FROM blocks WHERE trajectory_id = ? ORDER BY ord', trajectoryId);

  for (const b of blocks.filter((x) => x.kind === 'regular')) {
    for (const l of lessonsAt(b.id, locationId)) {
      const m = pick('materials', 'lesson_id', l.id, locationId);
      if (!m || (!m.text_body && !m.file_url)) problems.push(`Урок «${l.title}» — нет материала`);
      const t = pick('tests', 'lesson_id', l.id, locationId);
      if (!t) problems.push(`Урок «${l.title}» — нет теста`);
      else problems.push(...questionProblems(t.id, `Урок «${l.title}»`));
    }
  }

  const attest = blocks.find((x) => x.kind === 'attestation');
  if (attest) {
    const t = pick('tests', 'block_id', attest.id, locationId);
    if (!t) problems.push('У аттестации нет теста');
    else problems.push(...questionProblems(t.id, 'Аттестация'));
  }

  return problems;
}

export interface LocationReadiness {
  location_id: string; name: string; ready: boolean; problems: string[];
}

/** Готовность траектории по всем действующим точкам — для конструктора. */
export function readinessByLocation(trajectoryId: string): LocationReadiness[] {
  return all<any>('SELECT * FROM locations WHERE is_active = 1 ORDER BY ord, name').map((loc) => {
    const problems = locationProblems(trajectoryId, loc.id);
    return { location_id: loc.id, name: loc.name, ready: problems.length === 0, problems };
  });
}
