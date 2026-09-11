import { inflateSync, inflateRawSync } from 'node:zlib';

/**
 * ЧТЕНИЕ PDF СВОИМИ СИЛАМИ.
 *
 * Зачем, если PDF умеет читать Claude. Затем, что это привязывало формат к
 * платному ключу: на бесплатном Groq регламент в PDF, а других у сети почти
 * и нет, просто не открывался. Разбор своими силами работает на любом ключе
 * и вообще без ключа, ничего не стоит и не ждёт ответа по сети.
 *
 * Где предел, и он честный: мы достаём **текстовый слой**. Он есть у всего,
 * что сделано «Сохранить как PDF» из Word, 1С, Google Docs или браузера.
 * У скана его нет — там внутри картинка, а не буквы, и вытащить оттуда нечего.
 * Такой файл уходит к Claude, который читает его глазами; нет ключа Claude —
 * говорим прямо, что это скан.
 *
 * Как устроен PDF внутри, коротко. Файл — набор пронумерованных объектов;
 * словарь каталога ведёт к дереву страниц, у страницы есть поток команд
 * рисования и набор шрифтов. Текст в потоке лежит не строками, а кусками
 * с координатами: «поставить перо сюда, написать это». Поэтому строки и
 * абзацы приходится восстанавливать по вертикальным координатам — иначе
 * документ склеится в одну строку.
 *
 * Кириллица. Байты в потоке — это не Unicode, а коды глифов конкретного
 * шрифта. Перевод даёт таблица `ToUnicode`, которую издатели PDF почти всегда
 * кладут рядом со шрифтом. Без неё русский текст прочитать нельзя — и тогда
 * мы тоже честно считаем, что текстового слоя нет.
 */

export class PdfError extends Error {
  constructor(message: string, readonly code: string = 'doc_failed') {
    super(message);
  }
}

// --------------------------------------------------------------- объекты

type PdfName = { name: string };
type PdfRef = { ref: number };
type PdfDict = Map<string, PdfValue>;
type PdfValue =
  | number | string | boolean | null
  | PdfName | PdfRef | PdfValue[] | PdfDict
  | { dict: PdfDict; streamAt: number };

const isName = (v: PdfValue): v is PdfName => !!v && typeof v === 'object' && 'name' in v;
const isRef = (v: PdfValue): v is PdfRef => !!v && typeof v === 'object' && 'ref' in v;
const isDict = (v: PdfValue): v is PdfDict => v instanceof Map;
const isStream = (v: PdfValue): v is { dict: PdfDict; streamAt: number } =>
  !!v && typeof v === 'object' && 'streamAt' in v;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * Разборщик по позиции в буфере. Написан вручную: разбирать надо немногое —
 * словари, массивы, имена, числа и ссылки, — а готовый разборщик тянет
 * за собой библиотеку целиком ради этих пяти видов значений.
 */
class Reader {
  constructor(readonly buf: Buffer, public pos = 0) {}

  skip() {
    for (;;) {
      while (this.pos < this.buf.length && WS.has(this.buf[this.pos])) this.pos++;
      // Комментарий идёт до конца строки.
      if (this.buf[this.pos] === 0x25) {
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
      } else return;
    }
  }

  /** Слово без разделителей: имя оператора, ключевое слово, число. */
  token(): string {
    this.skip();
    const start = this.pos;
    while (this.pos < this.buf.length
      && !WS.has(this.buf[this.pos]) && !DELIM.has(this.buf[this.pos])) this.pos++;
    return this.buf.toString('latin1', start, this.pos);
  }

  value(depth = 0): PdfValue {
    if (depth > 40) return null; // защита от закольцованных файлов
    this.skip();
    const c = this.buf[this.pos];
    if (c === undefined) return null;

    if (c === 0x2f) { // /Имя
      this.pos++;
      const start = this.pos;
      while (this.pos < this.buf.length
        && !WS.has(this.buf[this.pos]) && !DELIM.has(this.buf[this.pos])) this.pos++;
      return { name: decodeName(this.buf.toString('latin1', start, this.pos)) };
    }

    if (c === 0x5b) { // [массив]
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skip();
        if (this.buf[this.pos] === 0x5d) { this.pos++; break; }
        if (this.pos >= this.buf.length) break;
        arr.push(this.value(depth + 1));
      }
      return arr;
    }

