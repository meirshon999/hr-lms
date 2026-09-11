// Запуск всех сквозных наборов одной командой: npm test
//
// Наборам нужен живой сервер, и раньше его поднимали руками — а значит,
// проверки прогоняли не всегда. Здесь сервер поднимается сам, на отдельной
// базе во временной папке, и гасится в конце в любом случае. Рабочая база
// не задевается: DB_PATH указывает в сторону.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUITES = [
  ['e2e-check', 'полный путь сотрудника'],
  ['e2e-builder', 'конструктор и публикация'],
  ['e2e-guards', 'права и запреты'],
  ['e2e-files', 'загрузка файлов'],
  ['e2e-hr-actions', 'действия HR над карточкой'],
  ['e2e-locations', 'точки сети, ИИН, контент по точкам'],
  ['e2e-snapshot', 'заморозка траектории'],
  ['e2e-ai', 'ИИ-конструктор и разбор документов'],
  ['e2e-users', 'роли и служебные аккаунты'],
  ['e2e-funnel', 'воронка по должностям'],
  ['e2e-plan', 'план траектории из документа'],
  ['e2e-attestation', 'финальная аттестация одной кнопкой'],
  ['e2e-settings', 'настройки ИИ и свой ключ'],
];

const PORT = Number(process.env.LMS_TEST_PORT ?? 3999);
const URL = `http://localhost:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'lms-e2e-'));

const server = spawn(
  process.execPath,
  ['--import', 'tsx', 'src/index.ts'],
  {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: join(dir, 'test.db'),
      UPLOAD_DIR: join(dir, 'uploads'),
      LMS_DEV_TOOLS: '1',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

function stop(code) {
  server.kill();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* временная папка могла быть ещё занята — она и так во временных */
  }
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) {
      console.error('Сервер не поднялся:\n' + serverLog);
      stop(2);
    }
    try {
      const r = await fetch(`${URL}/api/health`);
      if (r.ok) return;
    } catch {
      /* ещё поднимается */
    }
    await sleep(500);
  }
  console.error('Сервер не ответил за 30 секунд:\n' + serverLog);
  stop(2);
}

function run(name) {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      ['--import', 'tsx', `scripts/${name}.ts`],
      { env: { ...process.env, LMS_URL: URL }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

await waitForServer();

let failed = 0;
for (const [name, about] of SUITES) {
  const { code, out } = await run(name);
  const bad = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const passed = out.split('\n').filter((l) => l.startsWith('PASS')).length;
  if (code === 0 && bad.length === 0) {
    console.log(`  ✓ ${name.padEnd(16)} ${String(passed).padStart(3)} проверок  — ${about}`);
  } else {
    failed++;
    console.log(`  ✗ ${name.padEnd(16)} — ${about}`);
    for (const l of bad) console.log('      ' + l);
    if (bad.length === 0) console.log(out.split('\n').slice(-12).join('\n'));
  }
}

console.log(failed ? `\n${failed} набор(ов) провалено` : '\nвсе наборы пройдены');
stop(failed ? 1 : 0);
