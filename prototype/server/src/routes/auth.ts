import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one } from '../db.ts';
import { authRequired, err, issueToken, loadUser, verifyPassword } from '../auth.ts';

export default async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const body = z.object({ login: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send(err('bad_request', 'login и password обязательны'));

    const u = one<any>('SELECT * FROM users WHERE login = ?', body.data.login);
    if (!u || !u.is_active || !verifyPassword(body.data.password, u.password_hash))
      return reply.code(401).send(err('bad_credentials', 'Неверный логин или пароль'));

    return { token: issueToken(u.id), role: u.role };
  });

  app.get('/me', { preHandler: authRequired() }, async (req) => {
    const u = (req as any).user;
    const employee = u.employee_id
      ? one<any>('SELECT id, full_name, stage, position_id FROM employees WHERE id = ?', u.employee_id)
      : null;
    return { user: { id: u.id, login: u.login, role: u.role }, employee };
  });

  // список демо-аккаунтов для экрана входа (только прототип)
  app.get('/demo/accounts', async () => {
    const users = all<any>(`SELECT u.login, u.role, e.full_name, e.stage
                              FROM users u LEFT JOIN employees e ON e.id = u.employee_id
                             WHERE u.is_active = 1 ORDER BY u.role, u.login`);
    return users.map((x) => ({
      login: x.login, password: `${x.login}123`, role: x.role,
      name: x.full_name ?? null, stage: x.stage ?? null,
    }));
  });
}

export { loadUser };
