/* Кадровые действия HR: возврат из архива, продление срока, пауза онбординга.
   Запуск при живом сервере: npx tsx scripts/e2e-hr-actions.ts                 */
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

let h: any;
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const card = async (id: string) => (await j(`/employees/${id}`, { h })).d;
const setDay = async (d: string) => {
  const r = await j('/dev/clock', { method: 'POST', h, body: { date: d } });
  if (r.d?.today !== d) throw new Error(`часы не перемотались на ${d}: ${JSON.stringify(r.d)}`);
};
const byName = async (re: RegExp) => {
  const rows = (await j('/employees?include_archived=1&limit=500', { h })).d.items;
  return rows.find((x: any) => re.test(x.full_name));
};

async function main() {
  h = { authorization: 'Bearer ' + (await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } })).d.token };
  const startToday = (await j('/dev/clock', { h })).d.today;

  // ---- 1. Возврат из архива ----
  console.log('\n1. Возврат из архива');
  const done = await byName(/Света|Светлана/); // завершила онбординг
  check('нашёлся завершивший сотрудник', !!done, done?.full_name);
  await j(`/employees/${done.id}/archive`, { method: 'POST', h });
  let c = await card(done.id);
  check('архивирован', c.stage === 'archived', `этап ${c.stage}`);

  const login = c.login;
  const badLogin = await j('/auth/login', { method: 'POST', body: { login, password: login + '123' } });
  check('архивный не может войти', badLogin.s !== 200, `HTTP ${badLogin.s}`);

  const un = await j(`/employees/${done.id}/unarchive`, { method: 'POST', h });
  c = await card(done.id);
  check('возвращён на прежний этап, а не в стажёры', c.stage === 'completed', `этап ${c.stage} (ответ ${un.d.stage})`);
  check('архивная дата очищена', c.archived_at === null);
  const okLogin = await j('/auth/login', { method: 'POST', body: { login, password: login + '123' } });
  check('вход снова работает', okLogin.s === 200);
  check('прогресс обучения на месте', (c.blocks ?? []).some((b: any) => b.lessons.some((l: any) => l.status === 'passed')));
  const un2 = await j(`/employees/${done.id}/unarchive`, { method: 'POST', h });
  check('повторный возврат отклоняется', un2.s === 409, `HTTP ${un2.s}`);

  // ---- 2. Продление срока ----
  console.log('\n2. Продление срока');
  const learner = await byName(/Ольга/);
  const before = (await card(learner.id)).onboarding_due_date;
  const ext = await j(`/employees/${learner.id}/extend-deadline`, { method: 'POST', h, body: { days: 7 } });
  const after = (await card(learner.id)).onboarding_due_date;
  const diff = Math.round((Date.parse(after) - Date.parse(before)) / 86_400_000);
  check('срок сдвинулся ровно на 7 дней', diff === 7, `${before} → ${after}`);
  check('ответ вернул новую дату', ext.d.onboarding_due_date === after);
  const bad = await j(`/employees/${learner.id}/extend-deadline`, { method: 'POST', h, body: { days: 0 } });
  check('нулевое продление отклоняется', bad.s === 400, `HTTP ${bad.s}`);
  const notOnb = await j(`/employees/${done.id}/extend-deadline`, { method: 'POST', h, body: { days: 3 } });
  check('продлить завершившему нельзя', notOnb.s === 409, `HTTP ${notOnb.s}`);

  // ---- 3. Пауза ----
  console.log('\n3. Пауза онбординга');
  const overdue = await byName(/Дмитрий|Роман|Артём/) ?? learner;
  // загоняем в просрочку
  const due = (await card(overdue.id)).onboarding_due_date;
  await setDay(new Date(Date.parse(due) + 3 * 86_400_000).toISOString().slice(0, 10));
  check('до паузы сотрудник просрочен', (await card(overdue.id)).overdue === true);

  const pz = await j(`/employees/${overdue.id}/pause`, { method: 'POST', h });
  check('пауза поставлена', pz.s === 200);
  let cp = await card(overdue.id);
  check('на паузе просрочка не считается', cp.overdue === false);
  check('дата паузы видна в карточке', !!cp.paused_at, String(cp.paused_at));
  const dbl = await j(`/employees/${overdue.id}/pause`, { method: 'POST', h });
  check('повторная пауза отклоняется', dbl.s === 409, `HTTP ${dbl.s}`);

  const dueBefore = cp.onboarding_due_date;
  const pausedOn = cp.paused_at;
  await setDay(new Date(Date.parse(pausedOn) + 10 * 86_400_000).toISOString().slice(0, 10));
  const rs = await j(`/employees/${overdue.id}/resume`, { method: 'POST', h });
  cp = await card(overdue.id);
  const shift = Math.round((Date.parse(cp.onboarding_due_date) - Date.parse(dueBefore)) / 86_400_000);
  check('срок сдвинут ровно на длительность паузы', shift === 10, `сдвиг ${shift}, пауза ${rs.d.paused_days}`);
  check('пауза снята', cp.paused_at === null);
  const rs2 = await j(`/employees/${overdue.id}/resume`, { method: 'POST', h });
  check('повторное снятие отклоняется', rs2.s === 409, `HTTP ${rs2.s}`);

  // ---- 4. Ссылка-приглашение ----
  console.log('\n4. Ссылка-приглашение');
  const some = await byName(/Света|Светлана/);
  const inv = await j(`/employees/${some.id}/invite`, { method: 'POST', h });
  check('приглашение выдаётся', inv.s === 200 && /#\/invite\//.test(inv.d?.invite_url ?? ''),
    inv.d?.invite_url ?? '');
  check('сказано, сколько оно живёт', inv.d?.hours > 0 && !!inv.d?.expires_at,
    `${inv.d?.hours} ч`);

  const token = String(inv.d.invite_url).split('/invite/')[1];
  // Вход по ссылке — единственный способ попасть внутрь без пароля, поэтому
  // проверяем и то, что он работает, и то, что работает ровно один раз.
  const enter = await j(`/auth/invite/${token}`, { method: 'POST' });
  check('по ссылке пускают внутрь', enter.s === 200 && !!enter.d?.token, String(enter.s));
  check('и сразу требуют задать свой пароль', enter.d?.must_change_password === true);

  const again = await j(`/auth/invite/${token}`, { method: 'POST' });
  check('второй раз та же ссылка не работает', again.s === 410, String(again.s));
  check('в отказе сказано, что делать', /кадровик/i.test(again.d?.error?.message ?? ''),
    again.d?.error?.message ?? '');

  check('выдуманная ссылка не работает',
    (await j('/auth/invite/нетакоготокена', { method: 'POST' })).s === 410);

  const first = await j(`/employees/${some.id}/invite`, { method: 'POST', h });
  const second = await j(`/employees/${some.id}/invite`, { method: 'POST', h });
  const t1 = String(first.d.invite_url).split('/invite/')[1];
  check('новое приглашение гасит прежнее',
    (await j(`/auth/invite/${t1}`, { method: 'POST' })).s === 410);
  check('а новое работает',
    (await j(`/auth/invite/${String(second.d.invite_url).split('/invite/')[1]}`, { method: 'POST' })).s === 200);

  // ---- 5. Постраничная выдача ----
  console.log('\n5. Постраничная выдача');
  const page = await j('/employees?limit=2', { h });
  check('страница обрезана по limit', page.d?.items?.length === 2, String(page.d?.items?.length));
  check('всего известно сколько', page.d?.total > 2, String(page.d?.total));
  const next = await j('/employees?limit=2&offset=2', { h });
  check('вторая страница — другие люди',
    next.d.items[0]?.id !== page.d.items[0]?.id
    && next.d.items[0]?.id !== page.d.items[1]?.id);
  check('отбор считается по всему списку, а не по странице',
    (await j('/employees?limit=1&stage=completed', { h })).d.total
      === (await j('/employees?stage=completed&limit=500', { h })).d.items.length);

  // ---- уборка ----
  await setDay(startToday);
  await j('/dev/reset', { method: 'POST', h });
  console.log(failed ? `\n${failed} проверок провалено` : '\nвсе проверки пройдены, демо сброшено');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e?.stack ?? e); process.exit(1); });
