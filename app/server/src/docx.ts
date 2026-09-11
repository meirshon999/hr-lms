import { inflateRawSync } from 'node:zlib';

/**
 * ЧТЕНИЕ ИСХОДНИКОВ: DOCX и обычный текст.
 *
 * Регламенты у сети лежат в Word, и заставлять кадровика копировать их в поле
 * руками — лишний шаг, на котором теряются заголовки.
 *
 * Почему разбираем сами, а не библиотекой. DOCX — это обычный zip, внутри
 * которого лежит `word/document.xml`. Распаковка есть во встроенном модуле
 * сжатия, разбор нужного нам куска — сотня строк. Готовая библиотека тянет
 * за собой десятки чужих пакетов ради того же результата, а правило проекта
 * говорит: зависимость добавляем, только если своими силами выйдет заметно
 * хуже. Здесь не выйдет.
 *
 * Что сохраняем и зачем. Не только текст, но и **заголовки**: это готовое
 * оглавление документа. Из него потом строится структура траектории — какие
 * блоки, какие уроки. Поэтому заголовки помечаются решётками, как в разметке.
 */

export class DocError extends Error {
  constructor(message: string, readonly code: string = 'doc_failed') {
    super(message);
  }
}

// ------------------------------------------------------------------- zip

interface ZipEntry { name: string; method: number; offset: number; size: number; }

/**
 * Оглавление zip лежит в конце файла, а не в начале: так задумано форматом,
 * чтобы архив можно было дописывать. Ищем его подпись с хвоста.
 */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const EOCD = 0x06054b50;
  // 22 байта — минимальная запись, плюс до 65535 байт комментария в конце.
  const from = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new DocError('Это не документ Word — файл повреждён', 'doc_broken');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) {
    // ZIP64 нужен файлам больше четырёх гигабайт. Документ Word таким не бывает,
    // и поддерживать формат ради невозможного случая незачем — честно откажем.
    throw new DocError('Файл слишком большой для разбора', 'doc_too_large');
  }

  const items: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    items.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      size: buf.readUInt32LE(p + 20),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return items;
}

/** Достаёт один файл из архива. Имя данных известно, искать их не нужно. */
function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) {
    throw new DocError('Это не документ Word — файл повреждён', 'doc_broken');
  }
  // Длины имени и «дополнительного поля» в локальном заголовке свои: они могут
  // отличаться от тех, что записаны в оглавлении, поэтому читаем именно отсюда.
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.size);
  if (e.method === 0) return raw;               // без сжатия
  if (e.method === 8) return inflateRawSync(raw); // deflate — обычный случай
  throw new DocError('Документ сжат неизвестным способом', 'doc_broken');
}

// ------------------------------------------------------------------- xml

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[ent] ?? all;
  });
}

/**
 * Уровень заголовка. Word пишет стиль либо по-английски (`Heading2`), либо
 * по-русски (`Заголовок2`) — зависит от того, на каком языке ставили Word,
 * и обе записи встречаются в одном и том же документе.
 */
function headingLevel(paragraphXml: string): number {
  const m = /<w:pStyle[^>]*w:val="([^"]+)"/.exec(paragraphXml);
  if (!m) return 0;
  const style = m[1];
  const num = /(\d+)\s*$/.exec(style)?.[1];
  if (!num) return /^(Title|Название)$/i.test(style) ? 1 : 0;
  return /^(Heading|Заголовок)/i.test(style) ? Math.min(Number(num), 6) : 0;
}

/** Текст одного абзаца: куски `<w:t>`, переносы и табуляции между ними. */
function paragraphText(xml: string): string {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (m[0] === '<w:tab/>') out += '\t';
    else out += '\n';
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/**
 * Разбор основного документа. Идём по абзацам подряд: внутри таблицы абзацы
 * такие же, поэтому ячейки складываются в строки сами, а разделителем строк
 * таблицы служит конец её строки `</w:tr>`.
 */
function documentText(xml: string): string {
  const body = /<w:body[\s\S]*?<\/w:body>/.exec(xml)?.[0] ?? xml;
  const lines: string[] = [];
  const cells: string[] = [];

  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>|<\/w:tr>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[0] === '</w:tr>') {
      if (cells.length) { lines.push(cells.join(' | ')); cells.length = 0; }
      continue;
    }
    const text = paragraphText(m[0]);
    // Пустой абзац — не мусор: в Word им отбивают смысловые куски.
    // Внутри таблицы он ничего не значит, там пустая ячейка — просто пустая.
    const inTable = m.index > 0 && isInsideTable(body, m.index);
    if (inTable) { cells.push(text); continue; }

    const level = headingLevel(m[0]);
    if (!text) { lines.push(''); continue; }
    lines.push(level ? `${'#'.repeat(level)} ${text}` : text);
  }
  if (cells.length) lines.push(cells.join(' | '));

  // Больше одной пустой строки подряд ничего не добавляет ни человеку, ни модели.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Абзац внутри таблицы, если ближайший тег строки слева — открывающий. */
