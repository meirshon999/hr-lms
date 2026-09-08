import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { PORT } from './config.ts';
import { migrate, one } from './db.ts';
import { seed } from './seed.ts';
import { err } from './auth.ts';
import authRoutes from './routes/auth.ts';
import meRoutes from './routes/me.ts';
import employeeRoutes from './routes/employees.ts';
import catalogRoutes from './routes/catalog.ts';
import analyticsRoutes from './routes/analytics.ts';
import devRoutes from './routes/dev.ts';

migrate();
// первый запуск с пустой БД — засеять демо-данные
if (!one('SELECT 1 FROM users LIMIT 1')) {
  seed();
  console.log('  seeded demo data');
}

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true });

// POST без тела (кнопки-действия) не должны падать на пустом JSON
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (!body || (body as string).trim() === '') return done(null, undefined);
  try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
});

app.setErrorHandler((error: any, _req, reply) => {
  const status = error?.statusCode ?? 500;
  if (status >= 500) app.log.error(error);
  reply.code(status).send(err(status >= 500 ? 'internal' : 'bad_request', error?.message ?? 'Ошибка'));
});

await app.register(authRoutes, { prefix: '/api/v1' });
await app.register(meRoutes, { prefix: '/api/v1' });
await app.register(employeeRoutes, { prefix: '/api/v1' });
await app.register(catalogRoutes, { prefix: '/api/v1' });
await app.register(analyticsRoutes, { prefix: '/api/v1' });
await app.register(devRoutes, { prefix: '/api/v1' });

// Swagger UI из openapi.yaml (в корне проекта) — живое дерево API на /docs
const __dir = dirname(fileURLToPath(import.meta.url));
const openapiPath = [
  join(__dir, '..', '..', '..', 'openapi.yaml'), // dev: src/  → корень проекта
  join(__dir, '..', '..', '..', '..', 'openapi.yaml'), // prod: dist/ → корень проекта
].find(existsSync);
if (openapiPath) {
  await app.register(swagger, { mode: 'static', specification: { path: openapiPath, baseDir: dirname(openapiPath) } });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });
}

app.get('/api/health', async () => ({ ok: true }));

// Прод: тот же процесс отдаёт собранный фронт — один порт, один сервис.
// В dev этой папки нет, фронт живёт на Vite :5173 и проксирует /api сюда.
const webDist = join(__dir, '..', '..', 'web', 'dist');
if (existsSync(join(webDist, 'index.html'))) {
  const indexHtml = readFileSync(join(webDist, 'index.html'), 'utf8');
  await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send(err('not_found', 'Не найдено'));
    reply.type('text/html; charset=utf-8').send(indexHtml); // SPA-фолбэк
  });
  console.log('  фронт отдаётся из web/dist');
}

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`  LMS на порту ${PORT}`);
