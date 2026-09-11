import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { MAX_BACKDATE_DAYS } from '../config.ts';
import { all, one, run, uuid } from '../db.ts';
import { authRequired, err, hashPassword } from '../auth.ts';
import { addDays, stamp, today } from '../clock.ts';
import {
  archiveEmployee, deleteEmployeeCompletely, extendDeadline, pauseOnboarding,
  recomputePreOnboardingDone, resumeOnboarding, takePreSnapshot, transferToLocation,
  trajectoryOfPosition, tryOpenOnboarding, unarchiveEmployee,
} from '../domain.ts';
import { iinProblem, normalizeIin } from '../iin.ts';
import { audit, auditFor } from '../audit.ts';
import { emit } from '../events.ts';
import { employeeCard, employeeRow } from '../serializers.ts';

/** Сколько живёт ссылка-приглашение. Трое суток: выйти в первую смену успевают,
    а забытая в переписке ссылка перестаёт быть ключом от системы. */
const INVITE_HOURS = 72;

/** Сколько сотрудников отдаём за раз, если страницу не попросили явно. */
const DEFAULT_PAGE = 50;

const actor = (req: any) => (req as any).user?.login ?? 'system';

const createSchema = z.object({
  // Длину и контрольную сумму проверяет iinProblem — у него внятное сообщение
  iin: z.string().min(1).max(20),
  full_name: z.string().min(1).max(160),
  position_id: z.string(),
  location_id: z.string(),
  phone: z.string().min(3).max(20),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  login: z.string().min(2).max(40),
  password: z.string().min(6).max(72),
});

