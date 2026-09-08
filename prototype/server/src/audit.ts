import { all, run, uuid } from './db.ts';
import { stamp } from './clock.ts';

/** Постоянный журнал действий HR/админа (в отличие от оперативной панели «События»). */
export function audit(actorLogin: string, action: string, employeeId: string | null, detail = '') {
  run('INSERT INTO audit_log (id, ts, actor_login, action, employee_id, detail) VALUES (?,?,?,?,?,?)',
    uuid(), stamp(), actorLogin, action, employeeId, detail);
}

export function auditFor(employeeId: string) {
  return all<any>(
    'SELECT ts, actor_login, action, detail FROM audit_log WHERE employee_id = ? ORDER BY ts DESC LIMIT 50',
    employeeId,
  );
}

export function auditRecent(limit = 100) {
  return all<any>(
    'SELECT ts, actor_login, action, employee_id, detail FROM audit_log ORDER BY ts DESC LIMIT ?', limit,
  );
}

export const ACTION_LABEL: Record<string, string> = {
  hire: 'Завёл сотрудника',
  internship_passed: 'Отметил стажировку пройденной',
  internship_failed: 'Стажировка не пройдена — профиль удалён',
  archive: 'Перевёл в архив',
  edit_profile: 'Изменил профиль',
  reset_password: 'Сбросил пароль',
  invite: 'Показал ссылку-приглашение',
  publish: 'Опубликовал траекторию',
  unpublish: 'Снял траекторию с публикации',
};
