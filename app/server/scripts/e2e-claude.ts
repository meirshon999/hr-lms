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
/**
 * Очередь ответов для шагов, где запросов подряд несколько: разбор документов
 * спрашивает модель дважды — про каркас и про материалы о компании.
 */
let queue: Array<{ status: number; body: unknown }> = [];
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

/** Документ обучения: заголовки размечены, как их размечает читатель Word. */
const TRAINING_DOC = [
  '# Регламент хостес',
  '',
  '## Начало смены',
  'Хостес выходит за тридцать минут до открытия зала, проверяет схему посадки '
  + 'на текущий день и список броней в журнале. Форма: белая рубашка, чёрный низ, '
  + 'бейдж с именем слева на груди. Телефон остаётся в шкафчике.',
  '',
  '## Встреча гостя',
  'Поздороваться в течение пятнадцати секунд с момента входа гостя, стоя и '
  + 'с зрительным контактом. Уточнить, есть ли бронь и на сколько человек. '
  + 'Проводить до стола, отодвинуть стул, передать меню в раскрытом виде.',
  '',
  '## Брони и лист ожидания',
  'Опаздывающего гостя ждут двадцать минут, после чего стол уходит в общий фонд. '
  + 'Бронь на караоке подтверждается звонком за три часа. Время ожидания называют '
  + 'с запасом в пять минут: лучше позвать раньше, чем передержать.',
].join('\n');

/** Документ о компании — из него вырастает пре-онбординг. */
const COMPANY_DOC = 'Pingwin Premium — сеть развлечений под одной крышей: '
  + 'рестораны, боулинг и караоке. Мы про сервис, скорость и атмосферу. '
  + 'Для гостя нет «не мой участок»: сотрудник отвечает за впечатление целиком. '
  + 'Три зоны на площадке — зал ресторана, дорожки боулинга и караоке-кабинеты, '
  + 'и гость свободно перемещается между ними в течение вечера. Поэтому '
  + 'ориентироваться нужно на всей площадке: где бар, кухня, гардероб и туалеты.';

const PLAN = JSON.stringify({
  blocks: [
    { title: 'Начало работы', lessons: [{ title: 'Начало смены', sections: [1] }] },
    { title: 'Работа с гостем', lessons: [{ title: 'Встреча гостя', sections: [2] }] },
  ],
});

const PRE = JSON.stringify({
  items: [
    {
      title: 'Три формата под одной крышей',
      text: 'Pingwin Premium — это рестораны, боулинг и караоке на одной площадке. '
        + 'Гость свободно ходит между зонами в течение вечера, и впечатление у него '
        + 'складывается общее, а не по каждой зоне отдельно.',
    },
    {
      title: 'Чего мы ждём от вас',
      text: 'Для гостя не существует «не мой участок». Если вопрос задали вам, '
        + 'ответ ищете вы, а не отправляете гостя к другому сотруднику. '
        + 'Это главное, что отличает работу у нас.',
    },
  ],
});

