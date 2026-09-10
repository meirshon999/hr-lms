/* План траектории из документа. Проверяет то, что можно проверить без ключа:
   разбор на разделы, защиту каталога до нажатия человека и применение плана.
     npx tsx scripts/e2e-plan.ts                                             */
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

/** Документ с заголовками — то, что приносит кадровик из Word. */
const doc = [
  '# Регламент бармена',
  '',
  '## Открытие бара',
  'Бармен приходит за двадцать минут до открытия, проверяет лёд, посуду и разлив. '
  + 'Кассовый ящик пересчитывается при свидетеле, остаток фиксируется в журнале смены.',
  '',
  '## Приготовление коктейлей',
  'Каждый коктейль готовится строго по карте: отклонения по граммовке недопустимы. '
  + 'Лёд берётся совком, руками лёд не трогают ни при каких обстоятельствах.',
  '',
  '## Работа с гостем у стойки',
  'Гостя за стойкой приветствуют в течение пятнадцати секунд. Если бармен занят, '
  + 'он взглядом показывает, что заметил гостя, и называет срок ожидания в минутах.',
  '',
  '## Закрытие бара',
  'Остатки пересчитываются, бутылки закрываются, разлив промывается. '
  + 'Недостача больше установленного порога фиксируется актом и передаётся менеджеру.',
].join('\n');

async function main() {
  const login = await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } });
  if (login.s !== 200) { console.log('нужен тестовый сервер с LMS_DEV_TOOLS=1'); process.exit(2); }
  h = { authorization: `Bearer ${login.d.token}` };

  const status = (await j('/ai/status', { h })).d;
  const pos = (await j('/positions', { method: 'POST', h, body: { name: `Бармен ${uniq}` } })).d.id;

  // ---------- короткий исходник не годится для целой траектории ----------
  const short = await j(`/ai/trajectories/${pos}/plan`, {
    method: 'POST', h, body: { source_text: 'Бармен приходит за двадцать минут.' },
  });
  check('короткий документ отклоняется с подсказкой',
    short.s === (status.enabled ? 422 : 503),
    `${short.s} ${short.d?.error?.code ?? ''}`);

  if (!status.enabled) {
    check('выключенный ИИ отвечает 503, а не падает', short.s === 503, short.d?.error?.message ?? '');
    console.log('\nключа нет — проверяем только то, что можно без него');
  }

  // ---------- плана ещё нет ----------
  check('без разбора плана нет', (await j(`/ai/trajectories/${pos}/plan`, { h })).s === 404);
  check('применить нечего', (await j(`/ai/trajectories/${pos}/plan/apply`, {
    method: 'POST', h, body: { plan: { blocks: [{ title: 'Б', lessons: [{ title: 'У', sections: [0] }] }] } },
  })).s === 404);

  // ---------- каталог до разбора пуст ----------
  const before = (await j(`/trajectories/${pos}`, { h })).d;
  const regularBefore = before.blocks.filter((b: any) => b.kind === 'regular').length;
  check('новая траектория без обычных блоков', regularBefore === 0, String(regularBefore));

  if (!status.enabled) {
    console.log(failed ? `\n${failed} провалено` : '\nвсе доступные проверки пройдены');
    process.exit(failed ? 1 : 0);
  }

  // ---------- разбор ----------
  const r = await j(`/ai/trajectories/${pos}/plan`, { method: 'POST', h, body: { source_text: doc } });
  check('документ разбирается в план', r.s === 200, JSON.stringify(r.d?.error ?? ''));
  if (r.s !== 200) { process.exit(1); }

  check('разделы найдены по заголовкам', r.d.sections.length >= 4, String(r.d.sections.length));
  check('в разделах есть «Закрытие бара»',
    r.d.sections.some((s: any) => s.title.includes('Закрытие')),
    r.d.sections.map((s: any) => s.title).join(' | '));

  const blocks = r.d.plan.blocks;
  const lessons = blocks.flatMap((b: any) => b.lessons);
  check('план не пустой', blocks.length >= 1 && lessons.length >= 2,
    `${blocks.length} блоков, ${lessons.length} уроков`);
  check('каждый урок опирается на существующие разделы',
    lessons.every((l: any) => l.sections.length > 0
      && l.sections.every((i: number) => i >= 0 && i < r.d.sections.length)),
    JSON.stringify(lessons.map((l: any) => l.sections)));

  // ---------- главное: до нажатия человека каталог не тронут (C-13) ----------
  const during = (await j(`/trajectories/${pos}`, { h })).d;
  check('после разбора каталог всё ещё пуст',
    during.blocks.filter((b: any) => b.kind === 'regular').length === 0,
    String(during.blocks.length));

  check('план сохранился и читается', (await j(`/ai/trajectories/${pos}/plan`, { h })).s === 200);

  // ---------- человек правит дерево, применяется правленое ----------
  // Разделы берём сами, а не те, что выбрала модель: тест не должен зависеть
  // от того, как она в этот раз разложила темы.
  const withText = r.d.sections.filter((s: any) => s.chars > 80).map((s: any) => s.index);
  const edited = {
    blocks: [{
      title: 'Смена бармена',
      lessons: [
        { title: 'Открытие и закрытие', sections: [withText[0], withText[withText.length - 1]] },
        { title: 'Гость у стойки', sections: [withText[1]] },
      ],
    }],
  };
  const ap = await j(`/ai/trajectories/${pos}/plan/apply`, { method: 'POST', h, body: { plan: edited } });
  check('правленый план применяется', ap.s === 200 && ap.d.blocks === 1 && ap.d.lessons === 2,
    JSON.stringify(ap.d));

  const after = (await j(`/trajectories/${pos}`, { h })).d;
  const reg = after.blocks.filter((b: any) => b.kind === 'regular');
  check('в каталоге появился блок с названием человека', reg[0]?.title === 'Смена бармена',
    reg[0]?.title);
  check('уроки названы так, как правил человек',
    reg[0]?.lessons?.map((l: any) => l.title).join(', ') === 'Открытие и закрытие, Гость у стойки',
    reg[0]?.lessons?.map((l: any) => l.title).join(', '));
  check('аттестация осталась последней',
    after.blocks[after.blocks.length - 1]?.kind === 'attestation',
    after.blocks.map((b: any) => b.kind).join(', '));

  // ---------- исходник урока лежит рядом и подставится в сборку ----------
  // Проверяем КАЖДЫЙ урок: пустой исходник — это обещанное поле, в котором
  // ничего нет, и кадровик пойдёт искать абзац в документе руками.
  const sources = await Promise.all(
    reg[0].lessons.map((l: any) => j(`/ai/lessons/${l.id}/source`, { h })),
  );
  check('кусок документа сохранён рядом с каждым уроком',
    sources.every((x) => x.s === 200 && (x.d.source_text ?? '').length > 80),
    sources.map((x) => `${x.s}:${x.d?.source_text?.length ?? 0}`).join(' '));
  check('исходник — из настоящего документа',
    sources.every((x) => /бармен|лёд|смен|остат|гост/i.test(x.d.source_text ?? '')),
    (sources[0].d.source_text ?? '').slice(0, 60));

  // ---------- применённый план больше не висит ----------
  check('после применения план убран', (await j(`/ai/trajectories/${pos}/plan`, { h })).s === 404);

  // ---------- журнал помнит ----------
  const admin = await j('/auth/login', { method: 'POST', body: { login: 'admin', password: 'admin123' } });
  const log = (await j('/audit?limit=30', { h: { authorization: `Bearer ${admin.d.token}` } })).d;
  check('создание из плана записано в журнал', JSON.stringify(log).includes('ai_plan_apply'));

  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
