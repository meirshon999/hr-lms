import { testIin } from './_iin.ts';
/* Точки сети, ИИН и содержимое по точкам. Запуск при живом сервере:
     npx tsx scripts/e2e-locations.ts                                       */
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

/**
 * Корректный ИИН берём из общего помощника, а не из своей копии. Копия здесь
 * была, и она повторяла формулу сида один в один — без сдвига диапазона.
 * Раз в несколько сотен прогонов номер совпадал с демо-сотрудником, и тест
 * падал на «этот ИИН уже заведён», хотя ошибки в системе не было.
 */
const iin = testIin;

async function main() {
  const login = await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } });
  if (login.s !== 200) { console.log('нет входа hr/hr123 — нужен тестовый сервер с LMS_DEV_TOOLS=1'); process.exit(2); }
  hrH = { authorization: `Bearer ${login.d.token}` };

  // ---------- справочник точек ----------
  const locs = (await j('/locations', { h: hrH })).d.items;
  check('точки заведены', locs.length >= 3, locs.map((l: any) => l.name).join(', '));
  const [A, Bl, C] = locs;

  const dup = await j('/locations', { method: 'POST', h: hrH, body: { name: A.name } });
  check('точка с тем же названием не создаётся', dup.s === 422);

  const busy = await j(`/locations/${A.id}`, { method: 'PATCH', h: hrH, body: { is_active: false } });
  check('точку с людьми нельзя закрыть', busy.s === 409, busy.d?.error?.message ?? '');

  // ---------- ИИН ----------
  const pos = (await j('/positions', { method: 'POST', h: hrH, body: { name: `Бармен ${uniq}` } })).d.id;
  const hire = (extra: any) => j('/employees', {
    method: 'POST', h: hrH,
    body: {
      full_name: 'Тест Тестов', position_id: pos, location_id: A.id,
      phone: '+7700' + uniq, start_date: new Date().toISOString().slice(0, 10),
      login: `t${uniq}`, password: 'secret123', ...extra,
    },
  });

  check('ИИН из 11 цифр отклоняется', (await hire({ iin: '12345678901' })).s === 422);
  check('ИИН с битой контрольной суммой отклоняется',
    (await hire({ iin: '990315300000' })).s === 422);
  check('13-й месяц в ИИН отклоняется', (await hire({ iin: iin(1).slice(0, 2) + '13' + iin(1).slice(4) })).s === 422);

  const good = iin(Number(uniq) % 8000);
  const first = await hire({ iin: good });
  check('найм с корректным ИИН проходит', first.s === 201, String(first.d?.error?.message ?? ''));
  const empId = first.d?.employee?.id;

  const twin = await hire({ iin: good, full_name: 'Тестов Тест', login: `t2${uniq}`, location_id: Bl.id });
  check('тот же ИИН под другим именем на другой точке — отказ', twin.s === 422,
    twin.d?.error?.message ?? '');

  const samePhone = await hire({ iin: iin((Number(uniq) + 137) % 8000), login: `t3${uniq}` });
  check('тот же телефон разрешён (телефон больше не ключ)', samePhone.s === 201);

  // ---------- временный пароль ----------
  const asEmp = await j('/auth/login', { method: 'POST', body: { login: `t${uniq}`, password: 'secret123' } });
  check('новый сотрудник обязан сменить пароль', asEmp.d?.must_change_password === true);
  const empH = { authorization: `Bearer ${asEmp.d.token}` };
  const same = await j('/auth/change-password', {
    method: 'POST', h: empH, body: { current_password: 'secret123', new_password: 'secret123' },
  });
  check('новый пароль не может совпадать со старым', same.s === 422);
  const changed = await j('/auth/change-password', {
    method: 'POST', h: empH, body: { current_password: 'secret123', new_password: 'newsecret1' },
  });
  check('смена пароля проходит', changed.s === 200);
  const after = await j('/auth/login', { method: 'POST', body: { login: `t${uniq}`, password: 'newsecret1' } });
  check('после смены флаг снят', after.d?.must_change_password === false);

  // ---------- содержимое по точкам ----------
  const blk = (await j(`/trajectories/${pos}/blocks`, { method: 'POST', h: hrH, body: { title: 'Объект' } })).d;
  const shared = (await j(`/blocks/${blk.id}/lessons`, {
    method: 'POST', h: hrH, body: { title: 'Стандарты сервиса' },
  })).d;
  const perLoc = (await j(`/blocks/${blk.id}/lessons`, {
    method: 'POST', h: hrH, body: { title: 'План зала', content_per_location: true },
  })).d;
  const onlyA = (await j(`/blocks/${blk.id}/lessons`, {
    method: 'POST', h: hrH, body: { title: 'Боулинг', everywhere: false, locations: [A.id] },
  })).d;

  const wrongSlot = await j(`/lessons/${perLoc.id}/material`, {
    method: 'PUT', h: hrH, body: { content_type: 'text', text_body: 'общий' },
  });
  check('точечному уроку нельзя дать общий материал', wrongSlot.s === 422,
    wrongSlot.d?.error?.message ?? '');

  const wrongShared = await j(`/lessons/${shared.id}/material`, {
    method: 'PUT', h: hrH, body: { content_type: 'text', text_body: 'x', location_id: A.id },
  });
  check('общему уроку нельзя дать материал точки', wrongShared.s === 422);

  check('материал точки сохраняется', (await j(`/lessons/${perLoc.id}/material`, {
    method: 'PUT', h: hrH, body: { content_type: 'text', text_body: 'Зал точки А', location_id: A.id },
  })).s === 200);

  const treeA = (await j(`/trajectories/${pos}?location=${A.id}`, { h: hrH })).d;
  const treeB = (await j(`/trajectories/${pos}?location=${Bl.id}`, { h: hrH })).d;
  const lessonIn = (tree: any, id: string) =>
    tree.blocks.flatMap((b: any) => b.lessons ?? []).find((l: any) => l.id === id);

  check('точка А видит свой материал', lessonIn(treeA, perLoc.id)?.material?.text_body === 'Зал точки А');
  check('точка Б своего материала ещё не имеет', lessonIn(treeB, perLoc.id)?.material === null);
  check('урок «только на точках» виден в дереве', !!lessonIn(treeA, onlyA.id));

  const ready = treeA.locations.find((l: any) => l.location_id === A.id);
  check('точка не готова, пока уроки не заполнены', ready && !ready.ready,
    ready?.problems?.[0] ?? '');

  // ---------- урок только на одной точке не попадает в снимок другой ----------
  const structural = (await j(`/trajectories/${pos}`, { h: hrH })).d;
  check('каркас без выбранных точек ловится',
    !structural.problems.some((p: string) => p.includes('Боулинг')),
    structural.problems.join(' | '));

  const noLoc = (await j(`/blocks/${blk.id}/lessons`, {
    method: 'POST', h: hrH, body: { title: 'Ничей', everywhere: false, locations: [] },
  })).d;
  const structural2 = (await j(`/trajectories/${pos}`, { h: hrH })).d;
  check('урок без выбранных точек — проблема каркаса',
    structural2.problems.some((p: string) => p.includes('Ничей')),
    structural2.problems.join(' | '));
  await j(`/lessons/${noLoc.id}`, { method: 'DELETE', h: hrH });

  // ---------- перевод между точками ----------
  const move = await j(`/employees/${empId}/transfer`, {
    method: 'POST', h: hrH, body: { location_id: Bl.id },
  });
  check('перевод на другую точку проходит', move.s === 200, JSON.stringify(move.d));
  const card = (await j(`/employees/${empId}`, { h: hrH })).d;
  check('точка в карточке обновилась', card.location_id === Bl.id, card.location);

  const again = await j(`/employees/${empId}/transfer`, {
    method: 'POST', h: hrH, body: { location_id: Bl.id },
  });
  check('перевод на ту же точку отклоняется', again.s === 409);

  const history = (await j(`/employees/${empId}/audit`, { h: hrH })).d;
  check('перевод записан в журнал',
    JSON.stringify(history).includes('transfer'), '');

  // ---------- тупик: точка не заполнила свои уроки ----------
  //
  // Каркас цел, значит траектория остаётся активной и «Опубликовать» никто не
  // нажмёт. Стажёр с двумя пройденными гейтами ждёт содержимого своей точки —
  // и обязан уйти в онбординг сам, как только точка его заполнит.
  const pos2 = (await j('/positions', { method: 'POST', h: hrH, body: { name: `Хостес ${uniq}` } })).d.id;
  await j(`/trajectories/${pos2}/pre-onboarding`, {
    method: 'POST', h: hrH, body: { title: 'О компании', content_type: 'text', text_body: 'Текст.' },
  });
  const b2 = (await j(`/trajectories/${pos2}/blocks`, { method: 'POST', h: hrH, body: { title: 'Объект' } })).d;
  const zal = (await j(`/blocks/${b2.id}/lessons`, {
    method: 'POST', h: hrH, body: { title: 'План зала', content_per_location: true },
  })).d;

  async function fillZal(locId: string, answer: number) {
    await j(`/lessons/${zal.id}/material`, {
      method: 'PUT', h: hrH, body: { content_type: 'text', text_body: 'Зал', location_id: locId },
    });
    const lt = (await j(`/lessons/${zal.id}/test`, {
      method: 'PUT', h: hrH, body: { pass_mark_pct: 70, location_id: locId },
    })).d;
    await j(`/tests/${lt.test_id}/questions`, {
      method: 'POST', h: hrH,
      body: { text: 'Где склад?', options: ['Слева', 'Справа'], correct_index: answer },
    });
  }
  await fillZal(A.id, 0);

  const att2 = (await j(`/trajectories/${pos2}`, { h: hrH })).d.blocks.find((b: any) => b.kind === 'attestation');
  const at2 = (await j(`/blocks/${att2.id}/test`, { method: 'PUT', h: hrH, body: { pass_mark_pct: 70 } })).d;
  await j(`/tests/${at2.test_id}/questions`, {
    method: 'POST', h: hrH, body: { text: 'Финал?', options: ['да', 'нет'], correct_index: 0 },
  });
  check('траектория публикуется по каркасу, хотя точка Б пуста',
    (await j(`/trajectories/${pos2}/publish`, { method: 'POST', h: hrH })).s === 200);

  const wait = await j('/employees', {
    method: 'POST', h: hrH,
    body: {
      iin: iin((Number(uniq) + 411) % 8000), full_name: 'Ждущий Стажёр',
      position_id: pos2, location_id: Bl.id, phone: '+7701' + uniq,
      start_date: new Date().toISOString().slice(0, 10), login: `w${uniq}`, password: 'waiting123',
    },
  });
  const waitId = wait.d?.employee?.id;
  const wTok = (await j('/auth/login', { method: 'POST', body: { login: `w${uniq}`, password: 'waiting123' } })).d.token;
  const wH = { authorization: `Bearer ${wTok}` };
  for (const it of (await j('/me/pre-onboarding', { h: wH })).d.items)
    await j(`/me/pre-onboarding/${it.id}/view`, { method: 'POST', h: wH });

  const gate = await j(`/employees/${waitId}/internship-passed`, { method: 'POST', h: hrH });
  check('оба гейта пройдены, но точка пуста — онбординг не открыт',
    gate.d?.onboarding_opened === false && gate.d?.reason === 'location_content_incomplete',
    JSON.stringify(gate.d));

  // точка Б заполняет своё — ждущий обязан уйти в онбординг без действий HR
  await fillZal(Bl.id, 1);
  const afterFill = (await j(`/employees/${waitId}`, { h: hrH })).d;
  check('точка заполнила уроки — ждущий ушёл в онбординг сам',
    afterFill.stage === 'onboarding', afterFill.stage);
  check('в снимке ровно один урок — вариант своей точки',
    afterFill.blocks?.[0]?.lessons?.length === 1,
    JSON.stringify(afterFill.blocks?.[0]?.lessons ?? []));


  console.log(failed ? `\n${failed} провалено` : '\nвсе проверки пройдены');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
