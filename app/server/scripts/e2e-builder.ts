import { freshIin } from './_iin.ts';
/* Сквозной тест конструктора. Запуск при живом сервере: npx tsx src/e2e-builder.ts */
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

async function main() {
  const hr = (await j('/auth/login', { method: 'POST', body: { login: 'hr', password: 'hr123' } })).d.token;
  const h = { authorization: 'Bearer ' + hr };

  const pos = (await j('/positions', { method: 'POST', h, body: { name: 'Бармен' } })).d;
  console.log('new position:', pos.name, '/', pos.trajectory_status);
  const pid = pos.id;

  let tree = (await j(`/trajectories/${pid}`, { h })).d;
  console.log('problems (fresh):', tree.problems.length, '| e.g.', tree.problems[0]);

  const pub1 = await j(`/trajectories/${pid}/publish`, { method: 'POST', h });
  console.log('publish incomplete ->', pub1.s, pub1.d.error?.code);

  const blk = (await j(`/trajectories/${pid}/blocks`, { method: 'POST', h, body: { title: 'Основы' } })).d;
  const les = (await j(`/blocks/${blk.id}/lessons`, { method: 'POST', h, body: { title: 'Классические коктейли' } })).d;
  await j(`/lessons/${les.id}/material`, { method: 'PUT', h, body: { content_type: 'text', text_body: 'Пропорции и техника.' } });
  const test = (await j(`/lessons/${les.id}/test`, { method: 'PUT', h, body: { pass_mark_pct: 70 } })).d;
  await j(`/tests/${test.test_id}/questions`, { method: 'POST', h, body: { text: 'Джин-тоник: частей джина?', options: ['1', '2', '5'], correct_index: 0 } });

  tree = (await j(`/trajectories/${pid}`, { h })).d;
  const att = tree.blocks.find((b: any) => b.kind === 'attestation');
  const at = (await j(`/blocks/${att.id}/test`, { method: 'PUT', h, body: { pass_mark_pct: 80 } })).d;
  await j(`/tests/${at.test_id}/questions`, { method: 'POST', h, body: { text: 'Главное правило бара?', options: ['Чистота', 'Скорость любой ценой'], correct_index: 0 } });

  tree = (await j(`/trajectories/${pid}`, { h })).d;
  console.log('problems now:', JSON.stringify(tree.problems));
  const pub2 = await j(`/trajectories/${pid}/publish`, { method: 'POST', h });
  console.log('publish complete ->', pub2.s, pub2.d.status);

  // employee sees the new trajectory on hire
  const emp = await j('/employees', {
    method: 'POST', h,
    body: { iin: freshIin(), full_name: 'Бар Тендер', position_id: pid, location_id: (await j('/locations', { h })).d.items[0].id, phone: '+79997770001', start_date: new Date().toISOString().slice(0, 10), login: 'bar1', password: 'bar1pass' },
  });
  console.log('hire on new position ->', emp.s, 'warnings', JSON.stringify(emp.d.warnings));

  await j(`/employees/${emp.d.employee.id}/internship-failed`, { method: 'POST', h });
  await j(`/positions/${pid}`, { method: 'DELETE', h });
  console.log('cleanup done. OK');
}
main().catch((e) => { console.error('ERR', e?.stack ?? e); process.exit(1); });
