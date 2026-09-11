import { sampleDocx } from './_docx.ts';
/* ИИ-конструктор. Проверяет то, что можно проверить без ключа и без денег:
   выключенное состояние, разбор слотов и применение черновика в каталог.
     npx tsx scripts/e2e-ai.ts                                              */
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

const draft = (n = 3) => ({
  title: `Открытие смены ${uniq}`,
  material: 'Смена начинается за пятнадцать минут до открытия зала. '.repeat(4),
  questions: Array.from({ length: n }, (_, i) => ({
    text: `Что делаешь в первую очередь, вопрос ${i + 1}?`,
    options: ['Проверяю станцию', 'Иду курить', 'Жду гостей'],
    correct_index: 0,
  })),
});

async function main() {
  const login = await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } });
  if (login.s !== 200) { console.log('нужен тестовый сервер с LMS_DEV_TOOLS=1'); process.exit(2); }
  h = { authorization: `Bearer ${login.d.token}` };

  const status = (await j('/ai/status', { h })).d;
  console.log(`провайдер: ${status.provider}${status.reason ? ' — ' + status.reason : ''}`);

  // ---------- подготовка: должность, блок, два урока ----------
  const locs = (await j('/locations', { h })).d.items;
  const [A, Bl] = locs;
  const pos = (await j('/positions', { method: 'POST', h, body: { name: `Повар ${uniq}` } })).d.id;
  const blk = (await j(`/trajectories/${pos}/blocks`, { method: 'POST', h, body: { title: 'Смена' } })).d;
  const shared = (await j(`/blocks/${blk.id}/lessons`, {
    method: 'POST', h, body: { title: 'Открытие смены' },
  })).d;
  const perLoc = (await j(`/blocks/${blk.id}/lessons`, {
    method: 'POST', h, body: { title: 'Станции кухни', content_per_location: true },
  })).d;

  // ---------- выключенный провайдер честно говорит об этом ----------
  if (!status.enabled) {
    const off = await j(`/ai/lessons/${shared.id}/draft`, {
      method: 'POST', h, body: { source_text: 'x'.repeat(300) },
    });
    check('выключенный ИИ отвечает 503, а не падает', off.s === 503, off.d?.error?.message ?? '');
  } else {
    // Длину исходник проходит, а содержания в нём нет. Раньше модель послушно
    // собирала урок из «BBBB…», и его можно было нажатием отправить в каталог.
    const junk = await j(`/ai/lessons/${shared.id}/draft`, {
      method: 'POST', h, body: { source_text: 'приветфыв\n' + 'B'.repeat(220) },
    });
    check('бессмысленный исходник отклоняется до обращения к модели',
      junk.s === 422 && junk.d?.error?.code === 'source_not_meaningful',
      `${junk.s} ${junk.d?.error?.code ?? ''}`);
  }

  // ---------- разбор слота работает так же, как в ручном конструкторе ----------
  const wrongSlot = await j(`/ai/lessons/${perLoc.id}/apply`, {
    method: 'POST', h, body: { draft: draft() },
  });
  check('точечному уроку нельзя применить общий черновик', wrongSlot.s === 422,
    wrongSlot.d?.error?.message ?? '');

  const wrongShared = await j(`/ai/lessons/${shared.id}/apply`, {
    method: 'POST', h, body: { draft: draft(), location_id: A.id },
  });
  check('общему уроку нельзя применить черновик точки', wrongShared.s === 422);

  // ---------- применение пишет материал и тест ----------
  const applied = await j(`/ai/lessons/${shared.id}/apply`, { method: 'POST', h, body: { draft: draft(4) } });
  check('черновик применяется', applied.s === 200, JSON.stringify(applied.d));

  const tree = (await j(`/trajectories/${pos}?location=${A.id}`, { h })).d;
  const found = tree.blocks.flatMap((b: any) => b.lessons ?? []).find((l: any) => l.id === shared.id);
  check('материал появился в уроке', !!found?.material?.text_body);
  check('тест появился с нужным числом вопросов', found?.test?.questions?.length === 4,
    String(found?.test?.questions?.length));
  check('заголовок урока обновился', found?.title?.startsWith('Открытие смены'), found?.title);

  // ---------- повторное применение заменяет вопросы, а не копит их ----------
  await j(`/ai/lessons/${shared.id}/apply`, { method: 'POST', h, body: { draft: draft(3) } });
  const again = (await j(`/trajectories/${pos}?location=${A.id}`, { h })).d
    .blocks.flatMap((b: any) => b.lessons ?? []).find((l: any) => l.id === shared.id);
  check('повторное применение заменяет вопросы, а не добавляет', again?.test?.questions?.length === 3,
    String(again?.test?.questions?.length));

  // ---------- точечный урок пишется в свою точку и не течёт в соседнюю ----------
  check('черновик точки применяется', (await j(`/ai/lessons/${perLoc.id}/apply`, {
    method: 'POST', h, body: { draft: draft(3), location_id: A.id },
  })).s === 200);

  const atA = (await j(`/trajectories/${pos}?location=${A.id}`, { h })).d
    .blocks.flatMap((b: any) => b.lessons ?? []).find((l: any) => l.id === perLoc.id);
  const atB = (await j(`/trajectories/${pos}?location=${Bl.id}`, { h })).d
    .blocks.flatMap((b: any) => b.lessons ?? []).find((l: any) => l.id === perLoc.id);
  check('точка А получила материал', !!atA?.material?.text_body);
  check('точка Б не получила чужой материал', atB?.material === null,
    JSON.stringify(atB?.material));

  // ---------- битый черновик отклоняется ----------
  const bad = await j(`/ai/lessons/${shared.id}/apply`, {
    method: 'POST', h,
    body: { draft: { ...draft(3), questions: [{ text: 'Что?', options: ['А', 'Б'], correct_index: 5 }] } },
  });
  check('верный ответ вне диапазона отклоняется', bad.s === 400 || bad.s === 422, String(bad.s));

  const empty = await j(`/ai/lessons/${shared.id}/apply`, {
    method: 'POST', h, body: { draft: { title: 'x', material: 'y', questions: [] } },
  });
  check('черновик без вопросов отклоняется', empty.s === 400, String(empty.s));

  // ---------- документ как исходник ----------
  const send = async (data: Buffer, filename: string) => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(data)]), filename);
    const r = await fetch(`${B}/ai/extract`, { method: 'POST', headers: h, body: fd });
    const t = await r.text();
    return { s: r.status, d: t ? JSON.parse(t) : null };
  };

  const docx = await send(sampleDocx(), 'reglament.docx');
  check('docx разбирается', docx.s === 200, docx.d?.error?.message ?? '');
  const text: string = docx.d?.text ?? '';
  check('текст абзаца собран из кусков', text.includes('за пятнадцать минут до открытия'));
  check('амперсанд раскрыт', text.includes('форму & проверяет'));
  check('кавычки раскрыты', text.includes('у "шефа" до'));
  check('тире из кода символа на месте', text.includes('17:00 —'));
  check('заголовки помечены', text.includes('# Открытие смены') && text.includes('## Стоп-лист'));
  check('русский стиль заголовка распознан', text.includes('## Зоны зала'));
  check('строка таблицы склеена', text.includes('Бар | Бармен'));
  check('оглавление отдано отдельно', (docx.d?.headings ?? []).length >= 4,
    JSON.stringify(docx.d?.headings?.map((x: any) => x.title)));

  const txt = await send(
    Buffer.from('Правила стоп-листа\nУточняют у шефа до 17:00.', 'utf8'), 'pamyatka.txt');
  check('текстовый файл разбирается', txt.s === 200 && txt.d.text.includes('стоп-листа'));

  const win1251 = await send(
    Buffer.from(new Uint8Array([0xcf, 0xf0, 0xe0, 0xe2, 0xe8, 0xeb, 0xe0])), 'stary.txt');
  check('файл в кодировке Windows читается, а не рассыпается',
    win1251.s === 200 && win1251.d.text === 'Правила', JSON.stringify(win1251.d?.text));

  const old = await send(Buffer.from('x'), 'reglament.doc');
  check('старый .doc отклоняется с подсказкой',
    old.s === 422 && old.d?.error?.code === 'doc_old_format', old.d?.error?.message ?? '');
  // PDF читает только Claude. На любом другом ключе отказ должен быть внятным,
  // а не «попробуйте позже»: человеку надо понять, что делать с файлом.
  const pdf = await send(Buffer.from('%PDF-1.4'), 'reglament.pdf');
  check('pdf на не-Claude отклоняется честно',
    status.provider === 'anthropic' || (pdf.s === 422 && pdf.d?.error?.code === 'doc_pdf'),
    `${pdf.s} ${pdf.d?.error?.code ?? ''}`);
  const junk = await send(Buffer.from('это не архив'), 'reglament.docx');
  check('битый docx отклоняется, а не роняет сервер',
    junk.s === 422 && junk.d?.error?.code === 'doc_broken', String(junk.s));

  const noDoc = await j('/ai/extract', { method: 'POST', h });
  check('разбор без файла отклоняется понятной ошибкой',
    noDoc.s === 400 && noDoc.d?.error?.code === 'no_file', `${noDoc.s} ${noDoc.d?.error?.code ?? ''}`);

  // ---------- в журнале осталась запись, что урок собран ИИ ----------
  // Журнал читает администратор, а не кадровик: смысл записи в том, чтобы её
  // видел кто-то другой, а не тот же человек, о ком она сделана.
  const admin = await j('/auth/login', { method: 'POST', body: { login: 'admin', password: 'admin123' } });
  const log = (await j('/audit?limit=20', { h: { authorization: `Bearer ${admin.d.token}` } })).d;
  check('применение записано в журнал', JSON.stringify(log).includes('ai_apply'));

  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
