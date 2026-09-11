import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, SHARED, uuid } from '../db.ts';
import { authRequired, err } from '../auth.ts';
import { audit } from '../audit.ts';
import { stamp } from '../clock.ts';
import { contentSlot } from '../content.ts';
import { AiError, aiInfo, aiUnavailableReason, readPdf } from '../ai/provider.ts';
import { MAX_DOC_MB } from '../config.ts';
import { DocError, extractDocument, headingsOf } from '../docx.ts';
import { buildLessonDraft, DraftSchema } from '../ai/lesson.ts';
import { buildTrajectoryPlan, PlanSchema, sourceFor, type Section } from '../ai/plan.ts';
import {
  AttestationApplySchema, buildAttestationDraft, suggestedCount,
} from '../ai/attestation.ts';

const actor = (req: any) => req?.user?.login ?? 'system';

/**
 * ИИ-КОНСТРУКТОР.
 *
 * Два действия, и между ними обязательно стоит человек:
 *
 *   1. «Собрать»  — исходник уходит модели, черновик возвращается HR и лежит
 *                   в отдельной таблице. Каталога это не касается.
 *   2. «Применить» — HR посмотрел, поправил и подтвердил. Только теперь
 *                   материал и тест попадают в урок.
 *
 * Разделение не формальность: по бедному исходнику модель напишет уверенный
 * и неверный тест, а поймать это может лишь тот, кто знает, как устроена смена.
 */