    if (c === 0x3c && this.buf[this.pos + 1] === 0x3c) { // <<словарь>>
      this.pos += 2;
      const dict: PdfDict = new Map();
      for (;;) {
        this.skip();
        if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; break; }
        if (this.pos >= this.buf.length) break;
        const key = this.value(depth + 1);
        if (!isName(key)) { this.pos++; continue; }
        dict.set(key.name, this.value(depth + 1));
      }
      // За словарём может идти поток — его тело нам понадобится позже.
      const save = this.pos;
      if (this.token() === 'stream') {
        if (this.buf[this.pos] === 0x0d) this.pos++;
        if (this.buf[this.pos] === 0x0a) this.pos++;
        return { dict, streamAt: this.pos };
      }
      this.pos = save;
      return dict;
    }

    if (c === 0x3c) return this.hexString();
    if (c === 0x28) return this.literalString();

    const tok = this.token();
    if (tok === '') { this.pos++; return null; }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;

    if (/^[+-]?[\d.]+$/.test(tok)) {
      // «12 0 R» — ссылка на объект. Отличается от двух чисел подряд только
      // буквой R следом, поэтому смотрим вперёд и откатываемся, если не она.
      const save = this.pos;
      const gen = this.token();
      if (/^\d+$/.test(gen)) {
        const r = this.token();
        if (r === 'R') return { ref: Number(tok) };
      }
      this.pos = save;
      return Number(tok);
    }
    return { name: tok };
  }

  hexString(): string {
    this.pos++; // <
    let out = '';
    let hex = '';
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(this.buf[this.pos++]);
      if (/[0-9a-fA-F]/.test(ch)) {
        hex += ch;
        if (hex.length === 2) { out += String.fromCharCode(parseInt(hex, 16)); hex = ''; }
      }
    }
    if (hex.length === 1) out += String.fromCharCode(parseInt(hex + '0', 16));
    this.pos++; // >
    return out;
  }

  literalString(): string {
    this.pos++; // (
    let depth = 1;
    let out = '';
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++];
      if (c === 0x5c) { // обратная косая — экранирование
        const n = this.buf[this.pos++];
        const simple: Record<number, string> = {
          0x6e: '\n', 0x72: '\r', 0x74: '\t', 0x62: '\b', 0x66: '\f',
          0x28: '(', 0x29: ')', 0x5c: '\\',
        };
        if (simple[n] !== undefined) { out += simple[n]; continue; }
        if (n >= 0x30 && n <= 0x37) { // восьмеричный код
          let oct = String.fromCharCode(n);
          for (let k = 0; k < 2; k++) {
            const d = this.buf[this.pos];
            if (d >= 0x30 && d <= 0x37) { oct += String.fromCharCode(d); this.pos++; } else break;
          }
          out += String.fromCharCode(parseInt(oct, 8));
          continue;
        }
        if (n === 0x0a) continue; // перенос строки внутри строки — ничего не значит
        if (n === 0x0d) { if (this.buf[this.pos] === 0x0a) this.pos++; continue; }
        out += String.fromCharCode(n);
        continue;
      }
      if (c === 0x28) { depth++; out += '('; continue; }
      if (c === 0x29) { depth--; if (!depth) break; out += ')'; continue; }
      out += String.fromCharCode(c);
    }
    return out;
  }
}

/** #20 в именах — это закодированный пробел и прочие знаки. */
const decodeName = (s: string) =>
  s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

// --------------------------------------------------------------- распаковка

