# Публикация проекта в GitHub одной командой.
#
#   powershell -ExecutionPolicy Bypass -File tools\push-github.ps1 https://github.com/ЛОГИН/peg-hr-lms.git
#
# Репозиторий на github.com нужно создать заранее: New repository -> Private ->
# НИЧЕГО не добавлять (ни README, ни .gitignore) -> Create.
param([Parameter(Mandatory = $true)][string]$RepoUrl)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($RepoUrl -notmatch '^https://github\.com/[^/]+/[^/]+?(\.git)?$') {
  Write-Host "  Адрес не похож на репозиторий GitHub: $RepoUrl" -ForegroundColor Red
  Write-Host '  Нужен вид https://github.com/ЛОГИН/peg-hr-lms.git'
  exit 1
}
if ($RepoUrl -notmatch '\.git$') { $RepoUrl = "$RepoUrl.git" }

git add -A
if (git diff --cached --quiet; $LASTEXITCODE -ne 0) {
  git commit -m 'Обновление перед публикацией'
  Write-Host '  Незакоммиченные правки сохранены.' -ForegroundColor Cyan
}

if (git remote | Select-String -Quiet '^origin$') {
  git remote set-url origin $RepoUrl
} else {
  git remote add origin $RepoUrl
}
git branch -M main

Write-Host ''
Write-Host '  Отправляю в GitHub...' -ForegroundColor Cyan
Write-Host '  Если спросит пароль — вставь personal access token (Settings ->' -ForegroundColor DarkGray
Write-Host '  Developer settings -> Tokens (classic) -> Generate new -> галочка repo).' -ForegroundColor DarkGray
Write-Host ''
git push -u origin main
if ($LASTEXITCODE -ne 0) { Write-Host '  Не отправилось — см. ошибку выше.' -ForegroundColor Red; exit 1 }

$web = $RepoUrl -replace '\.git$', ''
Write-Host ''
Write-Host "  Готово: $web" -ForegroundColor Green
Write-Host '  Дальше: render.com -> New + -> Web Service -> выбрать этот репозиторий.'
Write-Host '  Настройки Render подхватит из render.yaml сам.'
Write-Host ''
