import { deflateSync } from 'node:zlib';

/**
 * Настоящий PDF, собранный в памяти, — для проверок разбора.
 *
 * Зачем так, а не готовый файл в репозитории. Проверка должна ломаться, если
 * сломался разбор, а не если кто-то случайно тронул двоичный файл. К тому же
 * здесь видно, что именно проверяется: сжатый поток, таблица перевода кодов
 * в кириллицу, координаты строк.
 *
 * Кириллица — главное, ради чего это написано. В потоке PDF лежат не буквы,
 * а номера глифов шрифта; перевод даёт таблица `ToUnicode`. Наш разборщик
 * без неё русский текст читать не может и не должен делать вид, что может.
 */

/** Текст страницы: строки и расстояние между ними. */
export interface PageSpec {
  lines: string[];
  /** Расстояние между абзацами — по нему разборщик и отличает абзац от строки. */
  gapAfter?: number[];
}

/**
 * Собирает PDF со сжатыми потоками, шрифтом Type0 и таблицей ToUnicode.
 * Коды глифов назначаются подряд по мере встречи символов — так же поступают
 * настоящие издатели PDF, когда встраивают только используемые глифы.
 */
export function samplePdf(pages: PageSpec[], opts: { compress?: boolean } = {}): Buffer {
  const compress = opts.compress !== false;

  // ---- назначаем каждому символу свой двухбайтовый код ----
  const code = new Map<string, number>();
  for (const p of pages) {
    for (const line of p.lines) {
      for (const ch of line) if (!code.has(ch)) code.set(ch, code.size + 1);
    }
  }

  const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
  const bf = [...code.entries()]
    .map(([ch, c]) => `<${hex4(c)}> <${hex4(ch.charCodeAt(0))}>`)
    .join('\n');
  const toUnicode = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${code.size} beginbfchar
${bf}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  // ---- содержимое страниц ----
  const contents = pages.map((p) => {
    const out: string[] = ['BT', '/F1 12 Tf'];
    let y = 760;
    p.lines.forEach((line, i) => {
      out.push(`1 0 0 1 72 ${y} Tm`);
      const hex = [...line].map((ch) => hex4(code.get(ch)!)).join('');
      out.push(`<${hex}> Tj`);
      y -= p.gapAfter?.[i] ?? 14;
    });
    out.push('ET');
    return out.join('\n');
  });

  // ---- объекты ----
  const objects: string[] = [];
  const streams = new Map<number, Buffer>();
  const add = (body: string, stream?: Buffer) => {
    objects.push(body);
    if (stream) streams.set(objects.length, stream);
    return objects.length;
  };

  const pageIds: number[] = [];
  const contentIds: number[] = [];
  for (const c of contents) {
    contentIds.push(add('<< /Length %L% %F% >>', Buffer.from(c, 'latin1')));
  }
  const tuId = add('<< /Length %L% %F% >>', Buffer.from(toUnicode, 'latin1'));

  const descId = add('<< /Type /FontDescriptor /FontName /TestFont /Flags 4 '
    + '/FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 '
    + '/CapHeight 700 /StemV 80 >>');
  const cidId = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont `
    + `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> `
    + `/FontDescriptor ${descId} 0 R /DW 500 >>`);
  const fontId = add(`<< /Type /Font /Subtype /Type0 /BaseFont /TestFont `
    + `/Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${tuId} 0 R >>`);
  const resId = add(`<< /Font << /F1 ${fontId} 0 R >> >>`);

  const pagesId = objects.length + pages.length + 1;
  for (let i = 0; i < pages.length; i++) {
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] `
      + `/Resources ${resId} 0 R /Contents ${contentIds[i]} 0 R >>`));
  }
  const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] `
    + `/Count ${pages.length} >>`);
  const rootId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  // ---- сборка файла ----
  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n', 'latin1')];
  const offsets: number[] = [];
  let pos = parts[0].length;

  objects.forEach((body, i) => {
    const num = i + 1;
    const raw = streams.get(num);
    let text = body;
    let data: Buffer | null = null;
    if (raw) {
      data = compress ? deflateSync(raw) : raw;
      text = body.replace('%L%', String(data.length))
        .replace('%F%', compress ? '/Filter /FlateDecode' : '');
    }
    const head = Buffer.from(`${num} 0 obj\n${text}\n`, 'latin1');
    const tail = data
      ? Buffer.concat([Buffer.from('stream\n', 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')])
      : Buffer.from('endobj\n', 'latin1');
    offsets[num] = pos;
    parts.push(head, tail);
    pos += head.length + tail.length;
  });

  const xrefAt = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objects.length; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}

/** PDF без текстового слоя: страница есть, букв нет — так выглядит скан. */
export function scannedPdf(): Buffer {
  return samplePdf([{ lines: [] }]);
}
