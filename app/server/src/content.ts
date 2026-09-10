import { one, SHARED } from './db.ts';

/**
 * Куда класть материал или тест урока: в общий вариант или в вариант точки.
 *
 * Смешивать нельзя. Иначе у урока «своё на каждой точке» тихо появится общий
 * материал, и он будет подставляться там, где точка ещё ничего не завела —
 * то есть человек получит чужой план зала и будет уверен, что это его.
 *
 * Правило одно и то же для ручной правки в конструкторе и для сборки урока
 * через ИИ, поэтому живёт отдельно от маршрутов.
 */
export type Slot = { location: string } | { error: string };

export function contentSlot(lessonId: string, wanted: string | undefined): Slot {
  const l = one<any>('SELECT * FROM lessons WHERE id = ?', lessonId);
  if (!l) return { error: 'Урок не найден' };

  const location = wanted ?? SHARED;
  if (l.content_per_location && location === SHARED)
    return { error: 'У этого урока содержимое своё на каждой точке — выберите точку' };
  if (!l.content_per_location && location !== SHARED)
    return { error: 'У этого урока содержимое общее на всю сеть — точку выбирать не нужно' };
  if (location !== SHARED && !one('SELECT 1 FROM locations WHERE id = ?', location))
    return { error: 'Точка не найдена' };

  return { location };
}
