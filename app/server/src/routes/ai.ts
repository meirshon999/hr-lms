import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, SHARED, uuid } from '../db.ts';
import { authRequired, err } from '../auth.ts';
import { audit } from '../audit.ts';
import { stamp } from '../clock.ts';
import { contentSlot } from '../content.ts';
import { AiError, aiInfo, aiUnavailableReason } from '../ai/provider.ts';
import { sttInfo, transcribe } from '../ai/transcribe.ts';
import { MAX_AUDIO_MB } from '../config.ts';
import { buildLessonDraft, DraftSchema } from '../ai/lesson.ts';

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
  app.get('/ai/status', async () => ({ ...aiInfo(), stt: sttInfo() }));

  /**
   * Надиктованное — в текст. Ничего не сохраняем: запись нужна ровно на то время,
   * пока идёт расшифровка. Голос сотрудника хранить незачем.
   */
  app.post('/ai/transcribe', async (req: any, reply) => {
    // Без перехвата запрос не той формы отдаёт 406 от самого фреймворка —
    // клиент получил бы невнятную ошибку вместо понятной причины.
    let part: any;
    try {
      part = await req.file();
    } catch {
      return reply.code(400).send(err('no_file', 'Запись не передана'));
    }
    if (!part) return reply.code(400).send(err('no_file', 'Запись не передана'));

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of part.file) {
      size += chunk.length;
      if (size > MAX_AUDIO_MB * 1024 * 1024) {
        return reply.code(413).send(err('too_large', `Запись больше ${MAX_AUDIO_MB} МБ — говорите короче`));
      }
      chunks.push(chunk);
    }

    try {
      const text = await transcribe(Buffer.concat(chunks), part.filename || 'speech.webm');
      return { text };
    } catch (e) {
      if (e instanceof AiError) {
        const status = e.code === 'stt_disabled' ? 503
          : e.code === 'stt_rate_limited' ? 429
          : e.code === 'stt_too_large' ? 413 : 502;
        return reply.code(status).send(err(e.code, e.message));
      }
      app.log.error(e);
      return reply.code(502).send(err('stt_failed', 'Не удалось расшифровать запись'));
    }
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
      const result = await buildLessonDraft(p.data.source_text, lessonContext(lessonId, slot.location));

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
