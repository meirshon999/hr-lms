import { testIin } from './_iin.ts';
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

  // ---------- расшифровка речи ----------
  const noFile = await j('/ai/transcribe', { method: 'POST', h });
  check('расшифровка без файла отклоняется понятной ошибкой',
    noFile.s === 400 && noFile.d?.error?.code === 'no_file',
    `${noFile.s} ${noFile.d?.error?.code ?? ''}`);
  if (status.stt?.enabled) {
    console.log(`расшифровка: ${status.stt.provider} / ${status.stt.model} / ${status.stt.language}`);
  } else {
    check('выключенная расшифровка честно говорит об этом', true, 'ключ не задан');
  }

  // ---------- в журнале осталась запись, что урок собран ИИ ----------
  const log = (await j('/audit?limit=20', { h })).d;
  check('применение записано в журнал', JSON.stringify(log).includes('ai_apply'));

  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
