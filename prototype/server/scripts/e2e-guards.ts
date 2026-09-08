/* Защита от тупиков: сотрудник не должен попадать в состояние, из которого
   невозможно завершить онбординг. Запуск при живом сервере:
     npx tsx scripts/e2e-guards.ts                                          */
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

let hrH: any;
let failed = 0;
function check(name: string, ok: boolean, extra = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
}

/** Полная валидная траектория: пре-онбординг, блок с уроком, тест аттестации. */
async function buildFull(name: string) {
  const pid = (await j('/positions', { method: 'POST', h: hrH, body: { name } })).d.id;
  await j(`/trajectories/${pid}/pre-onboarding`, {
    method: 'POST', h: hrH, body: { title: 'О компании', content_type: 'text', text_body: 'Текст.' },
  });
  const blk = (await j(`/trajectories/${pid}/blocks`, { method: 'POST', h: hrH, body: { title: 'Блок 1' } })).d;
  const les = (await j(`/blocks/${blk.id}/lessons`, { method: 'POST', h: hrH, body: { title: 'Урок 1' } })).d;
  await j(`/lessons/${les.id}/material`, { method: 'PUT', h: hrH, body: { content_type: 'text', text_body: 'Материал.' } });
  const t = (await j(`/lessons/${les.id}/test`, { method: 'PUT', h: hrH, body: { pass_mark_pct: 70 } })).d;
  await j(`/tests/${t.test_id}/questions`, { method: 'POST', h: hrH, body: { text: 'Вопрос?', options: ['А', 'Б'], correct_index: 0 } });
  const att = (await j(`/trajectories/${pid}`, { h: hrH })).d.blocks.find((b: any) => b.kind === 'attestation');
  const at = (await j(`/blocks/${att.id}/test`, { method: 'PUT', h: hrH, body: { pass_mark_pct: 70 } })).d;
  await j(`/tests/${at.test_id}/questions`, { method: 'POST', h: hrH, body: { text: 'Аттестация?', options: ['А', 'Б'], correct_index: 0 } });
  return { pid, lessonId: les.id };
}

async function hire(pid: string, login: string, name: string, phone: string) {
  const r = await j('/employees', {
    method: 'POST', h: hrH,
    body: {
      full_name: name, position_id: pid, phone,
      start_date: new Date().toISOString().slice(0, 10), login, password: login + 'pass',
    },
  });
  return { id: r.d.employee.id, warnings: r.d.warnings as string[] };
}

async function passPre(login: string) {
  const tok = (await j('/auth/login', { method: 'POST', body: { login, password: login + 'pass' } })).d.token;
  const h = { authorization: 'Bearer ' + tok };
  for (const it of (await j('/me/pre-onboarding', { h })).d.items) {
    await j(`/me/pre-onboarding/${it.id}/view`, { method: 'POST', h });
  }
  return h;
}

async function main() {
  hrH = { authorization: 'Bearer ' + (await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } })).d.token };

  // --- A. Правка, ломающая активную траекторию, снимает её с публикации ---
  console.log('\nA. Сломанная правкой траектория не должна оставаться активной');
  const a = await buildFull('ГвардияA' + uniq);
  const pubA = await j(`/trajectories/${a.pid}/publish`, { method: 'POST', h: hrH });
  check('траектория публикуется', pubA.s === 200 && pubA.d.status === 'active');

  await j(`/lessons/${a.lessonId}`, { method: 'DELETE', h: hrH }); // единственный урок
  const treeA = (await j(`/trajectories/${a.pid}`, { h: hrH })).d;
  check('после удаления единственного урока траектория снята с публикации',
    treeA.status === 'draft', `статус ${treeA.status}`);

  const e1 = await hire(a.pid, 'ga' + uniq, 'Гвардия А', '+7999' + uniq + '1');
  check('найм на сломанную траекторию предупреждает',
    e1.warnings.includes('no_active_trajectory'), JSON.stringify(e1.warnings));
  await passPre('ga' + uniq);
  const ipA = await j(`/employees/${e1.id}/internship-passed`, { method: 'POST', h: hrH });
  check('онбординг не открывается на сломанной траектории', ipA.d.onboarding_opened === false);
  const cardA = (await j(`/employees/${e1.id}`, { h: hrH })).d;
  check('сотрудник ждёт стажёром, а не застревает с пустым снимком',
    cardA.stage === 'intern', `этап ${cardA.stage}`);

  // --- B. Публикация открывает онбординг тем, кто прошёл оба гейта ---
  console.log('\nB. Публикация догоняет ждущих стажёров');
  const b = await buildFull('ГвардияB' + uniq); // остаётся черновиком
  const e2 = await hire(b.pid, 'gb' + uniq, 'Гвардия Б', '+7999' + uniq + '2');
  check('найм на черновик предупреждает', e2.warnings.includes('no_active_trajectory'));
  await passPre('gb' + uniq);
  const ipB = await j(`/employees/${e2.id}/internship-passed`, { method: 'POST', h: hrH });
  check('оба гейта пройдены, но открывать нечего', ipB.d.onboarding_opened === false
    && ipB.d.reason === 'no_active_trajectory');

  const pubB = await j(`/trajectories/${b.pid}/publish`, { method: 'POST', h: hrH });
  check('публикация сообщает, скольким открыла онбординг', pubB.d.onboarding_opened === 1,
    `открыто ${pubB.d.onboarding_opened}`);
  const cardB = (await j(`/employees/${e2.id}`, { h: hrH })).d;
  check('ждавший стажёр переведён в онбординг', cardB.stage === 'onboarding', `этап ${cardB.stage}`);

  // --- C. Восстановление сломанной траектории возвращает застрявшего в строй ---
  console.log('\nC. Починка траектории догоняет того, кто ждал из-за поломки');
  const blk = (await j(`/trajectories/${a.pid}/blocks`, { method: 'POST', h: hrH, body: { title: 'Новый блок' } })).d;
  const les = (await j(`/blocks/${blk.id}/lessons`, { method: 'POST', h: hrH, body: { title: 'Новый урок' } })).d;
  await j(`/lessons/${les.id}/material`, { method: 'PUT', h: hrH, body: { content_type: 'text', text_body: 'Материал.' } });
  const t2 = (await j(`/lessons/${les.id}/test`, { method: 'PUT', h: hrH, body: { pass_mark_pct: 70 } })).d;
  await j(`/tests/${t2.test_id}/questions`, { method: 'POST', h: hrH, body: { text: 'Вопрос?', options: ['А', 'Б'], correct_index: 0 } });
  const rePub = await j(`/trajectories/${a.pid}/publish`, { method: 'POST', h: hrH });
  check('починенная траектория публикуется', rePub.s === 200 && rePub.d.status === 'active');
  const cardA2 = (await j(`/employees/${e1.id}`, { h: hrH })).d;
  check('ждавший из-за поломки переведён в онбординг', cardA2.stage === 'onboarding', `этап ${cardA2.stage}`);

  // уборка
  for (const id of [e1.id, e2.id]) await j(`/employees/${id}/archive`, { method: 'POST', h: hrH });
  console.log(failed ? `\n${failed} проверок провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e?.stack ?? e); process.exit(1); });
