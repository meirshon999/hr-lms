/* Настройки ИИ: свой ключ через интерфейс, выключение и защита ключа.
     npx tsx scripts/e2e-settings.ts                                         */
import { readFileSync } from 'node:fs';

const B = (process.env.LMS_URL ?? 'http://localhost:3001') + '/api/v1';

async function j(p: string, o: any = {}): Promise<{ s: number; d: any }> {
  const r = await fetch(B + p, {
    method: o.method ?? 'GET',
    headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.h ?? {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  return { s: r.status, d: t ? JSON.parse(t) : null };
}

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

const token = async (login: string, password: string) =>
  (await j('/auth/login', { method: 'POST', body: { login, password } })).d?.token;

const FAKE = 'sk-test-0123456789abcdefghijklmnop';

async function main() {
  const admT = await token('admin', 'admin123');
  const hrT = await token('hr', 'hr123');
  if (!admT || !hrT) { console.log('нужен тестовый сервер с LMS_DEV_TOOLS=1'); process.exit(2); }
  const adm = { authorization: `Bearer ${admT}` };
  const hr = { authorization: `Bearer ${hrT}` };

  // ---------- ключ вставляет тот, кто платит: и кадровик, и админ ----------
  check('кадровик видит настройки', (await j('/settings/ai', { h: hr })).s === 200);
  check('без входа настройки недоступны', (await j('/settings/ai')).s === 401);

  const before = await j('/settings/ai', { h: adm });
  check('администратор видит настройки', before.s === 200, JSON.stringify(before.d?.error ?? ''));
  check('провайдеры перечислены с пояснениями',
    (before.d.providers ?? []).length >= 3
    && before.d.providers.every((p: any) => p.title && p.note),
    (before.d.providers ?? []).map((p: any) => p.key).join(', '));
  check('сказано, где взять ключ и как он начинается',
    before.d.providers.every((p: any) => /^https:\/\//.test(p.console_url) && p.key_prefix && p.price),
    JSON.stringify(before.d.providers?.[0] ?? {}));
  check('видно, кто читает PDF',
    before.d.providers.find((p: any) => p.key === 'anthropic')?.reads_documents === true
    && before.d.providers.find((p: any) => p.key === 'groq')?.reads_documents === false);

  const wasSource = before.d.source;
  const wasProvider = before.d.provider;

  // ---------- включить без ключа нельзя ----------
  const noKey = await j('/settings/ai', { method: 'PUT', h: adm, body: { provider: 'openai' } });
  const canKeep = wasSource === 'settings' && wasProvider === 'openai';
  check('провайдер без ключа не включается',
    canKeep || (noKey.s === 422 && noKey.d?.error?.code === 'no_key'),
    `${noKey.s} ${noKey.d?.error?.code ?? ''}`);

  // ---------- ключ не от того провайдера ловится сразу ----------
  const wrong = await j('/settings/ai', {
    method: 'PUT', h: adm, body: { provider: 'anthropic', api_key: 'gsk_groqkey0123456789abcdef' },
  });
  check('ключ не от того провайдера не принимается',
    wrong.s === 422 && wrong.d?.error?.code === 'wrong_key', `${wrong.s} ${wrong.d?.error?.code ?? ''}`);
  check('в отказе написано, с чего начинается верный ключ',
    /sk-ant-/.test(wrong.d?.error?.message ?? ''), wrong.d?.error?.message ?? '');

  // Ключ уходит в заголовок HTTP: кириллица из буфера обмена там даёт
  // невнятную ошибку внутри библиотеки вместо понятной фразы.
  const cyrillic = await j('/settings/ai', {
    method: 'PUT', h: adm, body: { provider: 'anthropic', api_key: 'sk-ant-ключ-с-кириллицей' },
  });
  check('ключ с посторонними символами не принимается',
    cyrillic.s === 422 && /посторонние символы/.test(cyrillic.d?.error?.message ?? ''),
    `${cyrillic.s} ${cyrillic.d?.error?.message ?? ''}`);

  // ---------- свой ключ через интерфейс ----------
  const set = await j('/settings/ai', {
    method: 'PUT', h: adm, body: { provider: 'openai', api_key: FAKE, model: 'gpt-4o-mini' },
  });
  check('свой ключ принимается', set.s === 200 && set.d.provider === 'openai', JSON.stringify(set.d));
  check('настройка становится главнее серверной', set.d.source === 'settings', set.d.source);

  const after = (await j('/settings/ai', { h: adm })).d;
  check('модель сохранилась', after.model === 'gpt-4o-mini', after.model);
  check('ключ сохранён', after.has_key === true);

  // ---------- ключ наружу не отдаётся ----------
  const body = JSON.stringify(after);
  check('ключ не возвращается ни в каком виде', !body.includes(FAKE), body.slice(0, 120));
  check('от ключа видны только последние знаки',
    after.key_hint === '…mnop', after.key_hint);

  // ---------- ключа нет в файле базы открытым текстом ----------
  // Главная причина шифровать: продукт переезжает копированием файла базы,
  // и незашифрованный ключ уехал бы вместе с копией.
  const dbPath = process.env.LMS_TEST_DB;
  if (dbPath) {
    // Свежая запись может ещё лежать в журнале SQLite, а не в самом файле, —
    // смотреть только .db значит проверять пустоту и радоваться.
    const raw = Buffer.concat(
      [dbPath, `${dbPath}-wal`, `${dbPath}-journal`]
        .map((f) => { try { return readFileSync(f); } catch { return Buffer.alloc(0); } }),
    );
    check('в файле базы ключа открытым текстом нет', !raw.includes(FAKE));
    check('ключ в базе всё-таки есть — зашифрованным', raw.includes('v1:'),
      `осмотрено ${raw.length} байт`);
  } else {
    console.log('(проверка файла базы пропущена: LMS_TEST_DB не задан)');
  }

  // ---------- журнал помнит, но ключа в нём нет ----------
  const log = JSON.stringify((await j('/audit?limit=20', { h: adm })).d);
  check('изменение настроек записано в журнал', log.includes('ai_settings'));
  check('ключа в журнале нет', !log.includes(FAKE));

  // ---------- модель меняется без повторного ввода ключа ----------
  const reModel = await j('/settings/ai', {
    method: 'PUT', h: adm, body: { provider: 'openai', model: 'gpt-4o' },
  });
  check('модель меняется, ключ остаётся',
    reModel.s === 200 && reModel.d.has_key === true, JSON.stringify(reModel.d));
  check('новая модель сохранилась',
    (await j('/settings/ai', { h: adm })).d.model === 'gpt-4o');

  // ---------- кадровик тоже может вставить свой ключ ----------
  const byHr = await j('/settings/ai', {
    method: 'PUT', h: hr, body: { provider: 'openai', api_key: FAKE, model: 'gpt-4o-mini' },
  });
  check('кадровик может задать свой ключ', byHr.s === 200, JSON.stringify(byHr.d));
  check('в журнале видно, кто именно менял настройку',
    JSON.stringify((await j('/audit?limit=5', { h: adm })).d).includes('"hr"'));

  // ---------- расход виден тому, кто платит ----------
  const usage = (await j('/settings/ai', { h: adm })).d.usage;
  check('счётчик расхода отдаётся',
    usage && typeof usage.calls === 'number' && typeof usage.tokens_in === 'number',
    JSON.stringify(usage ?? null));
  check('у видов работы есть человеческие названия',
    !!usage?.titles?.lesson && !!usage?.titles?.pdf, JSON.stringify(usage?.titles ?? {}));

  // ---------- статус для интерфейса согласован с настройками ----------
  const status = (await j('/ai/status', { h: hr })).d;
  check('кадровик видит статус ИИ, но не ключ',
    status.provider === 'openai' && !JSON.stringify(status).includes(FAKE),
    status.provider);
  check('у OpenAI PDF не обещают', status.reads_documents === false, JSON.stringify(status.reads_documents));

  // ---------- выключение ----------
  const off = await j('/settings/ai', { method: 'PUT', h: adm, body: { provider: 'off' } });
  check('ИИ выключается', off.s === 200 && off.d.provider === 'off', JSON.stringify(off.d));

  const offStatus = (await j('/ai/status', { h: hr })).d;
  check('выключенный ИИ так и говорит', offStatus.enabled === false, JSON.stringify(offStatus));
  check('сборка урока отвечает 503, а не падает',
    (await j('/ai/lessons/нет-такого/draft', {
      method: 'POST', h: hr, body: { source_text: 'x'.repeat(600) },
    })).s === 503);
  check('разбор документа тоже 503', (await j('/ai/extract', { method: 'POST', h: hr })).s === 503
    || (await j('/ai/extract', { method: 'POST', h: hr })).s === 400);

  // ---------- убрать свой ключ перед передачей системы ----------
  const cleared = await j('/settings/ai', { method: 'DELETE', h: adm });
  check('ключ убирается, остаются настройки сервера',
    cleared.s === 200 && cleared.d.source !== 'settings', JSON.stringify(cleared.d));

  const restored = (await j('/ai/status', { h: hr })).d;
  check('после сброса действует то, что задано на сервере',
    restored.provider === before.d.ai.provider,
    `${restored.provider} вместо ${before.d.ai.provider}`);

  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
