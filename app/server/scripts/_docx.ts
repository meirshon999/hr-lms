import { crc32 } from 'node:zlib';

/**
 * Собирает настоящий файл .docx для проверок — без Word и без библиотек.
 *
 * Внутри docx лежит обычный zip, поэтому пишем zip руками, без сжатия: так
 * проверка остаётся честной (файл настоящий, его откроет и Word), а кода
 * нужно тридцать строк вместо зависимости ради тестов.
 */

interface File { name: string; data: Buffer; }

function localHeader(f: File): Buffer {
  const name = Buffer.from(f.name, 'utf8');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);              // нужная версия распаковщика
  h.writeUInt16LE(0, 6);               // флаги
  h.writeUInt16LE(0, 8);               // способ сжатия: без сжатия
  h.writeUInt32LE(crc32(f.data), 14);
  h.writeUInt32LE(f.data.length, 18);  // сжатый размер
  h.writeUInt32LE(f.data.length, 22);  // исходный размер
  h.writeUInt16LE(name.length, 26);
  return Buffer.concat([h, name]);
}

function centralEntry(f: File, offset: number): Buffer {
  const name = Buffer.from(f.name, 'utf8');
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt32LE(crc32(f.data), 16);
  h.writeUInt32LE(f.data.length, 20);
  h.writeUInt32LE(f.data.length, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, name]);
}

function zip(files: File[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const head = localHeader(f);
    central.push(centralEntry(f, offset));
    parts.push(head, f.data);
    offset += head.length + f.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Абзац: стиль необязателен, кусков текста может быть несколько — как в Word. */
const para = (runs: string[], style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}`
  + runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join('')
  + '</w:p>';

/** Регламент, похожий на настоящий: заголовки, разбитые абзацы, таблица, спецсимволы. */
export function sampleDocx(): Buffer {
  const body = [
    para(['Регламент официанта'], 'Title'),
    para(['Открытие смены'], 'Heading1'),
    para(['Смена начинается за ', 'пятнадцать', ' минут до открытия зала.']),
    para(['Сотрудник переодевается в форму &amp; проверяет чистоту станции.']),
    para(['Зоны зала'], 'Заголовок2'),
    para(['Столы у окна отдаются компаниям от четырёх человек, двойки — в центр зала.']),
    '<w:tbl>'
    + '<w:tr><w:tc><w:p><w:r><w:t>Зона</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>Кто отвечает</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>Бар</w:t></w:r></w:p></w:tc>'
    + '<w:tc><w:p><w:r><w:t>Бармен</w:t></w:r></w:p></w:tc></w:tr>'
    + '</w:tbl>',
    para(['Стоп-лист'], 'Heading2'),
    para(['Стоп-лист уточняют у &quot;шефа&quot; до 17:00 &#8212; и не позже.']),
    para(['Опоздание больше пяти минут менеджер фиксирует в смене.']),
  ].join('');

  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}<w:sectPr/></w:body></w:document>`;

  return zip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0"?><Relationships/>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(doc, 'utf8') },
  ]);
}
