import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, SHARED, uuid } from '../db.ts';
import { authRequired, err } from '../auth.ts';
import { trajectoryOfPosition, tryOpenOnboarding } from '../domain.ts';
import { readinessByLocation, structureProblems } from '../readiness.ts';
import { contentSlot } from '../content.ts';
import { audit } from '../audit.ts';
import { emit } from '../events.ts';
import { positionDto, trajectoryTree } from '../serializers.ts';

const actor = (req: any) => req?.user?.login ?? 'system';

// Пересчёт у идущих сотрудников НЕ нужен: у каждого свой снимок траектории,
// снятый при открытии онбординга. Правки каталога достаются только новым назначениям.

function nextOrd(table: string, col: string, parentCol: string, parentId: string): number {
  const r = one<{ n: number }>(
    `SELECT COALESCE(MAX(ord), 0) n FROM ${table} WHERE ${parentCol} = ?`, parentId,
  );
  return (r?.n ?? 0) + 1;
}

/**
 * Проверка перед публикацией смотрит только на КАРКАС. Содержимое проверяется
 * отдельно по каждой точке (readiness.ts): пустой урок на одной точке не должен
 * мешать остальным работать.
 */

/**
 * Активная траектория не может быть неполной (SPEC C-2).
 * Правка, ломающая полноту, автоматически снимает траекторию с публикации:
 * иначе следующий нанятый получит снимок без уроков и застрянет навсегда.
 * Тех, кто уже учится, это не трогает — у них свой снимок (R-8).
 */
function revalidateActiveTrajectories(actorLogin: string) {
  for (const t of all<{ id: string; position_id: string }>(
    `SELECT id, position_id FROM trajectories WHERE status = 'active'`)) {
    const problems = structureProblems(t.id);
    if (!problems.length) continue;
    run(`UPDATE trajectories SET status = 'draft' WHERE id = ?`, t.id);
    const pos = one<{ name: string }>('SELECT name FROM positions WHERE id = ?', t.position_id);
    audit(actorLogin, 'unpublish', null, `«${pos?.name}» снята автоматически: ${problems[0]}`);
    emit('траектория снята с публикации', `«${pos?.name}» — ${problems[0]}`);
  }
}

/**
 * Догон ожидающих стажёров.
 *
 * Стажёр с двумя пройденными гейтами ждёт, пока его точка заполнит свои уроки.
 * Пока каркас цел, траектория остаётся активной — значит, «Опубликовать» никто
 * не нажмёт и подобрать ожидающих будет некому. Поэтому пробуем открыть им
 * онбординг после каждой правки каталога: как только точка закрыла пробел,
 * человек уходит учиться сам, без действий HR.
 */
