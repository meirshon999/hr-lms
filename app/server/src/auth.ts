import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TOKEN_SECRET, TOKEN_TTL_HOURS } from './config.ts';
import { one } from './db.ts';

export type Role = 'employee' | 'hr' | 'admin';
export interface AuthUser {
  id: string; login: string; role: Role; employee_id: string | null;
  /** Выдан временный пароль — до смены пускаем только на экран смены пароля. */
  must_change_password: boolean;
}

// --- пароли (scrypt, соль в строке) ---
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const test = scryptSync(pw, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return test.length === orig.length && timingSafeEqual(test, orig);
}

// --- токен: base64url(payload).base64url(hmac) ---
const b64u = (b: Buffer) => b.toString('base64url');
function sign(payloadJson: string): string {
  const body = b64u(Buffer.from(payloadJson));
  const sig = b64u(createHmac('sha256', TOKEN_SECRET).update(body).digest());
  return `${body}.${sig}`;
}
export function issueToken(userId: string): string {
  const exp = Date.now() + TOKEN_TTL_HOURS * 3600_000;
  return sign(JSON.stringify({ uid: userId, exp }));
}
export function readToken(token: string): { uid: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = b64u(createHmac('sha256', TOKEN_SECRET).update(body).digest());
  if (sig !== expect) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return { uid: p.uid };
  } catch { return null; }
}

// --- fastify preHandler ---
export function loadUser(req: FastifyRequest): AuthUser | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  const t = readToken(h.slice(7));
  if (!t) return null;
  const u = one<any>(
    'SELECT id, login, role, employee_id, is_active, must_change_password FROM users WHERE id = ?',
    t.uid);
  if (!u || !u.is_active) return null;
  return {
    id: u.id, login: u.login, role: u.role, employee_id: u.employee_id,
    must_change_password: !!u.must_change_password,
  };
}

export function authRequired(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const u = loadUser(req);
    if (!u) return reply.code(401).send(err('unauthorized', 'Нужен вход'));
    if (roles.length && !roles.includes(u.role))
      return reply.code(403).send(err('forbidden', 'Недостаточно прав'));
    (req as any).user = u;
  };
}

export const err = (code: string, message: string, details?: unknown) => ({
  error: { code, message, ...(details ? { details } : {}) },
  request_id: randomBytes(6).toString('hex'),
});