/** Предсказатель PNG: строки потока хранятся как разности с предыдущей. */
function unpredict(data: Buffer, colors: number, bpc: number, columns: number): Buffer {
  const bpp = Math.max(1, (colors * bpc) >> 3);
  const rowLen = ((columns * colors * bpc) + 7) >> 3;
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);

  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = Buffer.from(row);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      if (type === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (type === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (type === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (type === 4) {
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    cur.copy(out, r * rowLen);
    prev = cur;
  }
  return out;
}

function inflateAny(raw: Buffer): Buffer {
  try {
    return inflateSync(raw);
  } catch {
    // Некоторые издатели пишут поток без zlib-заголовка.
    try { return inflateRawSync(raw); } catch { return Buffer.alloc(0); }
  }
}

// --------------------------------------------------------------- документ

class Pdf {
  /** Номер объекта → позиция его значения в файле. */
  private at = new Map<number, number>();
  /** Объекты, распакованные из потоков объектов: номер → готовое значение. */
  private packed = new Map<number, PdfValue>();
  private cache = new Map<number, PdfValue>();

  constructor(readonly buf: Buffer) {
    this.index();
    this.unpackObjectStreams();
  }

  /**
   * Оглавление (xref) читать не пытаемся: в битых и дописанных файлах оно
   * врёт, а в новых лежит внутри сжатого потока. Проще и надёжнее пройти
   * по файлу и запомнить, где начинается каждый объект.
   */
  private index() {
    const s = this.buf.toString('latin1');
    const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      // Более поздний объект с тем же номером заменяет ранний: так работают
      // дописанные файлы, где правка добавляется в конец.
      this.at.set(Number(m[1]), m.index + m[0].length);
    }
  }

  /** С версии 1.5 объекты складывают в сжатые связки — их надо раскрыть. */
  private unpackObjectStreams() {
    for (const [, pos] of this.at) {
      const r = new Reader(this.buf, pos);
      const v = r.value();
      if (!isStream(v)) continue;
      const type = v.dict.get('Type') ?? null;
      if (!isName(type) || type.name !== 'ObjStm') continue;

      const data = this.streamData(v);
      if (!data.length) continue;
      const n = Number(this.resolve(v.dict.get('N')) ?? 0);
      const first = Number(this.resolve(v.dict.get('First')) ?? 0);
      const head = new Reader(data, 0);
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        const num = Number(head.token());
        const off = Number(head.token());
        if (Number.isFinite(num) && Number.isFinite(off)) pairs.push([num, off]);
      }
      for (const [num, off] of pairs) {
        if (this.at.has(num)) continue; // отдельный объект новее связки
        this.packed.set(num, new Reader(data, first + off).value());
      }
    }
  }

  object(num: number): PdfValue {
    if (this.cache.has(num)) return this.cache.get(num)!;
    let v: PdfValue = null;
    const pos = this.at.get(num);
    if (pos !== undefined) v = new Reader(this.buf, pos).value();
    else if (this.packed.has(num)) v = this.packed.get(num)!;
    this.cache.set(num, v);
    return v;
  }

  resolve(v: PdfValue | undefined): PdfValue {
    let cur: PdfValue = v ?? null;
    for (let i = 0; i < 32 && isRef(cur); i++) cur = this.object(cur.ref);
    return cur;
  }

  /** Тело потока: длина, фильтры, предсказатель. */
  streamData(v: { dict: PdfDict; streamAt: number }): Buffer {
    let len = Number(this.resolve(v.dict.get('Length')) ?? 0);
    // Длина бывает неверной — тогда ищем конец потока по ключевому слову.
    const tail = this.buf.indexOf('endstream', v.streamAt, 'latin1');
    if (!Number.isFinite(len) || len <= 0 || v.streamAt + len > this.buf.length
      || (tail >= 0 && v.streamAt + len > tail + 2)) {
      len = tail >= 0 ? tail - v.streamAt : 0;
    }
    let data = this.buf.subarray(v.streamAt, v.streamAt + len);

    const filters = this.resolve(v.dict.get('Filter'));
    const list = Array.isArray(filters) ? filters : filters ? [filters] : [];
    for (const f of list) {
      const name = isName(this.resolve(f)) ? (this.resolve(f) as PdfName).name : '';
      if (name === 'FlateDecode') data = inflateAny(data);
      else if (name === 'ASCIIHexDecode') {
        const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
        data = Buffer.from(hex.slice(0, hex.length & ~1), 'hex');
      } else if (name === 'DCTDecode' || name === 'JPXDecode' || name === 'CCITTFaxDecode') {
        // Картинка. Текста в ней нет — этим и занимается Claude.
        return Buffer.alloc(0);
      } else if (name && name !== 'FlateDecode') {
        return Buffer.alloc(0); // редкий фильтр — честнее отдать пустоту
      }
    }

    const parms = this.resolve(v.dict.get('DecodeParms'));
    const pd = isDict(parms) ? parms : Array.isArray(parms) && isDict(this.resolve(parms[0]))
      ? (this.resolve(parms[0]) as PdfDict) : null;
    if (pd && Number(this.resolve(pd.get('Predictor')) ?? 1) >= 10) {
      data = unpredict(
        data,
        Number(this.resolve(pd.get('Colors')) ?? 1),
        Number(this.resolve(pd.get('BitsPerComponent')) ?? 8),
        Number(this.resolve(pd.get('Columns')) ?? 1),
      );
    }
    return data;
  }

  /** Страницы по порядку. Дерево бывает вложенным, поэтому обход рекурсивный. */
  pages(): PdfDict[] {
    const out: PdfDict[] = [];
    const seen = new Set<number>();

    const walk = (node: PdfValue, depth: number) => {
      if (depth > 32 || out.length > 2000) return;
      const d = isStream(node) ? node.dict : node;
      if (!isDict(d)) return;
      const type = this.resolve(d.get('Type'));
      const kids = this.resolve(d.get('Kids'));
      if (Array.isArray(kids)) {
        for (const k of kids) {
          if (isRef(k)) {
            if (seen.has(k.ref)) continue;
            seen.add(k.ref);
          }
          walk(this.resolve(k), depth + 1);
        }
        return;
      }
      if (isName(type) && type.name === 'Page') out.push(d);
    };

    // Обычный путь — через каталог. Он же проверяет, что файл вообще целый.
    for (const [num] of this.at) {
      const v = this.object(num);
      const d = isStream(v) ? v.dict : v;
      if (!isDict(d)) continue;
      const t = this.resolve(d.get('Type'));
      if (isName(t) && t.name === 'Catalog') {
        walk(this.resolve(d.get('Pages')), 0);
        if (out.length) return out;
      }
    }

    // Каталога нет или дерево битое — собираем страницы как есть.
    const all = [...this.at.keys(), ...this.packed.keys()].sort((a, b) => a - b);
    for (const num of all) {
      const v = this.object(num);
      const d = isStream(v) ? v.dict : v;
      if (!isDict(d)) continue;
      const t = this.resolve(d.get('Type'));
      if (isName(t) && t.name === 'Page') out.push(d);
    }
    return out;
  }

  /** Унаследованные ключи: /Resources можно задать один раз на всё дерево. */
  inherited(page: PdfDict, key: string): PdfValue {
    let node: PdfValue = page;
    for (let i = 0; i < 32 && isDict(node); i++) {
      const v = this.resolve((node as PdfDict).get(key));
      if (v) return v;
      node = this.resolve((node as PdfDict).get('Parent'));
    }
    return null;
  }
}

