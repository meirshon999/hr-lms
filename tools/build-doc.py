#!/usr/bin/env python3
"""
Собирает PEG-HR-LMS.html (и через Chrome — .pdf) из LOGIC.md + SPEC.md + DESIGN.md.
Диаграммы берутся из diagrams/svg/ (сначала прогони diagrams/README.md -> перегенерацию).

Запуск из корня проекта:  python tools/build-doc.py
Нужен Node (npx marked). PDF делается, если найден Chrome от puppeteer.
"""
import re, subprocess, sys, pathlib, shutil, os

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / ".build-doc"
BUILD.mkdir(exist_ok=True)

NAMES = ["01-system-map","02-er-content","03-er-people-progress","04-state-employee",
         "05-state-lesson","06-process-hire","07-process-onboarding-gates","08-process-lesson",
         "09-process-unlock-attestation","10-process-content-builder"]
CAPTIONS = {
 "01-system-map":"Схема 1. Карта системы",
 "02-er-content":"Схема 2. Данные: контент траектории",
 "03-er-people-progress":"Схема 3. Данные: люди и прогресс",
 "04-state-employee":"Схема 4. Этапы сотрудника",
 "05-state-lesson":"Схема 5. Состояния урока",
 "06-process-hire":"Схема 6. Найм → стажёр",
 "07-process-onboarding-gates":"Схема 7. Два гейта → открытие онбординга",
 "08-process-lesson":"Схема 8. Прохождение урока",
 "09-process-unlock-attestation":"Схема 9. Разблокировка и аттестация",
 "10-process-content-builder":"Схема 10. Конструктор контента",
}

def marked(md_path, out_path):
    subprocess.run(["npx","-y","marked","--gfm","-i",str(md_path),"-o",str(out_path)],
                   check=True, shell=(os.name=="nt"))

def load_svg(name):
    s = (ROOT/f"diagrams/svg/{name}.svg").read_text(encoding="utf-8")
    s = re.sub(r"<\?xml[^>]*\?>","",s)
    s = re.sub(r"<!DOCTYPE[^>]*>","",s)
    return s.strip()

# --- LOGIC.md: подменяем ```mermaid на маркеры, потом на инлайновые svg
logic_md = (ROOT/"LOGIC.md").read_text(encoding="utf-8")
i = 0
def repl(m):
    global i
    tok = f"\n\n@@DIAG{i}@@\n\n"; i += 1; return tok
logic_md = re.sub(r"```mermaid\n.*?\n```", repl, logic_md, flags=re.S)
(BUILD/"LOGIC.tmp.md").write_text(logic_md, encoding="utf-8")
(BUILD/"SPEC.tmp.md").write_text((ROOT/"SPEC.md").read_text(encoding="utf-8"), encoding="utf-8")
(BUILD/"DESIGN.tmp.md").write_text((ROOT/"DESIGN.md").read_text(encoding="utf-8"), encoding="utf-8")

marked(BUILD/"LOGIC.tmp.md", BUILD/"LOGIC.html")
marked(BUILD/"SPEC.tmp.md", BUILD/"SPEC.html")
marked(BUILD/"DESIGN.tmp.md", BUILD/"DESIGN.html")

logic = (BUILD/"LOGIC.html").read_text(encoding="utf-8")
for idx, name in enumerate(NAMES):
    fig = (f'<figure class="diagram"><div class="svgwrap">{load_svg(name)}</div>'
           f'<figcaption>{CAPTIONS[name]}</figcaption></figure>')
    logic = logic.replace(f"<p>@@DIAG{idx}@@</p>", fig)
assert not re.findall(r"@@DIAG\d+@@", logic), "остались маркеры диаграмм"

spec = (BUILD/"SPEC.html").read_text(encoding="utf-8")
design = (BUILD/"DESIGN.html").read_text(encoding="utf-8")
strip_h1 = lambda f: re.sub(r"^\s*<h1>.*?</h1>","",f,count=1,flags=re.S)

TEMPLATE = (ROOT/"tools/doc-template.html").read_text(encoding="utf-8")
out = (TEMPLATE.replace("__LOGIC__", strip_h1(logic))
               .replace("__SPEC__", strip_h1(spec))
               .replace("__DESIGN__", strip_h1(design)))
(ROOT/"PEG-HR-LMS.html").write_text(out, encoding="utf-8")
print("PEG-HR-LMS.html готов")

# --- PDF через Chrome (puppeteer)
chrome = None
cache = pathlib.Path.home()/".cache/puppeteer/chrome"
if cache.exists():
    hits = list(cache.glob("*/chrome-*/chrome.exe")) + list(cache.glob("*/chrome-*/chrome"))
    chrome = str(hits[0]) if hits else None
if chrome:
    src = (ROOT/"PEG-HR-LMS.html").resolve().as_uri()
    subprocess.run([chrome,"--headless","--disable-gpu","--no-pdf-header-footer",
                    f'--print-to-pdf={ROOT/"PEG-HR-LMS.pdf"}',"--virtual-time-budget=20000", src],
                   check=True)
    print("PEG-HR-LMS.pdf готов")
else:
    print("Chrome не найден — PDF пропущен. Открой PEG-HR-LMS.html в браузере и Ctrl+P.")

shutil.rmtree(BUILD, ignore_errors=True)
