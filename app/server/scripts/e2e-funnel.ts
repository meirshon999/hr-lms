import { testIin } from './_iin.ts';
/* Воронка по должностям. Проверяет ровно то, чего прежняя не умела:
   видит потери, не занижает цифры при разном наполнении точек и режется
   по точке.
     npx tsx scripts/e2e-funnel.ts                                          */
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

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

let h: any;
let serial = 700;

/** Материал и тест уроку: без содержимого точка не готова и онбординг не откроется. */
async function fill(lessonId: string) {
  await j(`/lessons/${lessonId}/material`, {
    method: 'PUT', h,
    body: { content_type: 'text', text_body: 'Смена начинается за пятнадцать минут до открытия зала.' },
  });
  // Вопросы вешаются на тест, а не на урок: у блока тоже бывает тест (аттестация),
  // и адрес у них общий.
  const testId = (await j(`/lessons/${lessonId}/test`, {
    method: 'PUT', h, body: { pass_mark_pct: 50 },
  })).d.test_id;
  await j(`/tests/${testId}/questions`, {
    method: 'POST', h,
    body: { text: 'За сколько минут приходить?', options: ['За пятнадцать', 'Когда получится'], correct_index: 0 },
  });
}

/** Заводит человека и возвращает его id и заголовок для входа. */
async function hire(posId: string, locId: string) {
  const login = `f${uniq}${serial}`;
  const r = await j('/employees', {
    method: 'POST', h,
    body: {
      iin: testIin(serial++), full_name: `Воронкин ${serial}`, position_id: posId,
      location_id: locId, phone: '+7700' + uniq, start_date: new Date().toISOString().slice(0, 10),
      login, password: 'secret123',
    },
  });
  if (r.s !== 201) throw new Error('не нанялся: ' + JSON.stringify(r.d));
  const tok = (await j('/auth/login', { method: 'POST', body: { login, password: 'secret123' } })).d.token;
  return { id: r.d.employee.id, h: { authorization: `Bearer ${tok}` } };
}

/**
 * Проходит пре-онбординг и открывает онбординг.
 *
 * Если открыть не удалось, сценарий дальше бессмыслен, а причина у системы
 * есть — печатаем её и останавливаемся, вместо падения на пустом ответе.
 */
async function startLearning(emp: { id: string; h: any }) {
  const pre = (await j('/me/pre-onboarding', { h: emp.h })).d;
  for (const it of pre.items ?? []) {
    await j(`/me/pre-onboarding/${it.id}/view`, { method: 'POST', h: emp.h });
  }
  const r = (await j(`/employees/${emp.id}/internship-passed`, { method: 'POST', h })).d;
  if (!r?.onboarding_opened) {
    console.log('FAIL онбординг не открылся — ' + (r?.reason ?? JSON.stringify(r)));
    process.exit(1);
  }
  return r;
}

/** Проходит все доступные уроки своей траектории. */
async function passAll(emp: { h: any }) {
  const tr = (await j('/me/trajectory', { h: emp.h })).d;
  // В траектории сотрудника аттестации среди блоков нет — она отдельным полем.
  for (const b of tr.trajectory.blocks) {
    for (const l of b.lessons) {
      await j(`/me/lessons/${l.id}/material-done`, { method: 'POST', h: emp.h });
      const full = (await j(`/me/lessons/${l.id}`, { h: emp.h })).d;
      const answers = (full?.test?.questions ?? []).map((q: any) => ({ question_id: q.id, option_index: 0 }));
      await j(`/me/lessons/${l.id}/test`, { method: 'POST', h: emp.h, body: { answers } });
    }
  }
}

const stepOf = (f: any, title: string) => f.steps.find((s: any) => s.title === title);

