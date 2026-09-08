/* Файлы: загрузка HR, отдача сотруднику, ограничения.
   Запуск при живом сервере: npx tsx scripts/e2e-files.ts                    */
import { readFileSync } from 'node:fs';

const ROOT = (process.env.LMS_URL ?? 'http://localhost:3001');
const B = ROOT + '/api/v1';
const uniq = Date.now().toString().slice(-6);

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function j(p: string, o: any = {}): Promise<{ s: number; d: any }> {
  const r = await fetch(B + p, {
    method: o.method ?? 'GET',
    headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.h ?? {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  return { s: r.status, d: t ? JSON.parse(t) : null };
}

/** Минимальный валидный PDF — чтобы не тащить бинарь в репозиторий. */
function tinyPdf(): Blob {
  const body = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
    + 'trailer<</Root 1 0 R>>\n%%EOF\n';
  return new Blob([body], { type: 'application/pdf' });
}

async function upload(h: any, blob: Blob, name: string) {
  const fd = new FormData();
  fd.append('file', blob, name);
  const r = await fetch(B + '/files', { method: 'POST', headers: h, body: fd });
  const t = await r.text();
  return { s: r.status, d: t ? JSON.parse(t) : null };
}

async function main() {
  const hr = { authorization: 'Bearer ' + (await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } })).d.token };

  // ---- загрузка ----
  const up = await upload(hr, tinyPdf(), `regl-${uniq}.pdf`);
  check('PDF загружается', up.s === 201, `HTTP ${up.s}`);
  check('вернулся url файла', /^\/api\/v1\/files\//.test(up.d?.url ?? ''), up.d?.url);
  check('тип определён как pdf', up.d?.kind === 'pdf', up.d?.kind);
  const url = ROOT + up.d.url;

  // ---- отдача ----
  const get1 = await fetch(url);
  check('файл отдаётся', get1.status === 200, `HTTP ${get1.status}`);
  check('правильный content-type', (get1.headers.get('content-type') ?? '').includes('application/pdf'));
  const bytes = (await get1.arrayBuffer()).byteLength;
  check('размер совпадает с загруженным', bytes === up.d.size_bytes, `${bytes} vs ${up.d.size_bytes}`);

  const rng = await fetch(url, { headers: { range: 'bytes=0-9' } });
  check('поддерживается перемотка (Range)', rng.status === 206, `HTTP ${rng.status}`);
  check('accept-ranges объявлен', (get1.headers.get('accept-ranges') ?? '') === 'bytes');

  // отдача без токена обязательна: <video>/<object> не шлют заголовок авторизации
  check('файл доступен без заголовка авторизации', (await fetch(url)).status === 200);

  // ---- ограничения ----
  const bad = await upload(hr, new Blob(['текст'], { type: 'text/plain' }), 'x.txt');
  check('посторонний тип отклоняется', bad.s === 415, `HTTP ${bad.s}`);

  const anon = await fetch(B + '/files', { method: 'POST', body: (() => {
    const fd = new FormData(); fd.append('file', tinyPdf(), 'a.pdf'); return fd;
  })() });
  check('загрузка без авторизации запрещена', anon.status === 401, `HTTP ${anon.status}`);

  const missing = await fetch(`${B}/files/00000000-0000-0000-0000-000000000000`);
  check('несуществующий файл — 404', missing.status === 404, `HTTP ${missing.status}`);

  // ---- файл доезжает до сотрудника через материал урока ----
  const pos = (await j('/positions', { method: 'POST', h: hr, body: { name: 'Файлы' + uniq } })).d;
  const blk = (await j(`/trajectories/${pos.id}/blocks`, { method: 'POST', h: hr, body: { title: 'Блок' } })).d;
  const les = (await j(`/blocks/${blk.id}/lessons`, { method: 'POST', h: hr, body: { title: 'Регламент' } })).d;
  const put = await j(`/lessons/${les.id}/material`, {
    method: 'PUT', h: hr, body: { content_type: 'pdf', file_url: up.d.url, text_body: null, min_watch_pct: null },
  });
  check('материал сохраняется со ссылкой на файл', put.s === 200 || put.s === 201, `HTTP ${put.s}`);
  const tree = (await j(`/trajectories/${pos.id}`, { h: hr })).d;
  const saved = tree.blocks.flatMap((b: any) => b.lessons ?? []).find((l: any) => l.id === les.id);
  check('ссылка на файл лежит в каталоге', saved?.material?.file_url === up.d.url, saved?.material?.file_url);

  // ---- удаление ----
  const del = await j(`/files/${up.d.id}`, { method: 'DELETE', h: hr });
  check('файл удаляется', del.s === 200, `HTTP ${del.s}`);
  check('после удаления отдача даёт 404', (await fetch(url)).status === 404);

  await j(`/positions/${pos.id}`, { method: 'DELETE', h: hr });
  console.log(failed ? `\n${failed} проверок провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e?.stack ?? e); process.exit(1); });
void readFileSync;