const ATTESTATION = JSON.stringify({
  questions: [
    { text: 'За сколько минут до открытия зала выходит хостес?', options: ['15', '30', '60'], correct_index: 1 },
    { text: 'Сколько держат стол за опоздавшим гостем?', options: ['10 минут', '20 минут', 'до конца вечера'], correct_index: 1 },
    { text: 'За сколько часов подтверждают бронь караоке?', options: ['За час', 'За три часа', 'За сутки'], correct_index: 1 },
    { text: 'Как называют гостю время ожидания?', options: ['Точно', 'С запасом в пять минут', 'Не называют'], correct_index: 1 },
    { text: 'Где во время смены находится личный телефон хостес?', options: ['В шкафчике', 'На стойке', 'В кармане'], correct_index: 0 },
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
    const r = queue.length ? queue.shift()! : reply;
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.body ?? { type: 'error', error: { type: 'api_error', message: 'mock' } }));
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

  // ================= вся траектория из документов, одним заходом =================
  //
  // То, ради чего всё затевалось: человек приносит документы, а не создаёт
  // блоки руками. Проверяем весь путь — разбор, заполнение уроков, аттестацию
  // и создание — и главное: до нажатия «Создать» в каталоге не должно
  // появиться ничего (C-13).

  reply = { status: 200, body: null };
  const posId = (await j('/positions', {
    method: 'POST', h: hr, body: { name: `Хостес ${Date.now().toString().slice(-6)}` },
  })).d?.id;
  check('должность заведена', !!posId);

  queue = [answer(PLAN), answer(PRE)];
  const parsed = await j(`/ai/trajectories/${posId}/plan`, {
    method: 'POST', h: hr, body: { source_text: TRAINING_DOC, pre_text: COMPANY_DOC },
  });
  check('документы разбираются за один заход',
    parsed.s === 200 && parsed.d?.plan?.blocks?.length === 2,
    `${parsed.s} ${JSON.stringify(parsed.d?.error ?? '')}`);
  check('материалы о компании собраны тем же нажатием',
    parsed.d?.pre?.items?.length === 2,
    JSON.stringify(parsed.d?.pre?.items?.map((i: any) => i.title)));

  const emptyYet = (await j(`/trajectories/${posId}`, { h: hr })).d;
  check('после разбора каталог всё ещё пуст',
    emptyYet.blocks.filter((b: any) => b.kind === 'regular').length === 0);

  // ---------- уроки заполняются по одному, а не все разом ----------
  queue = [];
  reply = answer(LESSON);
  const fill1 = await j(`/ai/trajectories/${posId}/plan/fill`, {
    method: 'POST', h: hr, body: { block: 0, lesson: 0 },
  });
  check('урок плана заполняется материалом и тестом',
    fill1.s === 200 && !!fill1.d?.draft?.material && fill1.d?.draft?.questions?.length === 3,
    `${fill1.s} ${JSON.stringify(fill1.d?.error ?? '')}`);
  await j(`/ai/trajectories/${posId}/plan/fill`, { method: 'POST', h: hr, body: { block: 1, lesson: 0 } });

  check('несуществующий урок плана — 404',
    (await j(`/ai/trajectories/${posId}/plan/fill`, {
      method: 'POST', h: hr, body: { block: 9, lesson: 9 },
    })).s === 404);

  const saved = (await j(`/ai/trajectories/${posId}/plan`, { h: hr })).d;
  check('собранные уроки хранятся в плане, а не в каталоге',
    Object.keys(saved.filled ?? {}).length === 2, JSON.stringify(Object.keys(saved.filled ?? {})));

  // ---------- аттестация по собранным урокам ----------
  reply = answer(ATTESTATION);
  const att = await j(`/ai/trajectories/${posId}/plan/attestation`, { method: 'POST', h: hr });
  check('аттестация собирается по собранным урокам',
    att.s === 200 && att.d?.attestation?.questions?.length === 5 && att.d?.based_on === 2,
    `${att.s} ${JSON.stringify(att.d?.error ?? '')}`);

  const stillEmpty = (await j(`/trajectories/${posId}`, { h: hr })).d;
  check('перед подтверждением каталог по-прежнему пуст',
    stillEmpty.blocks.filter((b: any) => b.kind === 'regular').length === 0);

  // ---------- одно нажатие создаёт всё ----------
  const applied = await j(`/ai/trajectories/${posId}/plan/apply`, {
    method: 'POST', h: hr,
    body: {
      plan: saved.plan,
      pre: parsed.d.pre,
      attestation: att.d.attestation,
      mode: 'append',
    },
  });
  check('одно нажатие создаёт блоки, уроки, материалы и аттестацию',
    applied.s === 200 && applied.d?.blocks === 2 && applied.d?.lessons === 2
    && applied.d?.filled === 2 && applied.d?.pre === 2 && applied.d?.attestation === 5,
    JSON.stringify(applied.d));

  const built = (await j(`/trajectories/${posId}`, { h: hr })).d;
  const regular = built.blocks.filter((b: any) => b.kind === 'regular');
  check('блоки названы так, как в плане', regular.length === 2, String(regular.length));
  const firstLesson = regular[0]?.lessons?.[0];
  check('урок пришёл не пустым: есть материал и тест',
    !!firstLesson?.material?.text_body && (firstLesson?.test?.questions ?? []).length === 3,
    JSON.stringify({ m: !!firstLesson?.material, q: firstLesson?.test?.questions?.length }));
  check('материалы о компании попали в пре-онбординг',
    (built.pre_onboarding ?? []).length === 2,
    String((built.pre_onboarding ?? []).length));
  const attBlock = built.blocks.find((b: any) => b.kind === 'attestation');
  check('аттестация получила свои вопросы',
    (attBlock?.test?.questions ?? []).length === 5, String(attBlock?.test?.questions?.length));

  check('использованный план убран, чтобы не применился дважды',
    (await j(`/ai/trajectories/${posId}/plan`, { h: hr })).s === 404);

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