function isInsideTable(body: string, at: number): boolean {
  const open = body.lastIndexOf('<w:tr', at);
  if (open < 0) return false;
  const close = body.lastIndexOf('</w:tr>', at);
  return open > close;
}

// ----------------------------------------------------------------- наружу

export interface ExtractResult {
  text: string;
  /** Заголовки документа по порядку — готовое оглавление для будущей траектории. */
  headings: Array<{ level: number; title: string }>;
  kind: 'docx' | 'text' | 'pdf';
}

/** Читает DOCX целиком: распаковка, разбор, сборка текста с заголовками. */
export function extractDocx(file: Buffer): ExtractResult {
  const entries = readCentralDirectory(file);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) {
    throw new DocError(
      'В файле нет текста документа. Если это .doc старого образца — '
      + 'откройте его в Word и сохраните как .docx',
      'doc_not_word',
    );
  }
  const raw = documentText(readEntry(file, doc).toString('utf8'));
  // Свои заголовки Word важнее наших догадок — размечаем только их отсутствие.
  const text = headingsOf(raw).length ? raw : markNumberedHeadings(raw);
  return { text, headings: headingsOf(text), kind: 'docx' };
}

/**
 * Обычный текстовый файл. Кодировку определяем: .txt из Windows часто
 * сохранён в 1251, и в таком файле кириллица разобралась бы в мусор.
 */
export function extractText(file: Buffer): ExtractResult {
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(file);
  } catch {
    s = new TextDecoder('windows-1251').decode(file);
  }
  // Метку порядка байтов записываем кодом, а не самим символом: в исходнике
  // он невидим, и такую строку невозможно прочитать глазами.
  const raw = s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  // \u0421\u0432\u043E\u0438 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0438 \u0432\u0430\u0436\u043D\u0435\u0435 \u043D\u0430\u0448\u0438\u0445 \u0434\u043E\u0433\u0430\u0434\u043E\u043A \u2014 \u0440\u0430\u0437\u043C\u0435\u0447\u0430\u0435\u043C \u0442\u043E\u043B\u044C\u043A\u043E \u0438\u0445 \u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0438\u0435.
  const text = headingsOf(raw).length ? raw : markNumberedHeadings(raw);
  return { text, headings: headingsOf(text), kind: 'text' };
}

/**
 * РАЗМЕТКА ЗАГОЛОВКОВ, КОТОРЫЕ ЗАГОЛОВКАМИ НЕ ОФОРМЛЕНЫ.
 *
 * Стилями Word на практике почти никто не пользуется: разделы нумеруют руками —
 * «1. Начало смены», «2. Встреча гостя». Для Word это обычный абзац, и документ
 * с шестью явными разделами приезжает к нам сплошным текстом.
 *
 * Ищем осторожно, чтобы не принять за заголовок пункт списка: строка должна
 * быть короткой, без точки на конце, а номера — идти подряд от единицы. Меньше
 * двух таких строк — считаем, что нумерации нет, и ничего не трогаем.
 */
export function markNumberedHeadings(text: string): string {
  const lines = text.split('\n');
  const found: Array<{ i: number; n: number }> = [];

  lines.forEach((line, i) => {
    const m = /^\s*(\d{1,2})[.)]\s+(\S.*)$/.exec(line);
    if (!m) return;
    const title = m[2].trim();
    // Пункт списка — это предложение: он длинный и кончается точкой.
    if (title.length > 70 || /[.,;:]$/.test(title)) return;
    found.push({ i, n: Number(m[1]) });
  });

  // Номера должны идти по порядку: 1, 2, 3… Разнобой означает, что это
  // пункты внутри разных списков, а не разделы документа.
  const ordered = found.filter((f, k) => f.n === k + 1);
  if (ordered.length < 2) return text;

  const mark = new Set(ordered.map((f) => f.i));
  return lines.map((l, i) => (mark.has(i) ? '## ' + l.trim() : l)).join('\n');
}

export function headingsOf(text: string): Array<{ level: number; title: string }> {
  return text.split('\n')
    .map((l) => /^(#{1,6})\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ level: m[1].length, title: m[2].trim() }));
}

/** Разбирает файл по расширению. Имя приходит от человека, поэтому в нижний регистр. */
export function extractDocument(file: Buffer, filename: string): ExtractResult {
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.docx')) return extractDocx(file);
  if (name.endsWith('.txt') || name.endsWith('.md')) return extractText(file);
  if (name.endsWith('.doc')) {
    throw new DocError(
      'Формат .doc старого образца не читается. Откройте файл в Word '
      + 'и сохраните как .docx',
      'doc_old_format',
    );
  }
  if (name.endsWith('.pdf')) {
    throw new DocError('PDF разбирается отдельно — сюда он попасть не должен', 'doc_pdf');
  }
  throw new DocError('Подойдёт .docx, .pdf, .txt или .md', 'doc_unsupported');
}
