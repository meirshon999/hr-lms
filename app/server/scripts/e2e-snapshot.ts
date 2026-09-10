import { freshIin } from './_iin.ts';
/* Проверка изоляции снимком: правки каталога НЕ ломают того, кто уже учится.
   Запуск при живом сервере: npx tsx scripts/e2e-snapshot.ts */
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
const results: boolean[] = [];
// `extra` — подробность на случай провала: без неё падение показывает только
// название проверки, и причину приходится искать заново руками.
const check = (name: string, cond: boolean, extra = '') => {
  results.push(cond);
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};

async function main() {
  const hr = (await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } })).d.token;
  const h = { authorization: 'Bearer ' + hr };

  // отдельная должность, чтобы не портить демо
  const sfx = Date.now().toString().slice(-6);
  const pos = (await j('/positions', { method: 'POST', h, body: { name: 'Тест-Снимок ' + sfx } })).d;
  const blk = (await j(`/trajectories/${pos.id}/blocks`, { method: 'POST', h, body: { title: 'Блок А' } })).d;
  const l1 = (await j(`/blocks/${blk.id}/lessons`, { method: 'POST', h, body: { title: 'Урок 1' } })).d;
  const l2 = (await j(`/blocks/${blk.id}/lessons`, { method: 'POST', h, body: { title: 'Урок 2' } })).d;
  for (const l of [l1, l2]) {
    await j(`/lessons/${l.id}/material`, { method: 'PUT', h, body: { content_type: 'text', text_body: 'Текст.' } });
    const t = (await j(`/lessons/${l.id}/test`, { method: 'PUT', h, body: { pass_mark_pct: 70 } })).d;
    await j(`/tests/${t.test_id}/questions`, { method: 'POST', h, body: { text: '2+2?', options: ['4', '5'], correct_index: 0 } });
  }
  let tree = (await j(`/trajectories/${pos.id}`, { h })).d;
  const att = tree.blocks.find((b: any) => b.kind === 'attestation');
  const at = (await j(`/blocks/${att.id}/test`, { method: 'PUT', h, body: { pass_mark_pct: 70 } })).d;
  await j(`/tests/${at.test_id}/questions`, { method: 'POST', h, body: { text: 'Финал?', options: ['да', 'нет'], correct_index: 0 } });
  await j(`/trajectories/${pos.id}/pre-onboarding`, { method: 'POST', h, body: { title: 'О компании', content_type: 'text', text_body: '...' } });
  check('траектория опубликована', (await j(`/trajectories/${pos.id}/publish`, { method: 'POST', h })).s === 200);

  // сотрудник заходит в онбординг → снимок фиксируется
  const emp = (await j('/employees', {
    method: 'POST', h,
    body: { iin: freshIin(), full_name: 'Снимок Тестов', position_id: pos.id, location_id: (await j('/locations', { h })).d.items[0].id, phone: '+7999' + sfx + '1', start_date: new Date().toISOString().slice(0, 10), login: 'snap' + sfx, password: 'snappass1' },
  }));
  if (emp.s !== 201) { console.error('создание сотрудника:', emp.s, JSON.stringify(emp.d)); process.exit(1); }
  const tok = (await j('/auth/login', { method: 'POST', body: { login: 'snap' + sfx, password: 'snappass1' } })).d.token;
  const E = { authorization: 'Bearer ' + tok };
  const pre = (await j('/me/pre-onboarding', { h: E })).d;
  for (const it of pre.items) await j(`/me/pre-onboarding/${it.id}/view`, { method: 'POST', h: E });
  await j(`/employees/${emp.d.employee.id}/internship-passed`, { method: 'POST', h });
  let my = (await j('/me/trajectory', { h: E })).d;
  check('онбординг открыт, 2 урока в снимке', my.progress.total === 2);

  // ---- ЛОМАЕМ живой каталог ----
  tree = (await j(`/trajectories/${pos.id}`, { h })).d;
  const liveL2 = tree.blocks.find((b: any) => b.kind === 'regular').lessons[1];
  const liveL1 = tree.blocks.find((b: any) => b.kind === 'regular').lessons[0];
  await j(`/lessons/${liveL2.id}`, { method: 'DELETE', h });                       // удалили урок 2
  for (const q of liveL1.test.questions) await j(`/questions/${q.id}`, { method: 'DELETE', h }); // выпотрошили тест урока 1
  // Пустой тест — проблема СОДЕРЖИМОГО, а оно считается по каждой точке
  // отдельно: каркас цел, поэтому в problems пусто, а точки перестали быть готовы.
  const broken = (await j(`/trajectories/${pos.id}`, { h })).d;
  check('точки перестали быть готовы после правки каталога',
    broken.locations.every((l: any) => !l.ready),
    broken.locations[0]?.problems?.[0] ?? '');

  // ---- сотрудник должен спокойно доучиться на своём снимке ----
  my = (await j('/me/trajectory', { h: E })).d;
  check('у сотрудника по-прежнему 2 урока', my.progress.total === 2);

  const lessons = my.trajectory.blocks.flatMap((b: any) => b.lessons);
  for (const l of lessons) {
    const detail = (await j(`/me/lessons/${l.id}`, { h: E })).d;
    check(`урок «${detail.title}»: тест из снимка на месте`, (detail.test?.questions?.length ?? 0) > 0);
    await j(`/me/lessons/${l.id}/material-done`, { method: 'POST', h: E });
    const ans = detail.test.questions.map((q: any) => ({ question_id: q.id, option_index: 0 }));
    const r = (await j(`/me/lessons/${l.id}/test`, { method: 'POST', h: E, body: { answers: ans } })).d;
    check(`урок «${detail.title}» сдан на снимке`, r.passed === true);
  }

  const attGet = await j('/me/attestation', { h: E });
  check('аттестация доступна', attGet.s === 200);
  const aAns = attGet.d.questions.map((q: any) => ({ question_id: q.id, option_index: 0 }));
  const ar = (await j('/me/attestation', { method: 'POST', h: E, body: { answers: aAns } })).d;
  check('аттестация сдана, несмотря на сломанный каталог', ar.passed === true);
  check('этап = completed', (await j('/me', { h: E })).d.employee.stage === 'completed');

  // уборка
  await j(`/employees/${emp.d.employee.id}/archive`, { method: 'POST', h });
  console.log(`\n${results.filter(Boolean).length}/${results.length} проверок пройдено`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
main().catch((e) => { console.error('ERR', e?.stack ?? e); process.exit(1); });
