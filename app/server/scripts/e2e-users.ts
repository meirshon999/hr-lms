/* Разделение ролей и аккаунты служебных людей. Запуск при живом сервере:
     npx tsx scripts/e2e-users.ts                                           */
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

const token = async (login: string, password: string) =>
  (await j('/auth/login', { method: 'POST', body: { login, password } })).d?.token;

async function main() {
  const admT = await token('admin', 'admin123');
  const hrT = await token('hr', 'hr123');
  if (!admT || !hrT) { console.log('нужен тестовый сервер с LMS_DEV_TOOLS=1'); process.exit(2); }
  const adm = { authorization: `Bearer ${admT}` };
  const hr = { authorization: `Bearer ${hrT}` };

  // ---------- кадровику доступов администратора не выдано ----------
  check('кадровик не видит список аккаунтов', (await j('/users', { h: hr })).s === 403);
  check('кадровик не видит журнал действий', (await j('/audit', { h: hr })).s === 403);
  check('кадровик не может завести аккаунт',
    (await j('/users', { method: 'POST', h: hr, body: { login: `x${uniq}`, role: 'hr' } })).s === 403);
  check('без входа список аккаунтов недоступен', (await j('/users')).s === 401);

  // ---------- администратор ----------
  const list = await j('/users', { h: adm });
  check('администратор видит список', list.s === 200 && list.d.items.length >= 2,
    String(list.d?.items?.length));
  check('в списке нет учёток сотрудников',
    !list.d.items.some((u: any) => u.role === 'employee'));
  check('журнал действий администратору доступен', (await j('/audit', { h: adm })).s === 200);

  // ---------- заводим кадровика ----------
  const login = `hr.astana${uniq}`;
  const made = await j('/users', { method: 'POST', h: adm, body: { login, role: 'hr' } });
  check('аккаунт создаётся', made.s === 201 && !!made.d.password, JSON.stringify(made.d?.error ?? ''));

  const dup = await j('/users', { method: 'POST', h: adm, body: { login, role: 'hr' } });
  check('занятый логин отклоняется', dup.s === 422);

  const bad = await j('/users', { method: 'POST', h: adm, body: { login: 'плохой логин', role: 'hr' } });
  check('логин не латиницей отклоняется', bad.s === 400, String(bad.s));

  // ---------- новый кадровик работает и обязан сменить пароль ----------
  const first = await j('/auth/login', { method: 'POST', body: { login, password: made.d.password } });
  check('новый аккаунт входит', first.s === 200);
  check('пароль помечен временным', first.d?.must_change_password === true);
  check('роль кадровика', first.d?.role === 'hr');
  const newH = { authorization: `Bearer ${first.d.token}` };
  check('новый кадровик тоже не лезет в аккаунты', (await j('/users', { h: newH })).s === 403);

  // ---------- защита от запертой двери ----------
  const me = list.d.items.find((u: any) => u.login === 'admin');
  const self = await j(`/users/${me.id}`, { method: 'PATCH', h: adm, body: { is_active: false } });
  check('свой аккаунт отключить нельзя', self.s === 422 && self.d?.error?.code === 'self_disable',
    `${self.s} ${self.d?.error?.code ?? ''}`);

  // ---------- отключение ----------
  const created = (await j('/users', { h: adm })).d.items.find((u: any) => u.login === login);
  check('отключение проходит',
    (await j(`/users/${created.id}`, { method: 'PATCH', h: adm, body: { is_active: false } })).s === 200);
  const denied = await j('/auth/login', { method: 'POST', body: { login, password: made.d.password } });
  check('отключённый аккаунт не входит', denied.s === 401, String(denied.s));

  check('включение обратно проходит',
    (await j(`/users/${created.id}`, { method: 'PATCH', h: adm, body: { is_active: true } })).s === 200);

  // ---------- сброс пароля ----------
  const reset = await j(`/users/${created.id}/reset-password`, { method: 'POST', h: adm });
  check('пароль сбрасывается', reset.s === 200 && !!reset.d.password);
  check('старый пароль больше не работает',
    (await j('/auth/login', { method: 'POST', body: { login, password: made.d.password } })).s === 401);
  check('новый пароль работает',
    (await j('/auth/login', { method: 'POST', body: { login, password: reset.d.password } })).s === 200);

  // ---------- последний администратор ----------
  const second = await j('/users', { method: 'POST', h: adm, body: { login: `adm${uniq}`, role: 'admin' } });
  check('второй администратор заводится', second.s === 201);
  const secId = (await j('/users', { h: adm })).d.items.find((u: any) => u.login === `adm${uniq}`).id;
  check('пока администраторов двое, одного отключить можно',
    (await j(`/users/${secId}`, { method: 'PATCH', h: adm, body: { is_active: false } })).s === 200);

  // Теперь активный администратор остался один — им же и проверяем запрет.
  const secToken = await token(`adm${uniq}`, second.d.password);
  check('отключённый администратор не входит', !secToken);

  // ---------- журнал помнит, кто что сделал ----------
  const log = (await j('/audit?limit=50', { h: adm })).d;
  check('заведение аккаунта записано в журнал', JSON.stringify(log).includes('user_create'));
  check('отключение записано в журнал', JSON.stringify(log).includes('user_disable'));

  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
