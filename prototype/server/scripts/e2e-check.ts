/* Ручной сквозной тест логики (не входит в прод). Запуск при живом сервере:
   npx tsx src/e2e-check.ts */
const B = 'http://localhost:3001/api/v1';

async function j(p: string, o: any = {}): Promise<{ s: number; d: any }> {
  const r = await fetch(B + p, {
    method: o.method ?? 'GET',
    headers: { ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.headers ?? {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  return { s: r.status, d: t ? JSON.parse(t) : null };
}
const login = async (l: string, p: string) =>
  (await j('/auth/login', { method: 'POST', body: { login: l, password: p } })).d.token;

async function main() {
  const hr = await login('hr', 'hr123');
  const H = { authorization: 'Bearer ' + hr };
  const pos = (await j('/positions', { headers: H })).d.items.find((x: any) => x.name === 'Официант');

  const c = await j('/employees', {
    method: 'POST', headers: H,
    body: {
      full_name: 'Тест Полный', position_id: pos.id, phone: '+79995550123',
      start_date: new Date().toISOString().slice(0, 10), login: 'fulltest', password: 'fulltest123',
    },
  });
  console.log('create employee:', c.s, 'warnings', JSON.stringify(c.d.warnings));
  const eid = c.d.employee.id;

  const emp = await login('fulltest', 'fulltest123');
  const E = { authorization: 'Bearer ' + emp };

  const preResp = await j('/me/pre-onboarding', { headers: E });
  console.log('GET /me/pre-onboarding ->', preResp.s, 'items:', preResp.d?.items?.length);
  for (const it of preResp.d.items) {
    const vr = await j(`/me/pre-onboarding/${it.id}/view`, { method: 'POST', headers: E });
    console.log('  view', it.title, '->', vr.s, JSON.stringify(vr.d));
  }
  const pre = (await j('/me/pre-onboarding', { headers: E })).d;
  console.log('pre-onboarding done:', pre.done);

  console.log('trajectory before internship (expect 409):', (await j('/me/trajectory', { headers: E })).s);

  const ip = await j(`/employees/${eid}/internship-passed`, { method: 'POST', headers: H });
  console.log('HR internship-passed -> onboarding opened:', ip.d.onboarding_opened);

  const tree = (await j(`/trajectories/${pos.id}`, { headers: H })).d;
  let tr = (await j('/me/trajectory', { headers: E })).d;

  for (const b of tree.blocks.filter((x: any) => x.kind === 'regular')) {
    for (const l of b.lessons) {
      // видео: сервер требует реальный прогресс просмотра
      if (l.material?.content_type === 'video')
        await j(`/me/lessons/${l.id}/video-progress`, { method: 'POST', headers: E, body: { pct: 100 } });

      const md = await j(`/me/lessons/${l.id}/material-done`, { method: 'POST', headers: E });
      if (md.s !== 200) console.log(`  ! material-done ${l.title}: ${md.s} ${md.d?.error?.code}`);

      const ans = l.test.questions.map((q: any) => ({ question_id: q.id, option_index: q.correct_index }));
      const r = (await j(`/me/lessons/${l.id}/test`, { method: 'POST', headers: E, body: { answers: ans } })).d;
      tr = (await j('/me/trajectory', { headers: E })).d;
      console.log(`  lesson "${l.title}" -> ${r.score_pct}% ${r.passed ? 'PASS' : 'FAIL'} | progress ${tr.progress.passed}/${tr.progress.total}`);
    }
  }

  console.log('attestation available:', tr.trajectory.attestation.available);
  const attBlock = tree.blocks.find((x: any) => x.kind === 'attestation');
  const aAns = attBlock.test.questions.map((q: any) => ({ question_id: q.id, option_index: q.correct_index }));
  const ar = (await j('/me/attestation', { method: 'POST', headers: E, body: { answers: aAns } })).d;
  console.log('attestation:', ar.score_pct + '%', ar.passed ? 'PASSED' : 'failed');
  console.log('final stage:', (await j('/me', { headers: E })).d.employee.stage);

  // negative checks
  const dup = await j('/employees', {
    method: 'POST', headers: H,
    body: { full_name: 'X', position_id: pos.id, phone: '+79995550123', start_date: new Date().toISOString().slice(0, 10), login: 'dupcheck', password: 'dupcheck1' },
  });
  console.log('duplicate phone -> ', dup.s, dup.d.error?.code);

  await j('/dev/reset', { method: 'POST', headers: H });
  console.log('DONE — demo reset');
}

main().catch((e) => { console.error('ERR', e?.stack ?? e); process.exit(1); });
