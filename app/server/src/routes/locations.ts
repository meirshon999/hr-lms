import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, uuid } from '../db.ts';
import { authRequired, err } from '../auth.ts';
import { audit } from '../audit.ts';

const actor = (req: any) => req?.user?.login ?? 'system';

const schema = z.object({
  name: z.string().min(1).max(120),
  city: z.string().max(80).optional().nullable(),
});

/**
 * Точки сети: ресторан, караоке, боулинг. Справочник маленький и меняется редко,
 * но на него завязано всё — сотрудник, контент урока и аналитика.
 */
export default async function locationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('hr', 'admin'));

  app.get('/locations', async (req) => {
    const q = req.query as Record<string, string>;
    const rows = q.include_inactive
      ? all<any>('SELECT * FROM locations ORDER BY ord, name')
      : all<any>('SELECT * FROM locations WHERE is_active = 1 ORDER BY ord, name');
    return {
      items: rows.map((l) => ({
        id: l.id, name: l.name, city: l.city, is_active: !!l.is_active,
        employees: one<{ n: number }>(
          `SELECT COUNT(*) n FROM employees WHERE location_id = ? AND stage != 'archived'`, l.id)!.n,
      })),
    };
  });

  app.post('/locations', async (req, reply) => {
    const p = schema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Название обязательно'));
    if (one('SELECT 1 FROM locations WHERE name = ?', p.data.name))
      return reply.code(422).send(err('name_exists', 'Точка с таким названием уже есть'));
    const id = uuid();
    const ord = one<{ n: number }>('SELECT COALESCE(MAX(ord),0) n FROM locations')!.n + 1;
    run('INSERT INTO locations (id, name, city, ord, is_active) VALUES (?,?,?,?,1)',
      id, p.data.name, p.data.city ?? null, ord);
    audit(actor(req), 'location_add', null, p.data.name);
    return reply.code(201).send({ id });
  });

  app.patch('/locations/:id', async (req, reply) => {
    const id = (req.params as any).id;
    const cur = one<any>('SELECT * FROM locations WHERE id = ?', id);
    if (!cur) return reply.code(404).send(err('not_found', 'Точка не найдена'));
    const p = schema.partial().extend({ is_active: z.boolean().optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте поля'));

    // Закрыть точку, на которой ещё кто-то учится, значит оставить людей без
    // траектории — сначала переведите их.
    if (p.data.is_active === false) {
      const n = one<{ n: number }>(
        `SELECT COUNT(*) n FROM employees WHERE location_id = ? AND stage != 'archived'`, id)!.n;
      if (n > 0)
        return reply.code(409).send(err('has_employees',
          `На точке ещё ${n} действующих сотрудников — переведите их на другую точку`));
    }

    run('UPDATE locations SET name = ?, city = ?, is_active = ? WHERE id = ?',
      p.data.name ?? cur.name,
      p.data.city === undefined ? cur.city : (p.data.city ?? null),
      p.data.is_active === undefined ? cur.is_active : (p.data.is_active ? 1 : 0),
      id);
    return { ok: true };
  });
}
