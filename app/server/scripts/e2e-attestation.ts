/* Финальная аттестация одной кнопкой. Главное, что здесь проверяется:
   вопросы аттестации СВОИ, а не переписанные из уроков, и до нажатия
   человека каталог не тронут.
     npx tsx scripts/e2e-attestation.ts                                      */
const B = (process.env.LMS_URL ?? 'http://localhost:3001') + '/api/v1';
const uniq = Date.now().toString().slice(-6);

async function j(p: string, o: any = {}): Promise<{ s: number; d: any }> {
  const r = await fetch(B + p, {
    method: o.method ?? 'GET',
    headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.h ?? {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  return { s: r.status, d: t ? JSON.parse(t) : null };
}

let h: any;
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

const MATERIAL = [
  'Смена официанта начинается за пятнадцать минут до открытия зала. Сотрудник переодевается ',
  'в форму, проверяет чистоту станции, наличие приборов и салфеток. Стоп-лист по кухне ',
  'и бару уточняется у менеджера смены на брифинге. Опоздание больше пяти минут менеджер ',
  'фиксирует в журнале смены. Личный телефон остаётся в подсобке, в зале им не пользуются.',
].join('');

const MATERIAL2 = [
  'Гостя встречают в течение тридцати секунд. Столы у окна отдаются компаниям от четырёх ',
  'человек, пары сажают в центр зала. Компанию больше шести человек рассаживают только ',
  'с ведома менеджера смены. Если свободных столов нет, гостя записывают в лист ожидания ',
  'и называют срок в минутах, а не «скоро». Гостя с ребёнком сажают подальше от прохода.',
].join('');

/** Заполняет урок материалом и одним вопросом. */
async function fill(lessonId: string, text: string, question: string) {
  await j(`/lessons/${lessonId}/material`, {
    method: 'PUT', h, body: { content_type: 'text', text_body: text },
  });
  const testId = (await j(`/lessons/${lessonId}/test`, {
    method: 'PUT', h, body: { pass_mark_pct: 70 },
  })).d.test_id;
  await j(`/tests/${testId}/questions`, {
    method: 'POST', h,
    body: { text: question, options: ['Верно', 'Неверно', 'Не знаю'], correct_index: 0 },
  });
}

async function main() {
  const login = await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } });
  if (login.s !== 200) { console.log('нужен тестовый сервер с LMS_DEV_TOOLS=1'); process.exit(2); }
  h = { authorization: `Bearer ${login.d.token}` };

  const status = (await j('/ai/status', { h })).d;
  const locs = (await j('/locations', { h })).d.items;
  const [A] = locs;

  const pos = (await j('/positions', { method: 'POST', h, body: { name: `Официант ${uniq}` } })).d.id;
  const blk = (await j(`/trajectories/${pos}/blocks`, { method: 'POST', h, body: { title: 'Смена' } })).d;

  const l1 = (await j(`/blocks/${blk.id}/lessons`, { method: 'POST', h, body: { title: 'Открытие смены' } })).d;
  const l2 = (await j(`/blocks/${blk.id}/lessons`, { method: 'POST', h, body: { title: 'Рассадка гостей' } })).d;
  // Точечный урок: в аттестацию попадать не должен — она одна на всю сеть.
  const perLoc = (await j(`/blocks/${blk.id}/lessons`, {
    method: 'POST', h, body: { title: 'План зала точки', content_per_location: true },
  })).d;

  const Q1 = 'За сколько минут до открытия зала приходит официант?';
  const Q2 = 'Кому отдаются столы у окна?';
  await fill(l1.id, MATERIAL, Q1);
  await fill(l2.id, MATERIAL2, Q2);
  await j(`/lessons/${perLoc.id}/material`, {
    method: 'PUT', h,
    body: { content_type: 'text', text_body: 'На этой точке кухня слева от бара, склад за залом.', location_id: A.id },
  });

  const tree = (await j(`/trajectories/${pos}`, { h })).d;
  const att = tree.blocks.find((b: any) => b.kind === 'attestation');
  check('блок аттестации есть у новой траектории', !!att, tree.blocks.map((b: any) => b.kind).join(','));

  // ---------- защита адресов ----------
  const notAtt = await j(`/ai/blocks/${blk.id}/attestation`, { method: 'POST', h, body: {} });
  check('на обычный блок аттестацию не собрать',
    notAtt.s === (status.enabled ? 404 : 503), String(notAtt.s));
  check('черновика ещё нет', (await j(`/ai/blocks/${att.id}/attestation`, { h })).s === 404);

  if (!status.enabled) {
    const off = await j(`/ai/blocks/${att.id}/attestation`, { method: 'POST', h, body: {} });
    check('выключенный ИИ отвечает 503, а не падает', off.s === 503, off.d?.error?.message ?? '');
    console.log(failed ? `\n${failed} провалено` : '\nвсе доступные проверки пройдены');
    process.exit(failed ? 1 : 0);
  }

  // ---------- сборка ----------
  const r = await j(`/ai/blocks/${att.id}/attestation`, { method: 'POST', h, body: { count: 6 } });
  check('аттестация собирается', r.s === 200, JSON.stringify(r.d?.error ?? ''));
  if (r.s !== 200) process.exit(1);

  check('запрошенное число вопросов соблюдено', r.d.draft.questions.length === 6,
    String(r.d.draft.questions.length));
  check('считаем только уроки с материалом', r.d.based_on === 2, String(r.d.based_on));
  check('точечный урок в аттестацию не берётся', r.d.per_location === 1, String(r.d.per_location));
  check('модели показали уже заданные вопросы', r.d.avoided === 2, String(r.d.avoided));

  // ---------- главное: вопросы свои ----------
  const norm = (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, '').replace(/\s+/g, ' ').trim();
  const lessonQs = [Q1, Q2].map(norm);
  const repeats = r.d.draft.questions.filter((q: any) => lessonQs.includes(norm(q.text)));
  check('вопросы аттестации не повторяют вопросы уроков дословно',
    repeats.length === 0, repeats.map((q: any) => q.text).join(' | '));

  check('у каждого вопроса есть варианты и верный из них',
    r.d.draft.questions.every((q: any) =>
      q.options.length >= 3 && q.correct_index >= 0 && q.correct_index < q.options.length),
    JSON.stringify(r.d.draft.questions.map((q: any) => q.options.length)));

  const firstCorrect = r.d.draft.questions.filter((q: any) => q.correct_index === 0).length;
  check('верный ответ не всегда первый', firstCorrect < r.d.draft.questions.length,
    `${firstCorrect} из ${r.d.draft.questions.length}`);

  // ---------- до нажатия человека каталог не тронут (C-13) ----------
  const during = (await j(`/trajectories/${pos}`, { h })).d.blocks.find((b: any) => b.kind === 'attestation');
  check('после сборки аттестация в каталоге всё ещё пуста',
    !during.test || during.test.questions.length === 0,
    String(during.test?.questions?.length ?? 0));

  check('черновик сохранился и читается', (await j(`/ai/blocks/${att.id}/attestation`, { h })).s === 200);

  // ---------- человек правит и применяет ----------
  const edited = {
    questions: r.d.draft.questions.slice(0, 4).map((q: any, i: number) =>
      (i === 0 ? { ...q, text: 'Правленый вопрос кадровика?' } : q)),
  };
  const ap = await j(`/ai/blocks/${att.id}/attestation/apply`, {
    method: 'POST', h, body: { draft: edited, pass_mark_pct: 80 },
  });
  check('правленая аттестация применяется',
    ap.s === 200 && ap.d.questions === 4 && ap.d.pass_mark_pct === 80, JSON.stringify(ap.d));

  const after = (await j(`/trajectories/${pos}`, { h })).d.blocks.find((b: any) => b.kind === 'attestation');
  check('в каталоге ровно то, что прислал человек',
    after.test?.questions?.length === 4
    && after.test.questions.some((q: any) => q.text === 'Правленый вопрос кадровика?'),
    String(after.test?.questions?.length));

  // ---------- повторная сборка заменяет, а не копит ----------
  const again = await j(`/ai/blocks/${att.id}/attestation`, { method: 'POST', h, body: { count: 5 } });
  if (again.s === 200) {
    await j(`/ai/blocks/${att.id}/attestation/apply`, { method: 'POST', h, body: { draft: again.d.draft } });
    const twice = (await j(`/trajectories/${pos}`, { h })).d.blocks
      .find((b: any) => b.kind === 'attestation');
    check('повторное применение заменяет вопросы, а не добавляет',
      twice.test.questions.length === 5, String(twice.test.questions.length));
    check('проходной балл сохраняется, если его не меняли',
      twice.test.pass_mark_pct === 80, String(twice.test.pass_mark_pct));
  }

  check('применённый черновик убран', (await j(`/ai/blocks/${att.id}/attestation`, { h })).s === 404);

  const admin = await j('/auth/login', { method: 'POST', body: { login: 'admin', password: 'admin123' } });
  const log = (await j('/audit?limit=30', { h: { authorization: `Bearer ${admin.d.token}` } })).d;
  check('подтверждение аттестации записано в журнал',
    JSON.stringify(log).includes('ai_attestation_apply'));

  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
