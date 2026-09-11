import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { UPLOAD_DIR, MAX_UPLOAD_MB } from '../config.ts';
import { all, one, run, uuid } from '../db.ts';
import { authRequired, err, loadUser } from '../auth.ts';
import { stamp } from '../clock.ts';
import { audit } from '../audit.ts';
import { videoDurationSec } from '../mp4.ts';

/** Что разрешаем загружать: видео, PDF и картинки. */
const ALLOWED: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

const KIND: Record<string, 'video' | 'pdf' | 'image'> = {
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'application/pdf': 'pdf', 'image/png': 'image', 'image/jpeg': 'image',
};

export default async function fileRoutes(app: FastifyInstance) {
  mkdirSync(UPLOAD_DIR, { recursive: true });

  // ---------- загрузка (только HR/админ) ----------
  app.post('/files', { preHandler: authRequired('hr', 'admin') }, async (req: any, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send(err('no_file', 'Файл не передан'));

    const mime = part.mimetype;
    if (!ALLOWED[mime]) {
      return reply.code(415).send(err('bad_type',
        'Можно загружать видео (mp4, webm, mov), PDF или картинку (png, jpg)'));
    }

    const id = uuid();
    const ext = ALLOWED[mime] || extname(part.filename) || '';
    const path = join(UPLOAD_DIR, id + ext);
    try {
      await pipeline(part.file, createWriteStream(path));
    } catch {
      if (existsSync(path)) unlinkSync(path);
      return reply.code(500).send(err('write_failed', 'Не удалось сохранить файл'));
    }
    // fastify-multipart обрезает поток на лимите и поднимает флаг
    if (part.file.truncated) {
      unlinkSync(path);
      return reply.code(413).send(err('too_large', `Файл больше ${MAX_UPLOAD_MB} МБ`));
    }

    const size = statSync(path).size;
    // Длительность читаем сразу и храним: потом по ней проверяют, досмотрел ли
    // человек ролик. Спрашивать её у браузера нельзя — он на стороне того,
    // кого проверяют.
    const duration = KIND[mime] === 'video' ? videoDurationSec(path) : null;
    run(`INSERT INTO files (id, orig_name, mime, kind, ext, size_bytes, uploaded_by, created_at, duration_sec)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      id, part.filename ?? 'файл', mime, KIND[mime], ext, size,
      (req as any).user?.login ?? 'system', stamp(), duration);
    audit((req as any).user?.login ?? 'system', 'upload_file', null,
      `${part.filename} (${(size / 1024 / 1024).toFixed(1)} МБ)`);

    return reply.code(201).send({
      id, url: `/api/v1/files/${id}`, kind: KIND[mime],
      orig_name: part.filename, mime, size_bytes: size, duration_sec: duration,
    });
  });

  app.get('/files', { preHandler: authRequired('hr', 'admin') }, async () => ({
    items: all<any>('SELECT * FROM files ORDER BY created_at DESC LIMIT 200')
      .map((f) => ({ ...f, url: `/api/v1/files/${f.id}` })),
  }));

  // ---------- отдача ----------
  // Без заголовка авторизации: <video src> и <iframe src> его не отправляют.
  // Защита — неугадываемый uuid. В проде заменить на подписанные ссылки
  // или отдачу через хранилище платформы (S3 + presigned URL).
  app.get('/files/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const f = one<any>('SELECT * FROM files WHERE id = ?', id);
    if (!f) return reply.code(404).send(err('not_found', 'Файл не найден'));
    const path = join(UPLOAD_DIR, f.id + f.ext);
    if (!existsSync(path)) return reply.code(404).send(err('not_found', 'Файл не найден'));

    const total = statSync(path).size;
    reply.header('content-type', f.mime);
    reply.header('cache-control', 'public, max-age=86400');
    reply.header('accept-ranges', 'bytes');

    // Range нужен, чтобы видео можно было перематывать
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : total - 1;
        if (start >= total || end >= total || start > end) {
          return reply.code(416).header('content-range', `bytes */${total}`).send();
        }
        reply.code(206);
        reply.header('content-range', `bytes ${start}-${end}/${total}`);
        reply.header('content-length', end - start + 1);
        return reply.send(createReadStream(path, { start, end }));
      }
    }
    reply.header('content-length', total);
    return reply.send(createReadStream(path));
  });

  app.delete('/files/:id', { preHandler: authRequired('hr', 'admin') }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const f = one<any>('SELECT * FROM files WHERE id = ?', id);
    if (!f) return reply.code(404).send(err('not_found', 'Файл не найден'));
    const path = join(UPLOAD_DIR, f.id + f.ext);
    if (existsSync(path)) unlinkSync(path);
    run('DELETE FROM files WHERE id = ?', id);
    return { ok: true };
  });

  void loadUser; // используется через authRequired
}
