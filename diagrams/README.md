# Схемы PEG HR LMS v1

Готовые картинки всех диаграмм из `../LOGIC.md`.

- **`index.html`** — открой в браузере: все 10 схем с подписями на одной странице.
  Ctrl+P → «Сохранить как PDF», если нужен один файл.
- **`PEG-HR-LMS-diagrams.pdf`** — то же одним PDF (уже собран).
- **`png/`** — растровые (×3, для документов и презентаций).
- **`svg/`** — векторные (для печати).
- **`src/`** — исходники mermaid (`.mmd`).

## Список

| Файл | Что показывает |
|---|---|
| 01-system-map | Один сервис lms, его модули, кто входит |
| 02-er-content | Данные: контент траектории должности |
| 03-er-people-progress | Данные: пользователи, сотрудники, прогресс |
| 04-state-employee | Этапы сотрудника: intern → onboarding → completed → archived |
| 05-state-lesson | Состояния урока: locked → available → passed |
| 06-process-hire | Найм → стажёр |
| 07-process-onboarding-gates | Два гейта (пре-онбординг + стажировка) → открытие онбординга |
| 08-process-lesson | Прохождение урока (материал + тест) |
| 09-process-unlock-attestation | Разблокировка следующего урока и финальная аттестация |
| 10-process-content-builder | Конструктор: draft → публикация, правки видны всем сразу |

## Перегенерировать после правок LOGIC.md

```bash
# из корня проекта
rm -rf diagrams/png diagrams/svg diagrams/src && mkdir -p diagrams/png diagrams/svg diagrams/src
printf '{"theme":"neutral","flowchart":{"htmlLabels":true,"useMaxWidth":true},"themeVariables":{"fontFamily":"Segoe UI, Arial, sans-serif"}}' > diagrams/src/mermaid-config.json
python - <<'EOF'
import re, pathlib
blocks = re.findall(r"```mermaid\n(.*?)\n```", pathlib.Path("LOGIC.md").read_text(encoding="utf-8"), re.S)
names = ["01-system-map","02-er-content","03-er-people-progress","04-state-employee","05-state-lesson","06-process-hire","07-process-onboarding-gates","08-process-lesson","09-process-unlock-attestation","10-process-content-builder"]
for i,b in enumerate(blocks): pathlib.Path(f"diagrams/src/{names[i]}.mmd").write_text(b+"\n", encoding="utf-8")
EOF
for f in diagrams/src/*.mmd; do n=$(basename "$f" .mmd)
  npx -y @mermaid-js/mermaid-cli -i "$f" -o "diagrams/png/$n.png" -c diagrams/src/mermaid-config.json -b white -s 3
  npx -y @mermaid-js/mermaid-cli -i "$f" -o "diagrams/svg/$n.svg" -c diagrams/src/mermaid-config.json -b white
done
# PDF (нужен путь Windows + ASCII-имя):
"/c/Users/meirb/.cache/puppeteer/chrome/win64-152.0.7977.75/chrome-win64/chrome.exe" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="C:\Users\meirb\Downloads\Pingwin DB\iiko api\diagrams\PEG-HR-LMS-diagrams.pdf" --virtual-time-budget=15000 \
  "file:///C:/Users/meirb/Downloads/Pingwin%20DB/iiko%20api/diagrams/index.html"
```
