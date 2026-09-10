import { useState } from 'react';
import { ApiError, get, patch, post } from '../../api';
import { useAsync, Loader, ErrorBox, useToast } from '../../lib';
import { useAuth } from '../../auth';

/**
 * Аккаунты кадровиков и администраторов. Экран только для администратора.
 *
 * Аккаунты сотрудников заводятся не здесь, а вместе с человеком в «Сотрудниках»:
 * это разные вещи — учётка для работы в системе и учётка новичка, который учится.
 */

interface User {
  id: string; login: string; role: 'hr' | 'admin';
  is_active: boolean; must_change_password: boolean;
}

const ROLE_LABEL: Record<string, string> = { hr: 'Кадровик', admin: 'Администратор' };

export function Accounts() {
  const { me } = useAuth();
  const { data, loading, error, reload } = useAsync(() => get<{ items: User[] }>('/users'), []);
  const [adding, setAdding] = useState(false);
  /** Пароль показывается ровно один раз: в базе он лежит только свёрткой. */
  const [shown, setShown] = useState<{ login: string; password: string } | null>(null);

  return (
    <>
      <h1>Аккаунты</h1>
      <p className="subtitle">Кто может работать в системе</p>

      <div className="toolbar">
        <span className="grow muted" style={{ fontSize: 13 }}>
          Учётки сотрудников заводятся в разделе «Сотрудники» вместе с человеком.
        </span>
        <button className="btn sm" onClick={() => setAdding(true)}>+ Новый аккаунт</button>
      </div>

      {shown && (
        <div className="panel" style={{ marginBottom: 14, borderLeft: '3px solid var(--accent)' }}>
          <b>Пароль для «{shown.login}»</b>
          <div style={{ fontSize: 22, fontFamily: 'monospace', margin: '8px 0' }}>{shown.password}</div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Запишите его сейчас — второй раз система его не покажет. При первом входе
            человек обязан сменить пароль на свой.
          </p>
          <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => setShown(null)}>
            Записал, скрыть
          </button>
        </div>
      )}

      {loading && <Loader />}
      {error && <ErrorBox error={error} onRetry={reload} />}

      {data && (
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="grid" style={{ margin: 0 }}>
            <thead>
              <tr><th>Логин</th><th>Роль</th><th>Состояние</th><th /></tr>
            </thead>
            <tbody>
              {data.items.map((u) => (
                <Row key={u.id} u={u} isMe={u.login === me?.user.login}
                  onDone={reload} onPassword={setShown} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onCreated={(r) => { setShown(r); setAdding(false); reload(); }}
        />
      )}
    </>
  );
}

function Row({ u, isMe, onDone, onPassword }: {
  u: User; isMe: boolean; onDone: () => void;
  onPassword: (r: { login: string; password: string }) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<any>, ok: string) {
    setBusy(true);
    try { await fn(); toast(ok); onDone(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  }

  return (
    <tr style={{ opacity: u.is_active ? 1 : 0.55 }}>
      <td>
        <b>{u.login}</b>
        {isMe && <span className="muted" style={{ fontSize: 12 }}> · это вы</span>}
      </td>
      <td>{ROLE_LABEL[u.role]}</td>
      <td>
        {u.is_active ? 'работает' : 'отключён'}
        {u.must_change_password && u.is_active && (
          <span className="muted" style={{ fontSize: 12 }}> · пароль временный</span>
        )}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button className="btn sm ghost" disabled={busy}
          onClick={() => act(
            async () => onPassword(await post(`/users/${u.id}/reset-password`)),
            'Пароль сброшен',
          )}>
          Сбросить пароль
        </button>{' '}
        {/* Отключить себя нельзя — иначе можно запереть систему изнутри. */}
        <button className="btn sm ghost" disabled={busy || isMe}
          title={isMe ? 'Собственный аккаунт отключить нельзя' : ''}
          onClick={() => act(
            () => patch(`/users/${u.id}`, { is_active: !u.is_active }),
            u.is_active ? 'Аккаунт отключён' : 'Аккаунт включён',
          )}>
          {u.is_active ? 'Отключить' : 'Включить'}
        </button>
      </td>
    </tr>
  );
}

function AddDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (r: { login: string; password: string }) => void;
}) {
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<'hr' | 'admin'>('hr');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true); setErr('');
    try {
      const r = await post<{ login: string; password: string }>('/users', { login: login.trim(), role });
      onCreated(r);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось');
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Новый аккаунт</h3>
        <label>Логин
          <input value={login} onChange={(e) => setLogin(e.target.value)}
            placeholder="например, hr.astana" autoFocus />
        </label>
        <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
          Латиница, цифры, точка или дефис.
        </p>
        <label>Роль
          <select value={role} onChange={(e) => setRole(e.target.value as 'hr' | 'admin')}>
            <option value="hr">Кадровик — люди, каталог, аналитика</option>
            <option value="admin">Администратор — ещё аккаунты, точки и журнал</option>
          </select>
        </label>
        <p className="muted" style={{ fontSize: 13 }}>
          Пароль система придумает сама и покажет один раз.
        </p>
        {err && <p style={{ color: 'var(--error)', fontSize: 13 }}>{err}</p>}
        <div className="row">
          <button className="btn ghost" onClick={onClose}>Отмена</button>
          <button className="btn" disabled={busy || login.trim().length < 2} onClick={submit}>
            {busy ? 'Создаём…' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
