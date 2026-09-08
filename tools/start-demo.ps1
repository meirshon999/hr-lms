# Запуск демо-стенда в одно действие: ставит зависимости (если надо),
# собирает прод-версию и поднимает один процесс на :3001, затем открывает браузер.
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

$root  = Split-Path -Parent $PSScriptRoot
$proto = Join-Path $root 'prototype'
$port  = 3001

Write-Host ''
Write-Host '  PEG HR LMS - демо-стенд' -ForegroundColor Magenta
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  Не найден Node.js. Поставь с nodejs.org (версия 22 или новее) и запусти снова.' -ForegroundColor Red
  exit 1
}
$nodeMajor = [int](((node -v).Substring(1)).Split('.')[0])
if ($nodeMajor -lt 22) {
  Write-Host "  Node $(node -v) слишком старый, нужен 22+. Обнови с nodejs.org." -ForegroundColor Red
  exit 1
}

# занятый порт — почти всегда прошлый запуск, который забыли закрыть
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host "  Порт $port уже занят — закрываю прошлый запуск..." -ForegroundColor Yellow
  $busy | Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Seconds 2
}

if (-not (Test-Path (Join-Path $proto 'node_modules'))) {
  Write-Host '  [1/3] Ставлю зависимости (только первый раз, 1-3 минуты)...' -ForegroundColor Cyan
  Push-Location $proto; npm install; Pop-Location
} else {
  Write-Host '  [1/3] Зависимости на месте.' -ForegroundColor Cyan
}

Write-Host '  [2/3] Собираю...' -ForegroundColor Cyan
Push-Location $proto; npm run build; Pop-Location

Write-Host '  [3/3] Запускаю...' -ForegroundColor Cyan
Push-Location $proto
$env:PORT = $port
$srv = Start-Process node -ArgumentList 'server/dist/index.js' -PassThru -NoNewWindow
Pop-Location

# ждём, пока сервер ответит
$ok = $false
foreach ($i in 1..40) {
  Start-Sleep -Milliseconds 500
  try {
    if ((Invoke-WebRequest "http://localhost:$port/api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}

if (-not $ok) {
  Write-Host '  Сервер не поднялся. Запусти вручную: cd prototype ; npm start' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host "  Готово. Приложение: http://localhost:$port" -ForegroundColor Green
Write-Host "  Swagger API:        http://localhost:$port/docs"
Write-Host ''
Write-Host '  Вход: hr / hr123 (HR)  |  petr / petr123 (новичок)'
Write-Host '  Полный список аккаунтов и сценарий — на экране входа.'
Write-Host ''
Write-Host '  Чтобы остановить — закрой это окно.' -ForegroundColor DarkGray
Write-Host ''

Start-Process "http://localhost:$port"
Wait-Process -Id $srv.Id