// --------------------------------------------------------------- шрифты

/** Код глифа → символ. Пусто — значит, шрифт без таблицы перевода. */
type ToUnicode = Map<number, string>;

interface FontInfo { map: ToUnicode; twoByte: boolean }

/**
 * Таблица `ToUnicode` — это маленькая программа на языке CMap. Нам нужны две
 * её команды: одиночные соответствия и диапазоны. Без этой таблицы кириллицу
 * из PDF достать нельзя: в потоке лежат номера глифов, а не буквы.
 */
function parseToUnicode(src: string): ToUnicode {
  const map: ToUnicode = new Map();
  const chars = (hex: string) => {
    let s = '';
    for (let i = 0; i + 3 < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  };

  for (const m of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(p[1], 16), chars(p[2]));
    }
  }
  for (const m of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // Вид первый: <от> <до> <начало> — подряд идущие коды.
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const from = parseInt(p[1], 16);
      const to = parseInt(p[2], 16);
      const base = parseInt(p[3], 16);
      if (to - from > 65535) continue;
      for (let c = from; c <= to; c++) map.set(c, String.fromCharCode(base + (c - from)));
    }
    // Вид второй: <от> <до> [ <x> <y> … ] — список подряд.
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const from = parseInt(p[1], 16);
      const items = [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)];
      items.forEach((it, i) => map.set(from + i, chars(it[1])));
    }
  }
  return map;
}