async function main() {
  const login = await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } });
  if (login.s !== 200) { console.log('нужен тестовый сервер с LMS_DEV_TOOLS=1'); process.exit(2); }
  h = { authorization: `Bearer ${login.d.token}` };

  const locs = (await j('/locations', { h })).d.items;
  const [A, Bl] = locs;

  // ---------- каркас: общий блок и блок только для точки А ----------
  const pos = (await j('/positions', { method: 'POST', h, body: { name: `Воронка ${uniq}` } })).d.id;
  const b1 = (await j(`/trajectories/${pos}/blocks`, { method: 'POST', h, body: { title: 'Общий блок' } })).d;
  const b2 = (await j(`/trajectories/${pos}/blocks`, { method: 'POST', h, body: { title: 'Только на А' } })).d;

  const l1 = (await j(`/blocks/${b1.id}/lessons`, { method: 'POST', h, body: { title: 'Стандарты' } })).d;
  const l2 = (await j(`/blocks/${b2.id}/lessons`, {
    method: 'POST', h, body: { title: 'Боулинг', everywhere: false, locations: [A.id] },
  })).d;
  await fill(l1.id);
  await fill(l2.id);

  // Аттестация появляется у траектории сама, но тест ей задаёт человек.
  // Без него точка не готова, и онбординг не откроется — это правило C-11.
  const tree = (await j(`/trajectories/${pos}?location=${A.id}`, { h })).d;
  const att = tree.blocks.find((b: any) => b.kind === 'attestation');
  const attTest = (await j(`/blocks/${att.id}/test`, {
    method: 'PUT', h, body: { pass_mark_pct: 50 },
  })).d.test_id;
  await j(`/tests/${attTest}/questions`, {
    method: 'POST', h,
    body: { text: 'Итог: за сколько приходить?', options: ['За пятнадцать', 'Когда получится'], correct_index: 0 },
  });

  const pub = await j(`/trajectories/${pos}/publish`, { method: 'POST', h });
  check('траектория публикуется', pub.s === 200, JSON.stringify(pub.d?.error ?? ''));

  // ---------- люди ----------
  // Дошёл до конца обучения на точке А, где есть оба блока.
  const done = await hire(pos, A.id);
  await startLearning(done);
  await passAll(done);

  // Начал и застрял на первом же блоке.
  const stuck = await hire(pos, A.id);
  await startLearning(stuck);

  // На точке Б, где второго блока нет вовсе.
  const atB = await hire(pos, Bl.id);
  await startLearning(atB);
  await passAll(atB);

  // Ушёл, не начав учиться, — та самая потеря, которой раньше не было видно.
  const gone = await hire(pos, A.id);
  await j(`/employees/${gone.id}/archive`, { method: 'POST', h, body: { reason: 'не вышел' } });

  // ---------- воронка по всей сети ----------
  const all = (await j('/analytics', { h })).d.funnel;
  const f = all.find((x: any) => x.position.startsWith('Воронка'));
  check('должность попала в воронку', !!f, all.map((x: any) => x.position).join(', '));

  check('в когорте все четверо, включая архивного', f.cohort === 4, String(f?.cohort));

  const hired = stepOf(f, 'Принят');
  check('ушедший до обучения виден как потеря', hired.lost === 1,
    `дошли ${hired.reached}, сейчас ${hired.now}, ушли ${hired.lost}`);

  const started = stepOf(f, 'Начал обучение');
  check('начали учиться трое', started.reached === 3,
    `дошли ${started.reached} из ${started.applicable}`);

  // Застрявший стоит именно на ступени «начал обучение»: он открыл онбординг,
  // но не закрыл ни одного блока.
  check('застрявший виден на своей ступени', started.now === 1, `сейчас ${started.now}`);

  const common = stepOf(f, 'Общий блок');
  // Ушедший до обучения снимка не имеет, поэтому блок к нему и не применим:
  // измерять человека блоком, до которого он не дожил, нечестно.
  check('общий блок применим к троим начавшим', common.applicable === 3, String(common.applicable));
  check('общий блок прошли двое', common.reached === 2,
    `дошли ${common.reached}, сейчас ${common.now}`);

  const onlyA = stepOf(f, 'Только на А');
  check('блок точки А применим не ко всем', onlyA.applicable < f.cohort,
    `применим к ${onlyA.applicable} из ${f.cohort}`);
  check('человека с точки Б этот блок не считает провалившим',
    onlyA.applicable === 2, `применим к ${onlyA.applicable}`);
  // И не приписывает себе чужие успехи: сотрудник точки Б этот блок
  // не проходил, потому что у него его нет.
  check('блок точки А не считает чужих дошедшими', onlyA.reached === 1,
    `дошли ${onlyA.reached} из ${onlyA.applicable}`);

  check('срок ступени считается в днях, а не в пустоте',
    started.avg_days === null || typeof started.avg_days === 'number', String(started.avg_days));

  // ---------- воронка по одной точке ----------
  const onlyBl = (await j(`/analytics?location=${Bl.id}`, { h })).d.funnel
    .find((x: any) => x.position.startsWith('Воронка'));
  check('разрез по точке отсекает чужих', onlyBl.cohort === 1, String(onlyBl?.cohort));
  check('на точке Б блока «только на А» нет ни у кого',
    stepOf(onlyBl, 'Только на А').applicable === 0,
    String(stepOf(onlyBl, 'Только на А')?.applicable));

  // ---------- ступени не растут по ходу воронки ----------
  const seq = f.steps.map((s: any) => s.reached);
  check('воронка сужается, а не расширяется',
    seq.every((v: number, i: number) => i === 0 || v <= seq[i - 1]), seq.join(' → '));

  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