export default async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('hr', 'admin'));

  /** Интерфейс спрашивает это, чтобы не показывать кнопки там, где их нечем обслужить. */
  app.get('/ai/status', async () => aiInfo());

  /**
   * Документ — в текст. Файл не сохраняем: он нужен ровно на время разбора,
   * а результат человек всё равно увидит в поле и сможет поправить до того,
   * как что-то уйдёт модели.
   */
  app.post('/ai/extract', async (req: any, reply) => {
    let part: any;
    try {
      part = await req.file();
    } catch {
      return reply.code(400).send(err('no_file', 'Файл не передан'));
    }
    if (!part) return reply.code(400).send(err('no_file', 'Файл не передан'));

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      size += chunk.length;
      if (size > MAX_DOC_MB * 1024 * 1024) {
        return reply.code(413).send(err('too_large', `Документ больше ${MAX_DOC_MB} МБ`));
      }
      chunks.push(chunk);
    }

    const name = (part.filename || '').toLowerCase();
    const body = Buffer.concat(chunks);

    // PDF читает сама модель: свой разбор не берёт ни сканы, ни сложную вёрстку,
    // а регламент, распечатанный и отсканированный, — обычное дело.
    if (name.endsWith('.pdf')) {
      try {
        const r = await readPdf(body, actor(req));
        if (!r.text) return reply.code(422).send(err('doc_empty', 'В документе не нашлось текста'));
        return { text: r.text, headings: headingsOf(r.text), kind: 'pdf', chars: r.text.length };
      } catch (e) {
        if (e instanceof AiError) {
          const status = e.code === 'doc_pdf' ? 422
            : e.code === 'ai_bad_key' ? 422
              : e.code === 'ai_rate_limited' ? 429 : 502;
          return reply.code(status).send(err(e.code, e.message));
        }
        app.log.error(e);
        return reply.code(502).send(err('doc_failed', 'Не удалось прочитать PDF'));
      }
    }

    try {
      const r = extractDocument(body, part.filename || '');
      if (!r.text) {
        return reply.code(422).send(err('doc_empty', 'В документе не нашлось текста'));
      }
      return { text: r.text, headings: r.headings, kind: r.kind, chars: r.text.length };
    } catch (e) {
      if (e instanceof DocError) return reply.code(422).send(err(e.code, e.message));
      app.log.error(e);
      return reply.code(500).send(err('doc_failed', 'Не удалось прочитать документ'));
    }
  });

  // ============================ ПЛАН ТРАЕКТОРИИ ============================
  //
  // Первый проход: документ → предложение структуры. В каталоге ничего
  // не появляется, пока человек не нажмёт «Создать» — то же правило C-13,
  // только про дерево целиком, а не про один урок.

  const trajectoryOf = (positionId: string) =>
    one<{ id: string; status: string }>(
      'SELECT id, status FROM trajectories WHERE position_id = ?', positionId);

  const planRow = (trajectoryId: string) =>
    one<any>('SELECT * FROM ai_plans WHERE trajectory_id = ?', trajectoryId);

  /** Наружу отдаём разделы без текста: он большой, а нужны заголовок и размер. */
  const outline = (sections: Section[]) =>
    sections.map((x) => ({ index: x.index, title: x.title, chars: x.chars }));

  app.post('/ai/trajectories/:positionId/plan', async (req, reply) => {
    const reason = aiUnavailableReason();
    if (reason) return reply.code(503).send(err('ai_disabled', reason));

    const traj = trajectoryOf((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));

    const p = z.object({ source_text: z.string() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Нужен текст документа'));

    const pos = one<{ name: string }>(
      'SELECT name FROM positions WHERE id = ?', (req.params as any).positionId);

    try {
      const r = await buildTrajectoryPlan(p.data.source_text, {
        positionName: pos?.name ?? 'сотрудник',
        actor: actor(req),
      });
      run(
        `INSERT INTO ai_plans (id, trajectory_id, source_text, sections_json, plan_json, provider, model, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(trajectory_id) DO UPDATE SET
           source_text = excluded.source_text, sections_json = excluded.sections_json,
           plan_json = excluded.plan_json, provider = excluded.provider,
           model = excluded.model, created_by = excluded.created_by, created_at = excluded.created_at`,
        uuid(), traj.id, p.data.source_text, JSON.stringify(r.sections),
        JSON.stringify(r.data), r.provider, r.model, actor(req), stamp(),
      );
      return { plan: r.data, sections: outline(r.sections), provider: r.provider, model: r.model };
    } catch (e) {
      if (e instanceof AiError) {
        const status = e.code === 'ai_rate_limited' ? 429
          : e.code === 'ai_disabled' ? 503
          : e.code.startsWith('source_') ? 422 : 502;
        return reply.code(status).send(err(e.code, e.message));
      }
      app.log.error(e);
      return reply.code(502).send(err('ai_failed', 'Не удалось разобрать документ — попробуйте ещё раз'));
    }
  });

  app.get('/ai/trajectories/:positionId/plan', async (req, reply) => {
    const traj = trajectoryOf((req.params as any).positionId);
    const row = traj && planRow(traj.id);
    if (!row) return reply.code(404).send(err('not_found', 'Плана нет'));
    return {
      plan: JSON.parse(row.plan_json),
      sections: outline(JSON.parse(row.sections_json)),
      provider: row.provider, model: row.model,
      created_by: row.created_by, created_at: row.created_at,
    };
  });

  app.delete('/ai/trajectories/:positionId/plan', async (req, reply) => {
    const traj = trajectoryOf((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));
    run('DELETE FROM ai_plans WHERE trajectory_id = ?', traj.id);
    return { ok: true };
  });

  /**
   * Второй шаг: план становится каркасом. Блоки и уроки создаются пустыми —
   * материал и тест собираются потом, по одному уроку, и каждый проходит
   * через глаза кадровика.
   *
   * Кусок документа сохраняется рядом с уроком: иначе кадровику пришлось бы
   * заново искать нужный абзац в сорокастраничном регламенте.
   */
  app.post('/ai/trajectories/:positionId/plan/apply', async (req, reply) => {
    const traj = trajectoryOf((req.params as any).positionId);
    if (!traj) return reply.code(404).send(err('not_found', 'Траектория не найдена'));

    const row = planRow(traj.id);
    if (!row) return reply.code(404).send(err('not_found', 'Сначала соберите план'));

    // Человек мог править дерево, поэтому применяем то, что он прислал.
    const p = z.object({ plan: PlanSchema }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'План не той формы'));

    const sections: Section[] = JSON.parse(row.sections_json);
    let blocks = 0;
    let lessons = 0;

    for (const b of p.data.plan.blocks) {
      const blockId = uuid();
      const maxRegular = one<{ n: number }>(
        `SELECT COALESCE(MAX(ord),0) n FROM blocks WHERE trajectory_id = ? AND kind = 'regular'`,
        traj.id)!.n;
      run('INSERT INTO blocks (id, trajectory_id, ord, title, kind) VALUES (?,?,?,?,?)',
        blockId, traj.id, maxRegular + 1, b.title, 'regular');
      // Аттестация всегда последняя: новые блоки встают перед ней.
      run(`UPDATE blocks SET ord = ? WHERE trajectory_id = ? AND kind = 'attestation'`,
        maxRegular + 2, traj.id);
      blocks++;

      b.lessons.forEach((l, i) => {
        const lessonId = uuid();
        run('INSERT INTO lessons (id, block_id, ord, title, everywhere, content_per_location) VALUES (?,?,?,?,1,0)',
          lessonId, blockId, i + 1, l.title);
        const src = sourceFor(sections, l.sections);
        if (src) {
          run('INSERT OR REPLACE INTO ai_lesson_sources (lesson_id, source_text) VALUES (?,?)',
            lessonId, src);
        }
        lessons++;
      });
    }

    run('DELETE FROM ai_plans WHERE trajectory_id = ?', traj.id);
    audit(actor(req), 'ai_plan_apply', null, blocks + ' блоков, ' + lessons + ' уроков');
    return { blocks, lessons };
  });

  /** Кусок документа, из которого вырос урок: подставляется в поле сборки. */
  app.get('/ai/lessons/:id/source', async (req, reply) => {
    const row = one<{ source_text: string }>(
      'SELECT source_text FROM ai_lesson_sources WHERE lesson_id = ?', (req.params as any).id);
    if (!row) return reply.code(404).send(err('not_found', 'Исходника нет'));
    return { source_text: row.source_text };
  });

  // ========================= ФИНАЛЬНАЯ АТТЕСТАЦИЯ =========================
  //
  // Собирается по материалам всех уроков траектории — но не по всем подряд.
  //
  // Аттестация одна на всю сеть, а содержимое точечного урока на каждой точке
  // своё. Вопрос по кухне точки А сотрудник точки Б увидит впервые в жизни
  // и справедливо провалит. Поэтому в основу идут только уроки, которые
  // одинаковы для всех: стоят везде и содержимое общее.

  const attestationBlock = (blockId: string) =>
    one<any>(`SELECT * FROM blocks WHERE id = ? AND kind = 'attestation'`, blockId);

  /** Общие уроки траектории с их материалами и уже заданными вопросами. */
  function sharedLessons(trajectoryId: string) {
    const lessons = all<any>(
      `SELECT l.id, l.title, m.text_body
         FROM lessons l
         JOIN blocks b ON b.id = l.block_id
         LEFT JOIN materials m ON m.lesson_id = l.id AND m.location_id = ?
        WHERE b.trajectory_id = ? AND b.kind = 'regular'
          AND l.everywhere = 1 AND l.content_per_location = 0
        ORDER BY b.ord, l.ord`,
      SHARED, trajectoryId,
    );
    const asked = lessons.flatMap((l) => all<{ text: string }>(
      `SELECT q.text FROM questions q
         JOIN tests t ON t.id = q.test_id
        WHERE t.lesson_id = ? AND t.location_id = ?`,
      l.id, SHARED,
    ).map((q) => q.text));
    return { lessons, asked };
  }

  /** Сколько уроков всего — чтобы честно сказать, что точечные не вошли. */
  const allLessonCount = (trajectoryId: string) => one<{ n: number }>(
    `SELECT COUNT(*) n FROM lessons l JOIN blocks b ON b.id = l.block_id
      WHERE b.trajectory_id = ? AND b.kind = 'regular'`, trajectoryId)!.n;

  app.post('/ai/blocks/:id/attestation', async (req, reply) => {
    const reason = aiUnavailableReason();
    if (reason) return reply.code(503).send(err('ai_disabled', reason));

    const block = attestationBlock((req.params as any).id);
    if (!block) return reply.code(404).send(err('not_found', 'Блок аттестации не найден'));

    const p = z.object({ count: z.number().int().min(5).max(20).optional() }).safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send(err('bad_request', 'Вопросов от 5 до 20'));

    const pos = one<{ name: string }>(
      `SELECT p.name FROM positions p
         JOIN trajectories t ON t.position_id = p.id
        WHERE t.id = ?`, block.trajectory_id);

    const { lessons, asked } = sharedLessons(block.trajectory_id);
    const total = allLessonCount(block.trajectory_id);

    try {
      const r = await buildAttestationDraft({
        positionName: pos?.name ?? 'сотрудник',
        lessons: lessons.map((l) => ({ title: l.title, material: l.text_body ?? '' })),
        askedInLessons: asked,
        count: p.data.count ?? suggestedCount(lessons.length),
        actor: actor(req),
      });

      run(
        `INSERT INTO ai_block_drafts (block_id, draft_json, provider, model, created_by, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(block_id) DO UPDATE SET
           draft_json = excluded.draft_json, provider = excluded.provider,
           model = excluded.model, created_by = excluded.created_by, created_at = excluded.created_at`,
        block.id, JSON.stringify(r.data), r.provider, r.model, actor(req), stamp(),
      );

      // Три числа вместо одного «пропущено»: кадровику важно различать
      // «урок ещё не заполнен» (это чинится) и «урок точечный» (так задумано).
      return {
        draft: r.data,
        provider: r.provider,
        model: r.model,
        based_on: r.basedOn,
        empty: lessons.length - r.basedOn,
        per_location: total - lessons.length,
        avoided: asked.length,
      };
    } catch (e) {
      if (e instanceof AiError) {
        const status = e.code === 'ai_rate_limited' ? 429
          : e.code === 'ai_disabled' ? 503
          : e.code.startsWith('source_') ? 422 : 502;
        return reply.code(status).send(err(e.code, e.message));
      }
      app.log.error(e);
      return reply.code(502).send(err('ai_failed', 'Не удалось собрать аттестацию — попробуйте ещё раз'));
    }
  });

  app.get('/ai/blocks/:id/attestation', async (req, reply) => {
    const row = one<any>('SELECT * FROM ai_block_drafts WHERE block_id = ?', (req.params as any).id);
    if (!row) return reply.code(404).send(err('not_found', 'Черновика нет'));
    return {
      draft: JSON.parse(row.draft_json),
      provider: row.provider, model: row.model,
      created_by: row.created_by, created_at: row.created_at,
    };
  });

  app.delete('/ai/blocks/:id/attestation', async (req) => {
    run('DELETE FROM ai_block_drafts WHERE block_id = ?', (req.params as any).id);
    return { ok: true };
  });

  /** Единственное место, где собранная аттестация попадает в каталог (C-13). */
  app.post('/ai/blocks/:id/attestation/apply', async (req, reply) => {
    const block = attestationBlock((req.params as any).id);
    if (!block) return reply.code(404).send(err('not_found', 'Блок аттестации не найден'));

    const p = z.object({
      draft: AttestationApplySchema,
      pass_mark_pct: z.number().int().min(1).max(100).optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Черновик не той формы'));

    const existing = one<{ id: string; pass_mark_pct: number }>(
      'SELECT id, pass_mark_pct FROM tests WHERE block_id = ? AND location_id = ?', block.id, SHARED);
    const passMark = p.data.pass_mark_pct ?? existing?.pass_mark_pct ?? 70;

    let testId = existing?.id;
    if (testId) {
      run('UPDATE tests SET pass_mark_pct = ? WHERE id = ?', passMark, testId);
      // Вопросы заменяются целиком: иначе к новым добавились бы прежние,
      // и аттестация выросла бы вдвое при каждой пересборке.
      run('DELETE FROM questions WHERE test_id = ?', testId);
    } else {
      testId = uuid();
      run('INSERT INTO tests (id, block_id, location_id, pass_mark_pct) VALUES (?,?,?,?)',
        testId, block.id, SHARED, passMark);
    }

    p.data.draft.questions.forEach((q, i) => {
      run('INSERT INTO questions (id, test_id, ord, text, options, correct_index) VALUES (?,?,?,?,?,?)',
        uuid(), testId, i + 1, q.text, JSON.stringify(q.options), q.correct_index);
    });

    run('DELETE FROM ai_block_drafts WHERE block_id = ?', block.id);
    audit(actor(req), 'ai_attestation_apply', null,
      p.data.draft.questions.length + ' вопросов');
    return { test_id: testId, questions: p.data.draft.questions.length, pass_mark_pct: passMark };
  });

  const draftRow = (lessonId: string, location: string) =>
    one<any>('SELECT * FROM ai_drafts WHERE lesson_id = ? AND location_id = ?', lessonId, location);

  const lessonContext = (lessonId: string, location: string) => {
    const l = one<any>(
      `SELECT l.title, p.name position
         FROM lessons l
         JOIN blocks b ON b.id = l.block_id
         JOIN trajectories t ON t.id = b.trajectory_id
         JOIN positions p ON p.id = t.position_id
        WHERE l.id = ?`, lessonId);
    const loc = location === SHARED ? null
      : one<{ name: string }>('SELECT name FROM locations WHERE id = ?', location)?.name ?? null;
    return { lessonTitle: l?.title ?? 'Урок', positionName: l?.position ?? null, locationName: loc };
  };

  // ---------- собрать черновик ----------
  app.post('/ai/lessons/:id/draft', async (req, reply) => {
    const reason = aiUnavailableReason();
    if (reason) return reply.code(503).send(err('ai_disabled', reason));

    const p = z.object({
      source_text: z.string(),
      location_id: z.string().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Нужен текст исходника'));

    const lessonId = (req.params as any).id;
    const slot = contentSlot(lessonId, p.data.location_id);
    if ('error' in slot) return reply.code(422).send(err('bad_location', slot.error));

    try {
      const result = await buildLessonDraft(
        p.data.source_text, { ...lessonContext(lessonId, slot.location), actor: actor(req) });

      run(
        `INSERT INTO ai_drafts (id, lesson_id, location_id, source_text, draft_json, provider, model, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(lesson_id, location_id) DO UPDATE SET
           source_text = excluded.source_text, draft_json = excluded.draft_json,
           provider = excluded.provider, model = excluded.model,
           created_by = excluded.created_by, created_at = excluded.created_at`,
        uuid(), lessonId, slot.location, p.data.source_text,
        JSON.stringify(result.data), result.provider, result.model, actor(req), stamp(),
      );

      return {
        draft: result.data,
        provider: result.provider,
        model: result.model,
        applied: false,
      };
    } catch (e) {
      if (e instanceof AiError) {
        const status = e.code === 'ai_rate_limited' ? 429
          : e.code === 'ai_disabled' ? 503
          : e.code.startsWith('source_') ? 422 : 502;
        return reply.code(status).send(err(e.code, e.message));
      }
      app.log.error(e);
      return reply.code(502).send(err('ai_failed', 'Не удалось собрать урок — попробуйте ещё раз'));
    }
  });

  // ---------- посмотреть, что уже собрано ----------
  app.get('/ai/lessons/:id/draft', async (req, reply) => {
    const lessonId = (req.params as any).id;
    const slot = contentSlot(lessonId, (req.query as any)?.location);
    if ('error' in slot) return reply.code(422).send(err('bad_location', slot.error));

    const row = draftRow(lessonId, slot.location);
    if (!row) return reply.code(404).send(err('not_found', 'Черновика нет'));
    return {
      draft: JSON.parse(row.draft_json),
      source_text: row.source_text,
      provider: row.provider, model: row.model,
      created_by: row.created_by, created_at: row.created_at,
    };
  });

  app.delete('/ai/lessons/:id/draft', async (req, reply) => {
    const slot = contentSlot((req.params as any).id, (req.query as any)?.location);
    if ('error' in slot) return reply.code(422).send(err('bad_location', slot.error));
    run('DELETE FROM ai_drafts WHERE lesson_id = ? AND location_id = ?',
      (req.params as any).id, slot.location);
    return { ok: true };
  });

  // ---------- применить: единственное место, где черновик становится уроком ----------
  app.post('/ai/lessons/:id/apply', async (req, reply) => {
    const p = z.object({
      draft: DraftSchema,
      location_id: z.string().optional(),
      pass_mark_pct: z.number().int().min(1).max(100).optional(),
    }).safeParse(req.body);
    if (!p.success) {
      return reply.code(400).send(err('bad_request', 'Черновик заполнен не полностью', p.error.issues));
    }

    const lessonId = (req.params as any).id;
    const slot = contentSlot(lessonId, p.data.location_id);
    if ('error' in slot) return reply.code(422).send(err('bad_location', slot.error));

    const draft = p.data.draft;
    for (const q of draft.questions) {
      if (q.correct_index >= q.options.length) {
        return reply.code(422).send(err('bad_question',
          `В вопросе «${q.text.slice(0, 40)}…» не отмечен верный вариант`));
      }
    }

    // Материал: текстовый, поверх того, что было в этом слоте.
    const existingMaterial = one<{ id: string }>(
      'SELECT id FROM materials WHERE lesson_id = ? AND location_id = ?', lessonId, slot.location);
    if (existingMaterial) {
      run(`UPDATE materials SET content_type = 'text', text_body = ?, file_url = NULL, min_watch_pct = NULL
            WHERE id = ?`, draft.material, existingMaterial.id);
    } else {
      run(`INSERT INTO materials (id, lesson_id, location_id, content_type, text_body)
           VALUES (?,?,?, 'text', ?)`, uuid(), lessonId, slot.location, draft.material);
    }

    // Тест: старые вопросы уходят целиком — иначе к новым добавятся прежние
    // и сотрудник получит тест из двух разных уроков.
    let test = one<{ id: string }>(
      'SELECT id FROM tests WHERE lesson_id = ? AND location_id = ?', lessonId, slot.location);
    if (!test) {
      const id = uuid();
      run('INSERT INTO tests (id, lesson_id, location_id, pass_mark_pct) VALUES (?,?,?,?)',
        id, lessonId, slot.location, p.data.pass_mark_pct ?? 70);
      test = { id };
    } else {
      run('UPDATE tests SET pass_mark_pct = ? WHERE id = ?', p.data.pass_mark_pct ?? 70, test.id);
      run('DELETE FROM questions WHERE test_id = ?', test.id);
    }
    draft.questions.forEach((q, i) =>
      run('INSERT INTO questions (id, test_id, ord, text, options, correct_index) VALUES (?,?,?,?,?,?)',
        uuid(), test!.id, i + 1, q.text, JSON.stringify(q.options), q.correct_index));

    // Заголовок урока правим, только если HR его изменил в черновике.
    const title = one<{ title: string }>('SELECT title FROM lessons WHERE id = ?', lessonId)?.title;
    if (draft.title && draft.title !== title) {
      run('UPDATE lessons SET title = ? WHERE id = ?', draft.title, lessonId);
    }

    run('DELETE FROM ai_drafts WHERE lesson_id = ? AND location_id = ?', lessonId, slot.location);

    const where = slot.location === SHARED ? 'на всю сеть'
      : `на точке «${one<{ name: string }>('SELECT name FROM locations WHERE id = ?', slot.location)?.name}»`;
    audit(actor(req), 'ai_apply', null,
      `Урок «${draft.title}» собран ИИ и подтверждён ${where}: вопросов ${draft.questions.length}`);

    return { ok: true, questions: draft.questions.length };
  });

  /** Сколько черновиков ждёт проверки — чтобы HR не забыл про начатое. */
  app.get('/ai/drafts', async () => ({
    items: all<any>(`
      SELECT d.lesson_id, d.location_id, d.created_at, d.created_by, l.title
        FROM ai_drafts d JOIN lessons l ON l.id = d.lesson_id
       ORDER BY d.created_at DESC LIMIT 50`),
  }));
}