export default async function employeeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('hr', 'admin'));

  app.get('/employees', async (req) => {
    const q = req.query as Record<string, string>;
    let rows = all<any>('SELECT * FROM employees ORDER BY created_at DESC');
    if (!q.include_archived) rows = rows.filter((e) => e.stage !== 'archived');
    if (q.stage) rows = rows.filter((e) => e.stage === q.stage);
    if (q.position_id) rows = rows.filter((e) => e.position_id === q.position_id);
    if (q.location_id) rows = rows.filter((e) => e.location_id === q.location_id);
    if (q.search) {
      const s = q.search.toLowerCase();
      const digits = s.replace(/\D/g, '');
      rows = rows.filter((e) =>
        e.full_name.toLowerCase().includes(s)
        || e.phone.includes(s)
        || (digits.length >= 4 && e.iin.includes(digits)));
    }
    /*
     * Постраничная выдача. При 50–70 наймах в месяц список за год переваливает
     * за тысячу, и отдавать его целиком значит подвешивать браузер на ровном
     * месте. Отбор и поиск идут по всему списку, а режется уже результат —
     * иначе поиск находил бы только то, что попало на текущую страницу.
     *
     * `total` отдаём всегда: без него интерфейс не может сказать «показано
     * 50 из 1240», а это единственное, что объясняет человеку, почему список
     * оборвался.
     */
    const total = rows.length;
    const limit = Math.min(Math.max(Number(q.limit) || DEFAULT_PAGE, 1), 500);
    const offset = Math.max(Number(q.offset) || 0, 0);
    return {
      items: rows.slice(offset, offset + limit).map(employeeRow),
      total,
      limit,
      offset,
    };
  });

  app.post('/employees', async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте поля формы', p.error.issues));
    const d = p.data;

    if (!one('SELECT 1 FROM positions WHERE id = ?', d.position_id))
      return reply.code(400).send(err('bad_position', 'Должность не найдена'));
    if (!one('SELECT 1 FROM locations WHERE id = ? AND is_active = 1', d.location_id))
      return reply.code(400).send(err('bad_location', 'Точка не найдена'));

    const iin = normalizeIin(d.iin);
    const bad = iinProblem(iin);
    if (bad) return reply.code(422).send(err('bad_iin', bad));

    // ИИН — ключ человека в сети. Имя можно записать иначе, номер один и тот же,
    // поэтому «новый» сотрудник с чужим ИИН — это тот же человек, а не однофамилец.
    const twin = one<any>(
      `SELECT e.id, e.full_name, e.stage, l.name location
         FROM employees e LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.iin = ?`, iin);
    if (twin)
      return reply.code(422).send(err('iin_exists',
        `Этот ИИН уже заведён: ${twin.full_name}, ${twin.location ?? 'без точки'}`,
        { employee_id: twin.id, stage: twin.stage }));

    if (one('SELECT 1 FROM users WHERE login = ?', d.login))
      return reply.code(422).send(err('login_exists', 'Такой логин уже занят'));
    if (d.start_date < addDays(today(), -MAX_BACKDATE_DAYS))
      return reply.code(422).send(err('start_date_too_old', `Дата выхода не может быть раньше чем ${MAX_BACKDATE_DAYS} дней назад`));

    const userId = uuid();
    const empId = uuid();
    // Пароль временный: HR передаёт его сотруднику, тот обязан сменить при входе.
    run('INSERT INTO users (id, login, password_hash, role, employee_id, must_change_password) VALUES (?,?,?,?,?,1)',
      userId, d.login, hashPassword(d.password), 'employee', empId);
    run(`INSERT INTO employees (id, user_id, iin, full_name, position_id, location_id, phone, start_date, stage, created_at)
         VALUES (?,?,?,?,?,?,?,?, 'intern', ?)`,
      empId, userId, iin, d.full_name, d.position_id, d.location_id, d.phone, d.start_date, stamp());

    takePreSnapshot(empId);
    recomputePreOnboardingDone(empId);
    const posName = one<{ name: string }>('SELECT name FROM positions WHERE id = ?', d.position_id)?.name;
    emit('нанят', `${d.full_name} — ${posName}, выход ${d.start_date}`);
    audit(actor(req), 'hire', empId, `${d.full_name}, ${posName}, выход ${d.start_date}`);

    const traj = trajectoryOfPosition(d.position_id);
    const warnings = (!traj || traj.status !== 'active') ? ['no_active_trajectory'] : [];
    const e = one<any>('SELECT * FROM employees WHERE id = ?', empId);
    return reply.code(201).send({ employee: employeeCard(e), warnings });
  });

  app.get('/employees/:id', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    return employeeCard(e);
  });

  app.patch('/employees/:id', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    const p = z.object({
      full_name: z.string().min(1).max(160).optional(),
      phone: z.string().min(3).max(20).optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте поля'));
    if (p.data.phone && p.data.phone !== e.phone
        && one('SELECT 1 FROM employees WHERE phone = ? AND id != ?', p.data.phone, e.id))
      return reply.code(422).send(err('phone_exists', 'Сотрудник с таким телефоном уже есть'));
    run('UPDATE employees SET full_name = ?, phone = ? WHERE id = ?',
      p.data.full_name ?? e.full_name, p.data.phone ?? e.phone, e.id);
    audit(actor(req), 'edit_profile', e.id, JSON.stringify(p.data));
    return { ok: true };
  });

  app.get('/employees/:id/audit', async (req) => ({ items: auditFor((req.params as any).id) }));

  app.post('/employees/:id/reset-password', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    const pw = 'pg-' + Math.random().toString(36).slice(2, 8);
    run('UPDATE users SET password_hash = ? WHERE employee_id = ?', hashPassword(pw), e.id);
    audit(actor(req), 'reset_password', e.id, '');
    return { password: pw };
  });

  /**
   * ССЫЛКА-ПРИГЛАШЕНИЕ.
   *
   * Заменяет собой «придумал пароль, записал, переслал в мессенджере». При
   * пятидесяти наймах в месяц это пятьдесят паролей, гуляющих по переписке
   * и оседающих в ней навсегда.
   *
   * По ссылке человек попадает внутрь сразу и первым делом задаёт свой пароль.
   * Раз ссылка пускает в систему, она **одноразовая и живёт трое суток**:
   * попавшая не в те руки, она не должна работать вечно. Прежние
   * неиспользованные приглашения этого человека гасим — действующее всегда одно.
   */
  app.post('/employees/:id/invite', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    const u = one<{ id: string; login: string }>(
      'SELECT id, login FROM users WHERE employee_id = ?', e.id);
    if (!u) return reply.code(404).send(err('not_found', 'У сотрудника нет входа'));

    run('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL', u.id);
    const token = randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + INVITE_HOURS * 3600_000).toISOString();
    run('INSERT INTO invites (token, user_id, created_at, expires_at) VALUES (?,?,?,?)',
      token, u.id, stamp(), expires);

    // адрес берём из запроса: на боевом стенде это его домен, а не localhost
    const origin = (req.headers.origin as string)
      || `${(req.headers['x-forwarded-proto'] as string) ?? req.protocol}://${req.headers.host}`;
    audit(actor(req), 'invite', e.id, `ссылка действует до ${expires.slice(0, 10)}`);
    return {
      invite_url: `${origin}/#/invite/${token}`,
      login: u.login,
      expires_at: expires,
      hours: INVITE_HOURS,
    };
  });

  app.post('/employees/:id/internship-passed', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    if (e.stage !== 'intern') return reply.code(409).send(err('not_intern', 'Сотрудник уже не на стажировке'));
    run('UPDATE employees SET internship_passed = 1 WHERE id = ?', e.id);
    const open = tryOpenOnboarding(e.id);
    audit(actor(req), 'internship_passed', e.id, open.opened ? 'онбординг открыт' : `ждём: ${open.reason}`);
    return { ok: true, onboarding_opened: open.opened, reason: open.reason ?? null };
  });

  app.post('/employees/:id/internship-failed', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    if (e.stage !== 'intern') return reply.code(409).send(err('not_intern', 'Можно удалить только сотрудника на стажировке'));
    audit(actor(req), 'internship_failed', null, `${e.full_name} (${e.phone}) — профиль удалён`);
    deleteEmployeeCompletely(e.id);
    return { ok: true, deleted: true };
  });

  /**
   * Перевод на другую точку. Общие уроки остаются сданными, точечные открываются
   * заново под новую точку — подробности в domain.transferToLocation.
   */
  app.post('/employees/:id/transfer', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    if (e.stage === 'archived') return reply.code(409).send(err('archived', 'Сотрудник в архиве'));
    const p = z.object({ location_id: z.string() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Нужна точка'));

    const r = transferToLocation(e.id, p.data.location_id);
    if (!r.moved) {
      const msg = r.reason === 'same_location' ? 'Сотрудник уже на этой точке' : 'Точка не найдена';
      return reply.code(409).send(err(r.reason ?? 'cannot_transfer', msg));
    }
    const to = one<{ name: string }>('SELECT name FROM locations WHERE id = ?', p.data.location_id)?.name;
    audit(actor(req), 'transfer', e.id,
      `на «${to}»` + (r.redo ? `; заново: ${r.redo}, зачтено: ${r.kept}, добавлено: ${r.added}` : ''));
    return { ok: true, ...r };
  });

  app.post('/employees/:id/archive', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    if (e.stage === 'archived') return { ok: true, already: true };
    archiveEmployee(e.id);
    audit(actor(req), 'archive', e.id, '');
    return { ok: true };
  });

  app.post('/employees/:id/unarchive', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    const r = unarchiveEmployee(e.id);
    if (!r) return reply.code(409).send(err('not_archived', 'Сотрудник не в архиве'));
    audit(actor(req), 'unarchive', e.id, `возвращён на этап «${r.stage}»`);
    return { ok: true, stage: r.stage };
  });

  app.post('/employees/:id/extend-deadline', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    const p = z.object({ days: z.number().int().min(1).max(90) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'days — целое от 1 до 90'));
    const r = extendDeadline(e.id, p.data.days);
    if (!r) return reply.code(409).send(err('not_onboarding', 'Продлить можно только идущий онбординг'));
    audit(actor(req), 'extend_deadline', e.id, `+${p.data.days} дн., до ${r.due}`);
    return { ok: true, onboarding_due_date: r.due };
  });

  app.post('/employees/:id/pause', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    if (!pauseOnboarding(e.id))
      return reply.code(409).send(err('cannot_pause', 'Пауза возможна только для идущего онбординга'));
    audit(actor(req), 'pause', e.id, '');
    return { ok: true };
  });

  app.post('/employees/:id/resume', async (req, reply) => {
    const e = one<any>('SELECT * FROM employees WHERE id = ?', (req.params as any).id);
    if (!e) return reply.code(404).send(err('not_found', 'Сотрудник не найден'));
    const r = resumeOnboarding(e.id);
    if (!r) return reply.code(409).send(err('not_paused', 'Онбординг не на паузе'));
    audit(actor(req), 'resume', e.id, `пауза ${r.days} дн., дедлайн до ${r.due}`);
    return { ok: true, paused_days: r.days, onboarding_due_date: r.due };
  });
}