function fontsOf(pdf: Pdf, page: PdfDict): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>();
  const res = pdf.inherited(page, 'Resources');
  if (!isDict(res)) return out;
  const fonts = pdf.resolve(res.get('Font'));
  if (!isDict(fonts)) return out;

  for (const [alias, ref] of fonts) {
    const f = pdf.resolve(ref);
    if (!isDict(f)) continue;
    const sub = pdf.resolve(f.get('Subtype'));
    const tu = pdf.resolve(f.get('ToUnicode'));
    const map = isStream(tu) ? parseToUnicode(pdf.streamData(tu).toString('latin1')) : new Map();
    // Type0 — составной шрифт, его коды двухбайтовые. Именно им пишут кириллицу.
    const enc = pdf.resolve(f.get('Encoding'));
    const twoByte = (isName(sub) && sub.name === 'Type0')
      || (isName(enc) && /Identity-[HV]/.test(enc.name));
    out.set(alias, { map, twoByte });
  }
  return out;
}

// --------------------------------------------------------------- текст

/** Кусок текста с координатами: по ним потом собираются строки. */
interface Piece { x: number; y: number; text: string }

function textPieces(pdf: Pdf, page: PdfDict): Piece[] {
  const contents = pdf.resolve(page.get('Contents'));
  const streams = Array.isArray(contents) ? contents : [contents];
  const parts: Buffer[] = [];
  for (const c of streams) {
    const s = pdf.resolve(c);
    if (isStream(s)) parts.push(pdf.streamData(s));
  }
  const data = Buffer.concat(parts.length ? parts.map((b) => Buffer.concat([b, Buffer.from('\n')])) : []);
  if (!data.length) return [];

  const fonts = fontsOf(pdf, page);
  const pieces: Piece[] = [];
  const r = new Reader(data, 0);
  const stack: PdfValue[] = [];

  let font: FontInfo | undefined;
  // Матрица текста: нам нужны только сдвиги, поэтому храним две координаты.
  let x = 0, y = 0, lineX = 0, lineY = 0;

  const decode = (raw: string): string => {
    if (!font || !font.map.size) {
      // Без таблицы перевода читается только латиница — для кириллицы это
      // равно отсутствию текстового слоя, и лучше вернуть пусто, чем мусор.
      return /^[\x20-\x7e\s]*$/.test(raw) ? raw : '';
    }
    let out = '';
    if (font.twoByte) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        out += font.map.get((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1)) ?? '';
      }
    } else {
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        out += font.map.get(c) ?? (c >= 0x20 && c < 0x7f ? raw[i] : '');
      }
    }
    return out;
  };

  const put = (s: string) => { if (s) pieces.push({ x, y, text: s }); };

  while (r.pos < data.length) {
    r.skip();
    if (r.pos >= data.length) break;
    const c = data[r.pos];

    if (c === 0x28 || c === 0x3c || c === 0x5b || c === 0x2f
      || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2b || c === 0x2e) {
      const before = r.pos;
      const v = r.value();
      if (r.pos === before) r.pos++;
      stack.push(v);
      if (stack.length > 64) stack.shift();
      continue;
    }

    const op = r.token();
    if (op === '') { r.pos++; continue; }

    switch (op) {
      case 'BT': x = y = lineX = lineY = 0; break;
      case 'Tf': {
        const alias = stack[stack.length - 2];
        if (isName(alias)) font = fonts.get(alias.name);
        break;
      }
      case 'Td': case 'TD': {
        const dy = Number(stack[stack.length - 1] ?? 0);
        const dx = Number(stack[stack.length - 2] ?? 0);
        lineX += Number.isFinite(dx) ? dx : 0;
        lineY += Number.isFinite(dy) ? dy : 0;
        x = lineX; y = lineY;
        break;
      }
      case 'Tm': {
        const f = Number(stack[stack.length - 1] ?? 0);
        const e = Number(stack[stack.length - 2] ?? 0);
        lineX = Number.isFinite(e) ? e : 0;
        lineY = Number.isFinite(f) ? f : 0;
        x = lineX; y = lineY;
        break;
      }
      case 'T*': y = lineY -= 12; x = lineX; break;
      case 'Tj': case "'": case '"': {
        const s = stack[stack.length - 1];
        if (op !== 'Tj') { y = lineY -= 12; x = lineX; }
        if (typeof s === 'string') put(decode(s));
        break;
      }
      case 'TJ': {
        const arr = stack[stack.length - 1];
        if (Array.isArray(arr)) {
          let s = '';
          for (const el of arr) {
            if (typeof el === 'string') s += decode(el);
            // Большой отрицательный сдвиг — это пробел между словами.
            else if (typeof el === 'number' && el < -180) s += ' ';
          }
          put(s);
        }
        break;
      }
      default: break;
    }
    stack.length = 0;
  }
  return pieces;
}

