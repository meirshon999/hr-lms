import { closeSync, openSync, readSync } from 'node:fs';

/**
 * ДЛИТЕЛЬНОСТЬ ВИДЕО ИЗ САМОГО ФАЙЛА.
 *
 * Зачем вообще. Онбординг обязан отвечать на вопрос «человек посмотрел ролик
 * или пролистал», а ответить на него можно, только зная, сколько ролик длится.
 * Если длительность присылает браузер, вся проверка держится на честном слове
 * того, кого и проверяют: назвал ролик десятисекундным — «досмотрел» за десять
 * секунд. Поэтому читаем из файла.
 *
 * Как устроен mp4. Файл — дерево «боксов»: четыре байта длины, четыре байта
 * имени, дальше содержимое. Нужен один бокс — `mvhd` внутри `moov`: в нём
 * лежат частота отсчётов и число отсчётов, их частное и есть секунды.
 *
 * Читаем с диска кусками, а не целиком: ролик на пятнадцать минут весит
 * сотни мегабайт, и поднимать его в память ради двенадцати байт незачем.
 *
 * Что не берём: webm (другой формат контейнера, EBML). Для него вернём null,
 * и система честно скажет, что длительность неизвестна, вместо того чтобы
 * выдумать её.
 */

/** Боксы, внутрь которых имеет смысл спускаться. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia']);

export function videoDurationSec(path: string): number | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    return scan(fd, 0, Number.MAX_SAFE_INTEGER, 0);
  } catch {
    // Битый или незнакомый файл — не поломка: длительность просто неизвестна.
    return null;
  } finally {
    closeSync(fd);
  }
}

function scan(fd: number, from: number, until: number, depth: number): number | null {
  if (depth > 6) return null;
  const head = Buffer.alloc(16);
  let pos = from;

  while (pos < until) {
    if (readSync(fd, head, 0, 16, pos) < 8) return null;
    let size = head.readUInt32BE(0);
    const name = head.toString('latin1', 4, 8);
    let headLen = 8;

    if (size === 1) {
      // 64-битный размер лежит следом за именем.
      const hi = head.readUInt32BE(8);
      const lo = head.readUInt32BE(12);
      size = hi * 2 ** 32 + lo;
      headLen = 16;
    } else if (size === 0) {
      size = until - pos; // бокс до конца файла
    }
    if (size < headLen) return null;

    if (name === 'mvhd') return mvhd(fd, pos + headLen);
    if (CONTAINERS.has(name)) {
      const inner = scan(fd, pos + headLen, pos + size, depth + 1);
      if (inner !== null) return inner;
    }
    pos += size;
  }
  return null;
}

/** Внутри mvhd: версия, даты, затем частота отсчётов и их число. */
function mvhd(fd: number, at: number): number | null {
  const buf = Buffer.alloc(28);
  if (readSync(fd, buf, 0, 28, at) < 20) return null;
  const version = buf[0];
  // Версия 1 хранит даты и длительность 64-битными, версия 0 — 32-битными.
  const timescale = version === 1 ? buf.readUInt32BE(20) : buf.readUInt32BE(12);
  const duration = version === 1
    ? Number(buf.readBigUInt64BE(24))
    : buf.readUInt32BE(16);
  if (!timescale || !duration) return null;
  const sec = Math.round(duration / timescale);
  // Сутки — заведомо не обучающий ролик: значит, прочитали не то.
  return sec > 0 && sec < 86400 ? sec : null;
}
