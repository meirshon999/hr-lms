/* ИИ-конструктор. Проверяет то, что можно проверить без ключа и без денег:
   выключенное состояние, разбор документов, слоты и применение черновика.
     npx tsx scripts/e2e-ai.ts                                              */
import { sampleDocx } from './_docx.ts';
import { samplePdf, scannedPdf } from './_pdf.ts';

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

  // Стилями Word почти никто не пользуется: разделы нумеруют руками. Документ
  // с явными разделами приезжал сплошным текстом, и «Собрать из документа»
  // отказывалась работать — «одна сплошная тема» на шести разделах.
  const numbered = await send(Buffer.from(
    '1. Приём смены\nБармен приходит за пятнадцать минут до открытия.\n\n'
    + '2. Работа с гостем\nЗаказ повторяется вслух перед пробитием.\n\n'
    + '3. Закрытие смены\nКасса сверяется с отчётом, остатки заносятся в журнал.', 'utf8'),
  'nomera.txt');
  check('нумерованные разделы распознаны как заголовки',
    (numbered.d?.headings ?? []).length === 3,
    JSON.stringify(numbered.d?.headings?.map((x: any) => x.title)));

  // Осторожность важнее находчивости: пункты списка — не разделы.
  const listed = await send(Buffer.from(
    'Порядок действий при жалобе гостя, если она поступила в зале.\n'
    + '1. Выслушать гостя до конца, не перебивая его и ничем не оправдываясь.\n'
    + '2. Позвать управляющего, решения о скидках хостес не принимает сама.\n'
    + '3. Занести жалобу в журнал смены в тот же день, а не на следующий.', 'utf8'),
  'spisok.txt');
  check('пункты списка за разделы не принимаются',
    (listed.d?.headings ?? []).length === 0,
    JSON.stringify(listed.d?.headings?.map((x: any) => x.title)));

  const win1251 = await send(
    Buffer.from(new Uint8Array([0xcf, 0xf0, 0xe0, 0xe2, 0xe8, 0xeb, 0xe0])), 'stary.txt');
  check('файл в кодировке Windows читается, а не рассыпается',
    win1251.s === 200 && win1251.d.text === 'Правила', JSON.stringify(win1251.d?.text));

  const old = await send(Buffer.from('x'), 'reglament.doc');
  check('старый .doc отклоняется с подсказкой',
    old.s === 422 && old.d?.error?.code === 'doc_old_format', old.d?.error?.message ?? '');
  // ---------- PDF ----------
  // Читаем своими силами: на бесплатном ключе и вовсе без ключа. Это главное,
  // ради чего разбор написан — регламенты у сети именно в PDF.
  const pdf = await send(samplePdf([{
    lines: [
      'Регламент бармена',
      '1. Приём смены',
      'Бармен приходит за пятнадцать минут до открытия и пересчитывает кассу.',
      '2. Работа с гостем',
      'Заказ повторяется вслух перед пробитием, чтобы не было споров по счёту.',
    ],
  }]), 'reglament.pdf');
  check('pdf с текстом читается без всякого ключа',
    pdf.s === 200 && (pdf.d?.text ?? '').includes('пересчитывает кассу'),
    `${pdf.s} ${pdf.d?.error?.message ?? ''}`);
  check('кириллица из pdf пришла целой, а не крокозябрами',
    /^[\s\S]*Бармен приходит за пятнадцать минут[\s\S]*$/.test(pdf.d?.text ?? ''),
    (pdf.d?.text ?? '').slice(0, 80));
  check('разделы pdf распознаны как заголовки',
    (pdf.d?.headings ?? []).length === 2,
    JSON.stringify(pdf.d?.headings?.map((h: any) => h.title)));
  check('видно, кто прочитал документ', pdf.d?.read_by === 'own', String(pdf.d?.read_by));

  const uncompressed = await send(
    samplePdf([{ lines: ['Памятка без сжатия потока внутри файла'] }], { compress: false }),
    'bez-szhatiya.pdf');
  check('pdf с несжатым потоком тоже читается',
    uncompressed.s === 200 && (uncompressed.d?.text ?? '').includes('без сжатия'),
    `${uncompressed.s} ${uncompressed.d?.error?.message ?? ''}`);

  // Скан — картинка вместо букв. Своими силами тут ничего не сделать, и без
  // ключа Claude человеку надо сказать это прямо, а не «документ пустой».
  const scan = await send(scannedPdf(), 'skan.pdf');
  check('скан без Claude отклоняется с внятной причиной',
    status.provider === 'anthropic'
    || (scan.s === 422 && scan.d?.error?.code === 'doc_scanned'),
    `${scan.s} ${scan.d?.error?.code ?? ''}`);
  check('в отказе сказано, что делать со сканом',
    status.provider === 'anthropic'
    || /скан|Claude|Word/i.test(scan.d?.error?.message ?? ''),
    scan.d?.error?.message ?? '');

  const brokenPdf = await send(Buffer.from('не pdf вовсе'), 'reglament.pdf');
  check('файл не того формата с именем .pdf отклоняется, а не роняет сервер',
    brokenPdf.s === 422 && brokenPdf.d?.error?.code === 'doc_broken',
    `${brokenPdf.s} ${brokenPdf.d?.error?.code ?? ''}`);
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