/**
 * Куски с координатами — в строки и абзацы. В PDF переносов строк нет вовсе:
 * есть только «перо переехало ниже». Поэтому строку начинаем там, где текст
 * опустился, а пустую строку ставим там, где опустился заметно сильнее
 * обычного межстрочного расстояния, — это и есть граница абзаца.
 */
function linesOf(pieces: Piece[]): string {
  if (!pieces.length) return '';
  const lines: { y: number; parts: Piece[] }[] = [];

  for (const p of pieces) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - p.y) < 2.5) last.parts.push(p);
    else lines.push({ y: p.y, parts: [p] });
  }

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 12;

  const out: string[] = [];
  lines.forEach((l, i) => {
    const text = l.parts
      .sort((a, b) => a.x - b.x)
      .map((p) => p.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (i > 0 && lines[i - 1].y - l.y > typical * 1.6) out.push('');
    if (text) out.push(text);
  });
  return out.join('\n');
}

// --------------------------------------------------------------- наружу

export interface PdfText {
  text: string;
  pages: number;
}

/**
 * Текстовый слой PDF. Пустая строка в ответе означает не поломку, а скан:
 * решать, что с ним делать, — дело вызывающего кода.
 */
export function extractPdfText(file: Buffer): PdfText {
  if (file.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new PdfError('Это не PDF — файл повреждён или подменено расширение', 'doc_broken');
  }
  if (file.includes('/Encrypt', 0, 'latin1')) {
    throw new PdfError(
      'PDF защищён паролем — снимите защиту и загрузите снова', 'doc_encrypted',
    );
  }

  let pdf: Pdf;
  try {
    pdf = new Pdf(file);
  } catch {
    throw new PdfError('Не удалось разобрать PDF', 'doc_broken');
  }

  const pages = pdf.pages();
  const chunks: string[] = [];
  for (const page of pages.slice(0, 300)) {
    try {
      const t = linesOf(textPieces(pdf, page));
      if (t.trim()) chunks.push(t);
    } catch {
      // Одна непрочитанная страница не повод бросать весь документ.
    }
  }
  return { text: chunks.join('\n\n').trim(), pages: pages.length };
}
