/* Путь Claude целиком — на подставном сервере вместо платного настоящего.
 *
 * Зачем. Claude — единственный провайдер, к которому мы ходим через SDK, и
 * единственный, кто читает PDF. Пока проверки не было, в этом пути тихо жила
 * поломка: хелпер `zodOutputFormat` из SDK требует схем Zod v4, а у нас v3, —
 * и первый же запрос с настоящим ключом упал бы ещё до отправки. Проверка
 * поднимает свой сервер, отвечающий как Claude, и гоняет по нему живой путь:
 * запрос, разбор ответа, счётчик расхода, чтение PDF и ошибки провайдера.
 *
 *   npx tsx scripts/e2e-claude.ts
 *
 * Сервер LMS должен быть запущен с ANTHROPIC_BASE_URL на адрес ниже.       */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const B = (process.env.LMS_URL ?? 'http://localhost:3001') + '/api/v1';
const MOCK_PORT = Number(process.env.LMS_MOCK_AI_PORT ?? 3998);

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

// Ключ только из латиницы и цифр: заголовки HTTP не берут кириллицу,
// и подставной ключ не должен проверять то, чего не бывает.
const KEY = 'sk-ant-test0123456789abcdefgh';

// ---------------------------------------------------------------- подставной Claude

/** Что вернуть на следующий запрос. Меняем по ходу проверки. */
let reply: { status: number; body: unknown } = { status: 200, body: null };
/** Что пришло в последнем запросе — по нему и проверяем, верно ли мы спрашиваем. */
let lastRequest: any = null;

const answer = (text: string, tokensIn = 1200, tokensOut = 400) => ({
  status: 200,
  body: {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
  },
});

/** Связный текст: короткая или повторяющаяся строка не проходит проверку
    на осмысленность — и правильно делает. */
const SOURCE = `Регламент приёма смены на баре. Бармен приходит за пятнадцать минут до открытия зала, проверяет остатки алкоголя по листу инвентаризации, сверяет наличные в кассе с отчётом предыдущей смены и расписывается в журнале. Посуда моется сразу, грязная на стойке недопустима. Просроченные продукты списываются актом, устные договорённости не принимаются. Холодильники проверяются на температуру дважды: утром и вечером, показания заносятся в тот же журнал.`

const LESSON = JSON.stringify({
  title: 'Приём смены на баре',
  material: 'Смена начинается за пятнадцать минут до открытия. Бармен проверяет '
    + 'остатки, сверяет кассу и расписывается в журнале приёма смены.',
  questions: [
    { text: 'За сколько минут до открытия начинается смена?', options: ['5', '15', '30'], correct_index: 1 },
    { text: 'Что бармен сверяет при приёме смены?', options: ['Кассу', 'Меню', 'Гостей'], correct_index: 0 },
    { text: 'Где расписывается бармен?', options: ['В журнале', 'В чеке', 'Нигде'], correct_index: 0 },
  ],
});

function handler(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
    } catch {
      lastRequest = { url: req.url, headers: req.headers, body: null };
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body ?? { type: 'error', error: { type: 'api_error', message: 'mock' } }));
  });
}

