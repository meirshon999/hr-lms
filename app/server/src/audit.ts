import { all, run, uuid } from './db.ts';
import { stamp } from './clock.ts';

/** Постоянный журнал действий HR/админа (в отличие от оперативной панели «События»). */
/** `ts` задаётся явно только для демо-данных: сид воспроизводит прошлые действия HR. */
export function audit(actorLogin: string, action: string, employeeId: string | null, detail = '', ts = stamp()) {
  run('INSERT INTO audit_log (id, ts, actor_login, action, employee_id, detail) VALUES (?,?,?,?,?,?)',
    uuid(), ts, actorLogin, action, employeeId, detail);
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
  transfer: 'Перевёл на другую точку',
  archive: 'Перевёл в архив',
  unarchive: 'Вернул из архива',
  extend_deadline: 'Продлил срок онбординга',
  pause: 'Поставил онбординг на паузу',
  resume: 'Снял онбординг с паузы',
  edit_profile: 'Изменил профиль',
  reset_password: 'Сбросил пароль',
  invite: 'Показал ссылку-приглашение',
  upload_file: 'Загрузил файл',
  location_add: 'Добавил точку',
  ai_apply: 'Подтвердил урок, собранный ИИ',
  publish: 'Опубликовал траекторию',
  unpublish: 'Снял траекторию с публикации',
};