function catchUpWaitingInterns() {
  for (const w of all<{ id: string }>(
    `SELECT id FROM employees
      WHERE stage = 'intern' AND pre_onboarding_done = 1 AND internship_passed = 1`)) {
    tryOpenOnboarding(w.id);
  }
}

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('hr', 'admin'));

  // после любой успешной правки каталога проверяем, не сломалась ли активная траектория
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 300) return;
    try {
      revalidateActiveTrajectories(actor(req));
      catchUpWaitingInterns();
    } catch (e) { app.log.error(e); }
  });

  // ---------- должности ----------
  app.get('/positions', async () =>
    ({ items: all<any>('SELECT * FROM positions ORDER BY name').map(positionDto) }));

  app.post('/positions', async (req, reply) => {
    const p = z.object({ name: z.string().min(1).max(80) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Название обязательно'));
    const id = uuid();
    run('INSERT INTO positions (id, name) VALUES (?, ?)', id, p.data.name);
    const trajId = uuid();
    run('INSERT INTO trajectories (id, position_id, status) VALUES (?, ?, ?)', trajId, id, 'draft');
    // пустой блок аттестации по умолчанию
    run('INSERT INTO blocks (id, trajectory_id, ord, title, kind) VALUES (?,?,?,?,?)',
      uuid(), trajId, 999, 'Аттестация', 'attestation');
    return reply.code(201).send(positionDto(one('SELECT * FROM positions WHERE id = ?', id)));
  });

  app.patch('/positions/:id', async (req, reply) => {
    const p = z.object({ name: z.string().min(1).max(80) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Название обязательно'));
    run('UPDATE positions SET name = ? WHERE id = ?', p.data.name, (req.params as any).id);
    return { ok: true };
  });

  app.delete('/positions/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (one('SELECT 1 FROM employees WHERE position_id = ? LIMIT 1', id))
      return reply.code(409).send(err('has_employees', 'Есть сотрудники на этой должности'));
    run('DELETE FROM positions WHERE id = ?', id);
    return { ok: true };
  });

  // ---------- дерево траектории ----------
  app.get('/trajectories/:positionId', async (req, reply) => {
    const traj = trajectoryOfPosition((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));
    const at = (req.query as any)?.location as string | undefined;
    return {
      ...trajectoryTree(traj.id, { withAnswers: true, locationId: at }),
      viewing_location: at ?? null,
      problems: structureProblems(traj.id),
      locations: readinessByLocation(traj.id),
    };
  });

  app.post('/trajectories/:positionId/publish', async (req, reply) => {
    const traj = trajectoryOfPosition((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));
    const problems = structureProblems(traj.id);
    if (problems.length)
      return reply.code(422).send(err('trajectory_incomplete', 'Нельзя опубликовать', problems));
    run('UPDATE trajectories SET status = ? WHERE id = ?', 'active', traj.id);
    const pos = one<{ name: string }>('SELECT name FROM positions WHERE id = ?', (req.params as any).positionId);

    // Стажёры, прошедшие оба гейта, ждали именно публикации — открываем им онбординг.
    // Без этого они зависают: гейты выполнены, а открыть их уже нечему.
    const waiting = all<{ id: string }>(
      `SELECT id FROM employees
        WHERE position_id = ? AND stage = 'intern'
          AND pre_onboarding_done = 1 AND internship_passed = 1`,
      (req.params as any).positionId,
    );
    const opened = waiting.filter((w) => tryOpenOnboarding(w.id).opened).length;

    audit(actor(req), 'publish', null,
      `Траектория «${pos?.name}»` + (opened ? `; онбординг открыт: ${opened}` : ''));
    return { ok: true, status: 'active', onboarding_opened: opened };
  });

  app.post('/trajectories/:positionId/unpublish', async (req) => {
    const traj = trajectoryOfPosition((req.params as any).positionId)!;
    run('UPDATE trajectories SET status = ? WHERE id = ?', 'draft', traj.id);
    const pos = one<{ name: string }>('SELECT name FROM positions WHERE id = ?', (req.params as any).positionId);
    audit(actor(req), 'unpublish', null, `Траектория «${pos?.name}»`);
    return { ok: true, status: 'draft' };
  });

  // ---------- пре-онбординг ----------
  const preSchema = z.object({
    title: z.string().min(1), content_type: z.enum(['video', 'pdf', 'text']),
    file_url: z.string().optional().nullable(), text_body: z.string().optional().nullable(),
  });

  app.post('/trajectories/:positionId/pre-onboarding', async (req, reply) => {
    const traj = trajectoryOfPosition((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));
    const p = preSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте поля'));
    const id = uuid();
    run(`INSERT INTO pre_onboarding_items (id, trajectory_id, ord, title, content_type, file_url, text_body)
         VALUES (?,?,?,?,?,?,?)`,
      id, traj.id, nextOrd('pre_onboarding_items', 'ord', 'trajectory_id', traj.id),
      p.data.title, p.data.content_type, p.data.file_url ?? null, p.data.text_body ?? null);
    return reply.code(201).send({ id });
  });

  app.patch('/pre-onboarding/:id', async (req, reply) => {
    const p = preSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте поля'));
    const cur = one<any>('SELECT * FROM pre_onboarding_items WHERE id = ?', (req.params as any).id);
    if (!cur) return reply.code(404).send(err('not_found', 'Не найдено'));
    const d = { ...cur, ...p.data };
    run(`UPDATE pre_onboarding_items SET title=?, content_type=?, file_url=?, text_body=? WHERE id=?`,
      d.title, d.content_type, d.file_url ?? null, d.text_body ?? null, cur.id);
    return { ok: true };
  });

  app.delete('/pre-onboarding/:id', async (req) => {
    run('DELETE FROM pre_onboarding_items WHERE id = ?', (req.params as any).id);
    return { ok: true };
  });

  // ---------- блоки ----------
  app.post('/trajectories/:positionId/blocks', async (req, reply) => {
    const traj = trajectoryOfPosition((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));
    const p = z.object({ title: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Название обязательно'));
    const id = uuid();
    // новый обычный блок ставим перед аттестацией
    const att = one<{ ord: number }>(
      `SELECT ord FROM blocks WHERE trajectory_id = ? AND kind = 'attestation'`, traj.id);
    const maxRegular = one<{ n: number }>(
      `SELECT COALESCE(MAX(ord),0) n FROM blocks WHERE trajectory_id = ? AND kind = 'regular'`, traj.id)!.n;
    run('INSERT INTO blocks (id, trajectory_id, ord, title, kind) VALUES (?,?,?,?,?)',
      id, traj.id, maxRegular + 1, p.data.title, 'regular');
    if (att && att.ord <= maxRegular + 1)
      run(`UPDATE blocks SET ord = ? WHERE trajectory_id = ? AND kind = 'attestation'`,
        maxRegular + 2, traj.id);
    return reply.code(201).send({ id });
  });

  app.patch('/blocks/:id', async (req, reply) => {
    const p = z.object({ title: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Название обязательно'));
    run('UPDATE blocks SET title = ? WHERE id = ? AND kind = ?', p.data.title, (req.params as any).id, 'regular');
    return { ok: true };
  });

  app.delete('/blocks/:id', async (req, reply) => {
    const b = one<any>('SELECT * FROM blocks WHERE id = ?', (req.params as any).id);
    if (!b) return reply.code(404).send(err('not_found', 'Не найдено'));
    if (b.kind === 'attestation') return reply.code(409).send(err('cannot_delete', 'Блок аттестации удалить нельзя'));
    run('DELETE FROM blocks WHERE id = ?', b.id);
    return { ok: true };
  });

  // ---------- уроки ----------
  //
  // Два независимых признака: ГДЕ урок есть и ЧЕЙ у него контент.
  //   everywhere = false        → только на точках из locations
  //   content_per_location      → материал и тест заводятся на каждой точке
  const lessonSchema = z.object({
    title: z.string().min(1),
    everywhere: z.boolean().optional(),
    content_per_location: z.boolean().optional(),
    locations: z.array(z.string()).optional(),
  });

  const currentLocations = (lessonId: string) =>
    all<{ location_id: string }>('SELECT location_id FROM lesson_locations WHERE lesson_id = ?', lessonId)
      .map((r) => r.location_id);

  function setLessonLocations(lessonId: string, ids: string[]) {
    run('DELETE FROM lesson_locations WHERE lesson_id = ?', lessonId);
    for (const locId of new Set(ids)) {
      if (!one('SELECT 1 FROM locations WHERE id = ?', locId)) continue;
      run('INSERT INTO lesson_locations (lesson_id, location_id) VALUES (?,?)', lessonId, locId);
    }
  }

  app.post('/blocks/:id/lessons', async (req, reply) => {
    const b = one<any>('SELECT * FROM blocks WHERE id = ?', (req.params as any).id);
    if (!b) return reply.code(404).send(err('not_found', 'Блок не найден'));
    if (b.kind !== 'regular') return reply.code(409).send(err('bad_block', 'В блок аттестации уроки не добавляются'));
    const p = lessonSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Название обязательно'));
    const id = uuid();
    run('INSERT INTO lessons (id, block_id, ord, title, everywhere, content_per_location) VALUES (?,?,?,?,?,?)',
      id, b.id, nextOrd('lessons', 'ord', 'block_id', b.id), p.data.title,
      p.data.everywhere === false ? 0 : 1, p.data.content_per_location ? 1 : 0);
    setLessonLocations(id, p.data.everywhere === false ? (p.data.locations ?? []) : []);
    return reply.code(201).send({ id });
  });

  app.patch('/lessons/:id', async (req, reply) => {
    const p = lessonSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте поля'));
    const id = (req.params as any).id;
    const cur = one<any>('SELECT * FROM lessons WHERE id = ?', id);
    if (!cur) return reply.code(404).send(err('not_found', 'Урок не найден'));

    const everywhere = p.data.everywhere ?? !!cur.everywhere;
    const perLocation = p.data.content_per_location ?? !!cur.content_per_location;
    run('UPDATE lessons SET title = ?, everywhere = ?, content_per_location = ? WHERE id = ?',
      p.data.title ?? cur.title, everywhere ? 1 : 0, perLocation ? 1 : 0, id);

    if (p.data.locations !== undefined || p.data.everywhere !== undefined)
      setLessonLocations(id, everywhere ? [] : (p.data.locations ?? currentLocations(id)));

    // Признак содержимого переключили — прежние варианты стали не тем, чем были:
    // общий материал не годится точкам, а точечные не годятся всей сети.
    if (p.data.content_per_location !== undefined && perLocation !== !!cur.content_per_location) {
      run('DELETE FROM materials WHERE lesson_id = ?', id);
      run('DELETE FROM tests WHERE lesson_id = ?', id);
    }
    return { ok: true };
  });

  app.delete('/lessons/:id', async (req) => {
    run('DELETE FROM lessons WHERE id = ?', (req.params as any).id);
    return { ok: true };
  });

  // ---------- материал урока ----------
  app.put('/lessons/:id/material', async (req, reply) => {
    const l = one('SELECT 1 FROM lessons WHERE id = ?', (req.params as any).id);
    if (!l) return reply.code(404).send(err('not_found', 'Урок не найден'));
    const p = z.object({
      content_type: z.enum(['video', 'pdf', 'text']),
      file_url: z.string().optional().nullable(),
      text_body: z.string().optional().nullable(),
      min_watch_pct: z.number().int().min(0).max(100).optional().nullable(),
      location_id: z.string().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте поля'));
    const id = (req.params as any).id;
    const slot = contentSlot(id, p.data.location_id);
    if ('error' in slot) return reply.code(422).send(err('bad_location', slot.error));

    const existing = one<{ id: string }>(
      'SELECT id FROM materials WHERE lesson_id = ? AND location_id = ?', id, slot.location);
    if (existing) {
      run('UPDATE materials SET content_type=?, file_url=?, text_body=?, min_watch_pct=? WHERE id=?',
        p.data.content_type, p.data.file_url ?? null, p.data.text_body ?? null,
        p.data.min_watch_pct ?? null, existing.id);
    } else {
      run(`INSERT INTO materials (id, lesson_id, location_id, content_type, file_url, text_body, min_watch_pct)
           VALUES (?,?,?,?,?,?,?)`,
        uuid(), id, slot.location, p.data.content_type, p.data.file_url ?? null,
        p.data.text_body ?? null, p.data.min_watch_pct ?? null);
    }
    return { ok: true };
  });

  // ---------- тесты ----------
  async function upsertTest(kind: 'lesson' | 'block', ownerId: string, passMark: number, location = SHARED) {
    const col = kind === 'lesson' ? 'lesson_id' : 'block_id';
    const existing = one<{ id: string }>(
      `SELECT id FROM tests WHERE ${col} = ? AND location_id = ?`, ownerId, location);
    if (existing) { run('UPDATE tests SET pass_mark_pct = ? WHERE id = ?', passMark, existing.id); return existing.id; }
    const id = uuid();
    run(`INSERT INTO tests (id, ${col}, location_id, pass_mark_pct) VALUES (?, ?, ?, ?)`,
      id, ownerId, location, passMark);
    return id;
  }
  const passSchema = z.object({
    pass_mark_pct: z.number().int().min(1).max(100),
    location_id: z.string().optional(),
  });

  app.put('/lessons/:id/test', async (req, reply) => {
    if (!one('SELECT 1 FROM lessons WHERE id = ?', (req.params as any).id))
      return reply.code(404).send(err('not_found', 'Урок не найден'));
    const p = passSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проходной балл 1–100'));
    const slot = contentSlot((req.params as any).id, p.data.location_id);
    if ('error' in slot) return reply.code(422).send(err('bad_location', slot.error));
    const id = await upsertTest('lesson', (req.params as any).id, p.data.pass_mark_pct, slot.location);
    return { test_id: id };
  });

  app.put('/blocks/:id/test', async (req, reply) => {
    const b = one<any>('SELECT * FROM blocks WHERE id = ?', (req.params as any).id);
    if (!b || b.kind !== 'attestation')
      return reply.code(400).send(err('bad_block', 'Тест ставится только на блок аттестации'));
    const p = passSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проходной балл 1–100'));
    const id = await upsertTest('block', b.id, p.data.pass_mark_pct);
    return { test_id: id };
  });

  const questionSchema = z.object({
    text: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).max(6),
    correct_index: z.number().int().min(0),
  }).refine((q) => q.correct_index < q.options.length, { message: 'correct_index вне диапазона' });

  app.post('/tests/:id/questions', async (req, reply) => {
    if (!one('SELECT 1 FROM tests WHERE id = ?', (req.params as any).id))
      return reply.code(404).send(err('not_found', 'Тест не найден'));
    const p = questionSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте вопрос и варианты'));
    const id = uuid();
    run('INSERT INTO questions (id, test_id, ord, text, options, correct_index) VALUES (?,?,?,?,?,?)',
      id, (req.params as any).id,
      nextOrd('questions', 'ord', 'test_id', (req.params as any).id),
      p.data.text, JSON.stringify(p.data.options), p.data.correct_index);
    return reply.code(201).send({ id });
  });

  app.patch('/questions/:id', async (req, reply) => {
    const p = questionSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте вопрос и варианты'));
    run('UPDATE questions SET text=?, options=?, correct_index=? WHERE id=?',
      p.data.text, JSON.stringify(p.data.options), p.data.correct_index, (req.params as any).id);
    return { ok: true };
  });

  app.delete('/questions/:id', async (req) => {
    run('DELETE FROM questions WHERE id = ?', (req.params as any).id);
    return { ok: true };
  });

  // ---------- порядок (reorder) ----------
  const orderSchema = z.object({ ids: z.array(z.string()).min(1) });

  function applyOrder(table: string, parentCol: string, parentId: string, ids: string[], startAt = 1) {
    const existing = new Set(
      all<{ id: string }>(`SELECT id FROM ${table} WHERE ${parentCol} = ?`, parentId).map((r) => r.id),
    );
    ids.forEach((id, i) => {
      if (existing.has(id)) run(`UPDATE ${table} SET ord = ? WHERE id = ?`, startAt + i, id);
    });
  }

  app.put('/trajectories/:positionId/pre-onboarding/order', async (req, reply) => {
    const traj = trajectoryOfPosition((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));
    const p = orderSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Нужен массив ids'));
    applyOrder('pre_onboarding_items', 'trajectory_id', traj.id, p.data.ids);
    return { ok: true };
  });

  app.put('/trajectories/:positionId/blocks/order', async (req, reply) => {
    const traj = trajectoryOfPosition((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));
    const p = orderSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Нужен массив ids'));
    // переупорядочиваем только regular-блоки; аттестация остаётся с ord = 999
    applyOrder('blocks', 'trajectory_id', traj.id, p.data.ids);
    run(`UPDATE blocks SET ord = 999 WHERE trajectory_id = ? AND kind = 'attestation'`, traj.id);
    return { ok: true };
  });

  app.put('/blocks/:id/lessons/order', async (req, reply) => {
    const b = one<any>('SELECT * FROM blocks WHERE id = ?', (req.params as any).id);
    if (!b) return reply.code(404).send(err('not_found', 'Блок не найден'));
    const p = orderSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Нужен массив ids'));
    applyOrder('lessons', 'block_id', b.id, p.data.ids);
    return { ok: true };
  });
}
