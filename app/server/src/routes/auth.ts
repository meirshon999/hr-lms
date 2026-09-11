import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, run } from '../db.ts';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MIN } from '../config.ts';
import { authRequired, err, hashPassword, issueToken, loadUser, verifyPassword } from '../auth.ts';

/**
 * Защита от перебора пароля. Считаем неудачные попытки по адресу обратившегося;
 * удачный вход счётчик обнуляет. Память процесса — этого достаточно: сервер
 * один, а перезапуск бывает реже, чем окно блокировки.
 */
const attempts = new Map<string, { count: number; until: number }>();

function tooManyAttempts(ip: string): boolean {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() > a.until) { attempts.delete(ip); return false; }
  return a.count >= LOGIN_MAX_ATTEMPTS;
}

function noteFailure(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now > a.until) {
    attempts.set(ip, { count: 1, until: now + LOGIN_WINDOW_MIN * 60_000 });
  } else {
    a.count += 1;
  }
}

export default async function authRoutes(app: FastifyInstance) {
  /**
   * ВХОД ПО ССЫЛКЕ-ПРИГЛАШЕНИЮ.
   *
   * Единственный способ войти без пароля, и потому обставлен строго: ссылка
   * одноразовая, с коротким сроком, гасится в тот же миг, когда сработала.
   * Дальше человек попадает на экран смены пароля и без него никуда не пройдёт
   * — приглашение даёт вход, а не учётную запись без пароля.
   *
   * Перебор тут бессмысленнее, чем у пароля (токен случайный, 24 байта), но
   * счётчик попыток общий с обычным входом: пусть тот, кто пробует, упирается
   * в ту же стену.
   */
  app.post('/auth/invite/:token', async (req, reply) => {
    const ip = req.ip;
    if (tooManyAttempts(ip))
      return reply.code(429).send(err('too_many_attempts',
        `Слишком много попыток. Попробуйте через ${LOGIN_WINDOW_MIN} минут`));

    const token = (req.params as any).token as string;
    const inv = one<any>('SELECT * FROM invites WHERE token = ?', token);
    const bad = () => {
      noteFailure(ip);
      return reply.code(410).send(err('invite_invalid',
        'Ссылка не действует: она одноразовая и живёт трое суток. Попросите новую у кадровика'));
    };
    if (!inv || inv.used_at) return bad();
    if (new Date(inv.expires_at).getTime() < Date.now()) return bad();

    const u = one<any>('SELECT * FROM users WHERE id = ?', inv.user_id);
    if (!u || !u.is_active) return bad();

    // Гасим до выдачи токена: если что-то пойдёт не так дальше, ссылка всё
    // равно уже использована — это безопаснее, чем оставить её живой.
    run('UPDATE invites SET used_at = ? WHERE token = ?', new Date().toISOString(), token);
    // Пароль человек задаёт сам, прямо сейчас: вошёл по ссылке — поставь свой.
    run('UPDATE users SET must_change_password = 1 WHERE id = ?', u.id);

    attempts.delete(ip);
    return { token: issueToken(u.id), role: u.role, must_change_password: true };
  });

  app.post('/auth/login', async (req, reply) => {
    const ip = req.ip;
    if (tooManyAttempts(ip))
      return reply.code(429).send(err('too_many_attempts',
        `Слишком много попыток входа. Попробуйте через ${LOGIN_WINDOW_MIN} минут`));

    const body = z.object({ login: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send(err('bad_request', 'login и password обязательны'));

    const u = one<any>('SELECT * FROM users WHERE login = ?', body.data.login);
    if (!u || !u.is_active || !verifyPassword(body.data.password, u.password_hash)) {
      noteFailure(ip);
      return reply.code(401).send(err('bad_credentials', 'Неверный логин или пароль'));
    }

    attempts.delete(ip);
    return {
      token: issueToken(u.id),
      role: u.role,
      must_change_password: !!u.must_change_password,
    };
  });

  /**
   * Смена пароля. HR выдаёт временный, сотрудник обязан задать свой при первом
   * входе — после этого пароль знает только он сам.
   */
  app.post('/auth/change-password', { preHandler: authRequired() }, async (req, reply) => {
    const p = z.object({
      current_password: z.string(),
      new_password: z.string().min(6).max(72),
    }).safeParse(req.body);
    if (!p.success)
      return reply.code(400).send(err('bad_request', 'Новый пароль — минимум 6 символов'));

    const me = (req as any).user;
    const u = one<any>('SELECT * FROM users WHERE id = ?', me.id);
    if (!u || !verifyPassword(p.data.current_password, u.password_hash))
      return reply.code(401).send(err('bad_credentials', 'Текущий пароль неверен'));
    if (p.data.current_password === p.data.new_password)
      return reply.code(422).send(err('same_password', 'Новый пароль должен отличаться от текущего'));

    run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      hashPassword(p.data.new_password), me.id);
    return { ok: true };
  });

  app.get('/me', { preHandler: authRequired() }, async (req) => {
    const u = (req as any).user;
    const employee = u.employee_id
      ? one<any>('SELECT id, full_name, stage, position_id, location_id FROM employees WHERE id = ?', u.employee_id)
      : null;
    return {
      user: { id: u.id, login: u.login, role: u.role, must_change_password: u.must_change_password },
      employee,
    };
  });
}

export { loadUser };