async function main() {
  const mock = createServer(handler);
  await new Promise<void>((r) => mock.listen(MOCK_PORT, r));

  const admT = await token('admin', 'admin123');
  const hrT = await token('hr', 'hr123');
  if (!admT || !hrT) { console.log('нужен тестовый сервер с LMS_DEV_TOOLS=1'); process.exit(2); }
  const adm = { authorization: `Bearer ${admT}` };
  const hr = { authorization: `Bearer ${hrT}` };

  const status0 = (await j('/ai/status', { h: hr })).d;
  if (!status0 || status0.base_url_overridden !== true) {
    // Без подмены адреса запрос ушёл бы в настоящий Claude и стоил бы денег.
    console.log('ANTHROPIC_BASE_URL не задан серверу — проверка пропущена');
    mock.close();
    process.exit(0);
  }

  // ---------- включаем Claude ----------
  const set = await j('/settings/ai', {
    method: 'PUT', h: adm, body: { provider: 'anthropic', api_key: KEY, model: 'claude-sonnet-5' },
  });
  check('Claude включается своим ключом', set.s === 200 && set.d.provider === 'anthropic', JSON.stringify(set.d));

  const status = (await j('/ai/status', { h: hr })).d;
  check('на ключе Claude обещают чтение PDF', status.reads_documents === true);

  // ---------- нужен урок, к которому собирать ----------
  const positions = (await j('/positions', { h: hr })).d;
  const positionId = positions?.items?.[0]?.id;
  const tree = (await j(`/trajectories/${positionId}`, { h: hr })).d;
  const lessonId = tree?.blocks?.[0]?.lessons?.[0]?.id;
  if (!lessonId) { console.log('FAIL в демо-каталоге нет ни одного урока'); process.exit(1); }

  // ---------- сборка урока ----------
  reply = answer(LESSON);
  const draft = await j(`/ai/lessons/${lessonId}/draft`, {
    method: 'POST', h: hr,
    body: { source_text: SOURCE },
  });
  check('Claude собирает урок', draft.s === 200 && draft.d?.draft?.title === 'Приём смены на баре',
    `${draft.s} ${JSON.stringify(draft.d?.error ?? draft.d?.draft?.title ?? '')}`);
  check('вопросы доехали целиком', draft.d?.draft?.questions?.length === 3);

  // ---------- спрашиваем мы правильно ----------
  check('запрос ушёл на нужный адрес', lastRequest?.url === '/v1/messages', String(lastRequest?.url));
  check('ключ ушёл в заголовке, а не в теле',
    lastRequest?.headers?.['x-api-key'] === KEY
    && !JSON.stringify(lastRequest?.body).includes(KEY));
  check('модель взята из настроек', lastRequest?.body?.model === 'claude-sonnet-5', lastRequest?.body?.model);
  check('форма ответа задана схемой',
    lastRequest?.body?.output_config?.format?.type === 'json_schema'
    && !!lastRequest?.body?.output_config?.format?.schema?.properties?.questions,
    JSON.stringify(lastRequest?.body?.output_config ?? null).slice(0, 120));
  check('правила ушли отдельно от исходника',
    typeof lastRequest?.body?.system === 'string' && lastRequest.body.system.length > 50);

  // ---------- расход посчитан ----------
  const usage = (await j('/settings/ai', { h: adm })).d.usage;
  check('расход записан с токенами от провайдера',
    usage.tokens_in >= 1200 && usage.tokens_out >= 400,
    `${usage.tokens_in} / ${usage.tokens_out}`);
  check('в разбивке появилась сборка урока',
    usage.by_action.some((r: any) => r.action === 'lesson' && r.calls >= 1),
    JSON.stringify(usage.by_action));

  // ---------- PDF читает Claude ----------
  reply = answer('Правила бара\nСмена начинается за пятнадцать минут до открытия.', 900, 120);
  const pdf = await sendFile(hrT, Buffer.from('%PDF-1.4 фиктивный'), 'reglament.pdf');
  check('PDF уходит в Claude и возвращается текстом',
    pdf.s === 200 && /Смена начинается/.test(pdf.d?.text ?? ''),
    `${pdf.s} ${JSON.stringify(pdf.d?.error ?? '')}`);
  check('PDF ушёл документом, а не текстом',
    lastRequest?.body?.messages?.[0]?.content?.[0]?.type === 'document'
    && lastRequest?.body?.messages?.[0]?.content?.[0]?.source?.media_type === 'application/pdf',
    JSON.stringify(lastRequest?.body?.messages?.[0]?.content?.[0]?.type ?? null));
  check('чтение PDF попало в расход отдельной строкой',
    (await j('/settings/ai', { h: adm })).d.usage.by_action.some((r: any) => r.action === 'pdf'));

  // ---------- ответ не той формы ----------
  reply = answer(JSON.stringify({ title: 'Коротко', material: 'мало', questions: [] }));
  const bad = await j(`/ai/lessons/${lessonId}/draft`, {
    method: 'POST', h: hr, body: { source_text: SOURCE },
  });
  check('ответ не той формы не попадает в урок', bad.s !== 200, String(bad.s));
  check('человеку показана понятная фраза по-русски',
    /[а-яё]/i.test(bad.d?.error?.message ?? ''), bad.d?.error?.message ?? '');

  // ---------- ошибки провайдера человеку ----------
  reply = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
  const badKey = await j('/settings/ai/test', { method: 'POST', h: adm });
  check('неверный ключ назван неверным ключом',
    badKey.s === 422 && badKey.d?.error?.code === 'ai_bad_key',
    `${badKey.s} ${badKey.d?.error?.code ?? ''}`);
  check('английский текст провайдера на экран не попадает',
    !/invalid x-api-key/.test(JSON.stringify(badKey.d)), JSON.stringify(badKey.d).slice(0, 120));

  reply = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } };
  const limited = await j('/settings/ai/test', { method: 'POST', h: adm });
  check('исчерпанный лимит назван лимитом',
    limited.s === 429 && limited.d?.error?.code === 'ai_rate_limited',
    `${limited.s} ${limited.d?.error?.code ?? ''}`);

  reply = { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model not found' } } };
  const noModel = await j('/settings/ai/test', { method: 'POST', h: adm });
  check('неизвестная модель отправляет править настройку',
    noModel.d?.error?.code === 'ai_bad_model'
    && /настройк/i.test(noModel.d?.error?.message ?? ''),
    noModel.d?.error?.message ?? '');

  check('неудачные обращения тоже посчитаны',
    (await j('/settings/ai', { h: adm })).d.usage.failed >= 3);

  // ---------- убираем за собой ----------
  await j('/settings/ai', { method: 'DELETE', h: adm });
  mock.close();

  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

/** Загрузка файла — своя, потому что multipart руками короче, чем тянуть зависимость. */
async function sendFile(tok: string, body: Buffer, filename: string) {
  const boundary = '----lmsclaude' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const r = await fetch(B + '/ai/extract', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, body, tail]),
  });
  const t = await r.text();
  return { s: r.status, d: t ? JSON.parse(t) : null };
}

main().catch((e) => { console.error(e); process.exit(2); });
