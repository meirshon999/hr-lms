// Сквозной аудит: все экраны всех ролей, ошибки консоли и сети, ключевые формы.
import { writeFileSync, mkdirSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';

const APP = process.env.APP ?? 'http://localhost:3001';
const OUT = process.env.OUT;
if (OUT) mkdirSync(OUT, { recursive: true });
const P = Number(process.env.CDP ?? 9342);
const NL = String.fromCharCode(10);
const log = (m) => writeSync(1, m + NL);
let step = 'start';
const at = (s) => { step = s; log(NL + '## ' + s); };
setTimeout(() => { log('ЗАВИС на: ' + step); process.exit(2); }, 280000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const api = async (p, o = {}) => {
  const r = await fetch(APP + '/api/v1' + p, {
    method: o.method ?? 'GET',
    headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.h ?? {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};

const ch = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  [`--remote-debugging-port=${P}`, '--headless=new', '--disable-gpu', '--no-first-run',
   '--user-data-dir=' + process.env.TEMP + '\\cdp-audit', 'about:blank'], { stdio: 'ignore' });
let v; for (let i = 0; i < 60; i++) { await sleep(500); try { v = await (await fetch(`http://localhost:${P}/json/version`)).json(); break; } catch { /* браузер ещё поднимается — пробуем снова */ } }
const ws = new WebSocket(v.webSocketDebuggerUrl); let id = 0; const pend = new Map();
const evs = [];
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
  } else if (m.method) evs.push(m);
});
const send = (m, params = {}, sid) => new Promise((res, rej) => {
  const n = ++id; pend.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method: m, params, ...(sid ? { sessionId: sid } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');

const metrics = (w, h, mob) => S('Emulation.setDeviceMetricsOverride',
  { width: w, height: h, deviceScaleFactor: 1, mobile: mob, screenWidth: w, screenHeight: h });
const ev = async (x) => {
  const r = await S('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const txt = () => ev('document.body.innerText');
const shot = async (n) => {
  if (!OUT) return;
  const { data } = await S('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${n}.png`, Buffer.from(data, 'base64'));
};
const clickText = (t) => ev(`(()=>{const e=[...document.querySelectorAll('button,a')].find(x=>x.innerText.trim()===${JSON.stringify(t)});if(!e)return false;e.click();return true;})()`);
const waitFor = async (re, ms = 8000) => {
  const u = Date.now() + ms; let t = await txt();
  while (!re.test(t) && Date.now() < u) { await sleep(300); t = await txt(); }
  return t;
};

let bad = 0;
const problems = [];
const check = (n, ok, x = '') => {
  if (!ok) { bad++; problems.push(n + (x ? ' — ' + x : '')); }
  log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`);
};

// ---- сбор ошибок страницы ----
function drain(label) {
  const errs = [];
  for (const m of evs.splice(0)) {
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push('исключение: ' + (m.params.exceptionDetails?.exception?.description
        ?? m.params.exceptionDetails?.text ?? '').split(NL)[0]);
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(m.params.type)) {
      errs.push('console.error: ' + (m.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const t = m.params.entry.text ?? '';
      if (!/favicon/i.test(t)) errs.push('лог: ' + t.slice(0, 160));
    }
    if (m.method === 'Network.responseReceived') {
      const { status, url } = m.params.response;
      if (status >= 400 && !/favicon/.test(url)) errs.push(`сеть ${status}: ${url.replace(APP, '')}`);
    }
  }
  const uniq = [...new Set(errs)];
  check(`${label}: без ошибок консоли и сети`, uniq.length === 0, uniq.slice(0, 3).join(' | '));
}

/**
 * Входа по токену в адресной строке больше нет — это была дыра. Кладём токен
 * туда же, куда его кладёт обычный вход, и перезагружаем страницу.
 */
const go = async (u, w = 2200) => {
  evs.splice(0);
  const m = /[?&]t=([^#&]+)/.exec(u);
  if (m) {
    u = u.replace(/[?&]t=[^#&]+/, '');
    await S('Page.navigate', { url: APP + '/' });
    await sleep(500);
    await ev(`localStorage.setItem('lms_token', ${JSON.stringify(m[1])})`);
    // Смена одного лишь хэша приложение не перезагружает — оно осталось бы под
    // прежним пользователем. Поэтому переходим и принудительно перезагружаем.
    await S('Page.navigate', { url: u });
    await sleep(200);
    evs.splice(0);
    await S('Page.reload', {});
    await sleep(w);
    await ev('window.confirm=()=>true');
    return;
  }
  await S('Page.navigate', { url: u });
  await sleep(w);
  await ev('window.confirm=()=>true');
};

// ================= HR =================
const hr = (await api('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } })).d.token;
const H = { authorization: 'Bearer ' + hr };
await metrics(1440, 900, false);

at('HR — Обзор');
await go(`${APP}/?t=${hr}#/hr/overview`);
let t = await txt();
check('заголовок и сводка на месте', /Обзор/i.test(t) && /Стажировка/i.test(t));
check('воронка отрисована', /Воронка по должностям/.test(t));
drain('Обзор');

at('HR — Сотрудники');
await go(`${APP}/?t=${hr}#/hr/employees`);
t = await txt();
check('список сотрудников', /Сотрудники/.test(t));
const rows = await ev(`document.querySelectorAll('table.grid tbody tr').length`);
check('строки таблицы есть', rows > 0, `строк ${rows}`);
drain('Сотрудники');

at('HR — форма добавления сотрудника');
check('кнопка добавления есть', await clickText('+ Добавить сотрудника'));
await sleep(1500);
const opts = await ev(`(()=>{const s=document.querySelectorAll('.modal select');
  if(!s.length) return {селектов:0};
  const first=[...s[0].options].map(o=>o.text);
  return {селектов:s.length, варианты:first};})()`);
check('в форме есть выпадающий список должностей', (opts.селектов ?? 0) > 0, JSON.stringify(opts));
check('должности подгрузились в список',
  (opts.варианты ?? []).filter(x => x !== '—').length > 0, JSON.stringify(opts.варианты));
const fields = await ev(`JSON.stringify([...document.querySelectorAll('.modal .field span')].map(s=>s.innerText))`);
check('поля формы на месте', /ФИО/.test(fields) && /Должность/.test(fields) && /Логин/.test(fields), fields);
await shot('24-hr-add-employee');
drain('форма добавления');

at('HR — создание сотрудника целиком');
const uniq = Date.now().toString().slice(-6);
// ИИН обязателен и проверяется по контрольной сумме — подставляем настоящий.
const auditIin = (() => {
  const mk = (n) => {
    const base = `9${n % 10}0315` + '3' + String(10000 + (n % 9000)).slice(1);
    const d = [...base].map(Number);
    const w1 = [1,2,3,4,5,6,7,8,9,10,11], w2 = [3,4,5,6,7,8,9,10,11,1,2];
    const s = (w) => w.reduce((a,k,i) => a + d[i]*k, 0) % 11;
    let c = s(w1); if (c === 10) c = s(w2);
    return c === 10 ? null : base + c;
  };
  for (let n = Number(uniq) % 8000; ; n += 7) { const v = mk(n); if (v) return v; }
})();
await ev(`(()=>{
  const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;p.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
  const pick=(sel)=>{const real=[...sel.options].find(o=>o.value);
    if(real){sel.value=real.value;sel.dispatchEvent(new Event('change',{bubbles:true}));}};
  const inp=[...document.querySelectorAll('.modal input')];
  const sels=[...document.querySelectorAll('.modal select')];
  set(inp[0],'${auditIin}');          // ИИН
  set(inp[1],'Тест Аудитов');         // ФИО
  sels.forEach(pick);                 // должность и точка
  set(inp[2],'+7999${uniq}');         // телефон
  set(inp[4],'aud${uniq}');           // логин
  set(inp[5],'aud${uniq}pass');       // временный пароль
  return true;})()`);
await sleep(400);
check('кнопка «Добавить» в форме', await clickText('Добавить'));
await sleep(2000);
const created = (await api('/employees', { h: H })).d.items.find(e => /Тест Аудитов/.test(e.full_name));
check('сотрудник действительно создался', !!created, created ? created.position : 'не найден');
drain('создание сотрудника');

at('HR — карточка сотрудника');
if (created) {
  await go(`${APP}/?t=${hr}#/hr/employees/${created.id}`);
  t = await txt();
  check('карточка открылась', /Тест Аудитов/.test(t));
  check('кнопка стажировки есть', /Стажировка пройдена/.test(t));
  check('кнопка доступа есть', /Доступ сотрудника/.test(t));
  check('кнопка архива есть', /В архив/.test(t));
  await shot('25-hr-card-new');
  drain('карточка');
}

at('HR — Конструктор');
const posList = (await api('/positions', { h: H })).d.items;
const waiterPos = posList.find(p => /Официант/.test(p.name));
await go(`${APP}/?t=${hr}#/hr/constructor/${waiterPos.id}`, 2600);
t = await txt();
check('конструктор открылся', /Конструктор|Траектория/.test(t));
check('видны блоки и уроки', /Пре-онбординг/.test(t));
check('есть выбор должности', /Официант/.test(t) && /Кассир/.test(t));
check('есть предпросмотр', /Предпросмотр/.test(t));
const pickers = await ev(`document.querySelectorAll('.filepick').length`);
check('в пре-онбординге появился выбор файла', pickers > 0, `блоков выбора: ${pickers}`);
await shot('26-hr-constructor');
drain('конструктор');

at('HR — форма добавления на телефоне');
await metrics(390, 844, true);
await go(`${APP}/?t=${hr}#/hr/employees`);
check('на телефоне есть кнопка добавления', await clickText('+ Добавить сотрудника'));
await sleep(1500);
const mopts = await ev(`(()=>{const s=document.querySelector('.modal select');
  if(!s) return {нет:'селекта'};
  const r=s.getBoundingClientRect();
  return {варианты:[...s.options].map(o=>o.text), ширина:Math.round(r.width),
    виден:r.top>=0&&r.bottom<=innerHeight&&r.width>40};})()`);
check('на телефоне должности в списке есть',
  (mopts.варианты ?? []).filter(x => x !== '—').length > 0, JSON.stringify(mopts.варианты));
check('на телефоне список виден и не схлопнут', mopts.виден === true, JSON.stringify(mopts));
await shot('27-hr-add-mobile');
drain('форма на телефоне');
await metrics(1440, 900, false);

// ================= админ =================
at('Админ — те же экраны');
const adm = (await api('/auth/login', { method: 'POST', body: { login: 'admin', password: 'admin123' } })).d.token;
await go(`${APP}/?t=${adm}#/hr/overview`);
check('админ видит Обзор', /Обзор/.test(await txt()));
await go(`${APP}/?t=${adm}#/hr/constructor`, 2500);
check('админ видит конструктор', /Конструктор|Траектория/.test(await txt()));
await go(`${APP}/?t=${adm}#/hr/accounts`, 2000);
const accT = await txt();
check('админ видит аккаунты', /Аккаунты/.test(accT) && /Кадровик|Администратор/.test(accT));
await go(`${APP}/?t=${adm}#/hr/settings`, 2000);
const setT = await txt();
check('админ видит настройки ИИ', /Настройки/.test(setT) && /Провайдер/.test(setT));
/*
 * Ключ целиком на экране появляться не должен — но искать одну лишь приставку
 * нельзя: на экране есть подсказка «Ключ начинается с sk-ant-», и по ней
 * проверка падала на любой настроенной Anthropic, ничего при этом не найдя.
 * Ищем именно ключ: приставка и следом длинный хвост.
 */
check('ключ на экране не показан целиком',
  !/(gsk_|sk-ant-|sk-proj-)[A-Za-z0-9_-]{12,}/.test(setT));
check('написано, где взять ключ', /Где взять ключ/.test(setT) || /Не использовать ИИ/.test(setT));
drain('админ');

at('Кадровик — экрана аккаунтов у него нет');
// Не спрятанная кнопка, а отсутствующий маршрут: адрес, набранный руками,
// должен увести на обычный экран, а не показать чужой раздел.
await go(`${APP}/?t=${hr}#/hr/accounts`, 2000);
check('кадровика с адреса аккаунтов уводит', !/Новый аккаунт/.test(await txt()));
await go(`${APP}/?t=${hr}#/hr/settings`, 2000);
const hrSet = await txt();
check('кадровик видит настройки ИИ — ключ вставляет тот, кто платит',
  /Настройки/.test(hrSet) && /Провайдер/.test(hrSet));
drain('кадровик на чужом адресе');

// ================= сотрудник =================
await metrics(390, 844, true);

at('Сотрудник — только нанят (пре-онбординг)');
const ivan = (await api('/auth/login', { method: 'POST', body: { login: 'ivan', password: 'ivan123' } })).d.token;
await go(`${APP}/?t=${ivan}#/`);
t = await txt();
check('пре-онбординг открыт', /материал/i.test(t));
check('кнопка продолжить есть', /Продолжить/.test(t));
drain('пре-онбординг');

at('Сотрудник — в онбординге');
const olga = (await api('/auth/login', { method: 'POST', body: { login: 'olga', password: 'olga123' } })).d.token;
await go(`${APP}/?t=${olga}#/`);
t = await txt();
check('траектория видна', /следующий шаг/i.test(t));
check('прогресс блоков виден', /Пройден/.test(t));
drain('траектория');

const traj = (await api('/me/trajectory', { h: { authorization: 'Bearer ' + olga } })).d;
let lid = null;
for (const b of (traj.trajectory?.blocks ?? [])) for (const l of (b.lessons ?? [])) if (l.status === 'available' && !lid) lid = l.id;

at('Сотрудник — урок');
await go(`${APP}/?t=${olga}#/lesson/${lid}`, 1600);
t = await waitFor(/Отметить пройденным/i);
check('материал показан', /Урок \d+ из \d+/.test(t));
check('кнопка засчитать материал', /Отметить пройденным/i.test(t));
drain('урок');

at('Сотрудник — завершивший');
const sveta = (await api('/auth/login', { method: 'POST', body: { login: 'sveta', password: 'sveta123' } })).d.token;
await go(`${APP}/?t=${sveta}#/`);
t = await txt();
check('экран завершения', /заверш|Поздрав/i.test(t));
drain('завершивший');

at('Сотрудник — чужие страницы закрыты');
await go(`${APP}/?t=${olga}#/hr/employees`, 2000);
t = await txt();
check('сотрудника не пускает в панель HR', !/Добавить сотрудника/.test(t), t.split(NL).slice(1, 3).join(' | '));
drain('разграничение прав');

// ---- уборка ----
if (created) await api(`/employees/${created.id}/internship-failed`, { method: 'POST', h: H });

log(NL + (bad ? `НАЙДЕНО ПРОБЛЕМ: ${bad}` : 'ВСЁ ЧИСТО'));
for (const p of problems) log('  • ' + p);
try { await send('Browser.close'); } catch { /* браузер мог закрыться сам */ }
ch.kill();
process.exit(bad ? 1 : 0);
