import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { TOKEN_SECRET } from './config.ts';

/**
 * ШИФРОВАНИЕ СЕКРЕТОВ, КОТОРЫЕ ЛЕЖАТ В БАЗЕ.
 *
 * Нужно ровно из-за одного свойства продукта: он переезжает копированием файла
 * базы. Значит, ключ ИИ, заданный в интерфейсе, уехал бы вместе с копией —
 * и в резервной копии, и при передаче базы другому человеку. Для того, кто
 * платит за ИИ своим ключом, это прямая утечка денег.
 *
 * Поэтому ключ лежит в базе зашифрованным на `TOKEN_SECRET` — переменной
 * сервера, которой в базе нет. Копия базы без этой переменной бесполезна:
 * расшифровать нечем, и система честно говорит «ключ задан на другом сервере,
 * вставьте свой», а не молча шлёт чужой ключ провайдеру.
 *
 * Смена `TOKEN_SECRET` делает сохранённый ключ нечитаемым — это не поломка,
 * а то самое поведение, ради которого всё сделано.
 *
 * AES-256-GCM: шифрует и заодно подписывает, подменить кусок молча нельзя.
 */

const KEY = createHash('sha256').update(TOKEN_SECRET).digest();
const PREFIX = 'v1';

/** Зашифрованное значение — одна строка, чтобы легло в обычную колонку. */
export function seal(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [PREFIX, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/**
 * Расшифровка. Не получилось — возвращаем `null`, а не бросаем: это ожидаемый
 * случай (база приехала с другого сервера), и звать его ошибкой неправильно.
 */
export function open(sealed: string | undefined): string | null {
  if (!sealed) return null;
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(parts[1], 'base64'));
    d.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
  } catch {
    // Другой TOKEN_SECRET или повреждённая строка — ключа у нас нет, и всё.
    return null;
  }
}

/** Есть ли вообще что расшифровывать — отдельно от того, вышло ли это сделать. */
export const isSealed = (v: string | undefined): boolean => !!v && v.startsWith(PREFIX + ':');
