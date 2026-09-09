import { useState } from 'react';
import { post } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../components/Logo';

/**
 * Обязательная смена временного пароля.
 *
 * HR заводит сотрудника с временным паролем и передаёт его лично. Пока пароль не
 * сменён, дальше этого экрана не пускаем — иначе паролем сотрудника продолжает
 * владеть тот, кто его выдал.
 */
export function ChangePassword() {
  const { refresh, logout } = useAuth();
  const [f, setF] = useState({ current: '', next: '', repeat: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const short = f.next.length > 0 && f.next.length < 6;
  const mismatch = f.repeat.length > 0 && f.next !== f.repeat;
  const ready = f.current && f.next.length >= 6 && f.next === f.repeat;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setErr(null);
    try {
      await post('/auth/change-password', { current_password: f.current, new_password: f.next });
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? 'Не удалось сменить пароль');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '30px 16px',
      background: 'radial-gradient(120% 50% at 50% 0%, #efe0cf 0%, var(--bg) 55%)',
    }}>
      <div style={{ width: '100%', maxWidth: 420, display: 'grid', gap: 18, justifyItems: 'center' }}>
        <Logo size={40} wordmark />
        <form className="card" style={{ padding: 24, width: '100%' }} onSubmit={submit}>
          <h3 style={{ marginBottom: 4 }}>Придумайте свой пароль</h3>
          <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
            Пароль, который вам выдали, временный. Задайте свой — его не будет знать никто, кроме вас.
          </p>

          <label className="field"><span>Временный пароль</span>
            <input type="password" value={f.current} autoFocus
              onChange={(e) => setF({ ...f, current: e.target.value })} />
          </label>
          <label className="field"><span>Новый пароль</span>
            <input type="password" value={f.next}
              onChange={(e) => setF({ ...f, next: e.target.value })} />
          </label>
          {short && <div className="muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 10 }}>
            Минимум 6 символов
          </div>}
          <label className="field"><span>Ещё раз</span>
            <input type="password" value={f.repeat}
              onChange={(e) => setF({ ...f, repeat: e.target.value })} />
          </label>
          {mismatch && <div className="muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 10 }}>
            Пароли не совпадают
          </div>}

          {err && <div className="banner warn" style={{ marginBottom: 12 }}>{err}</div>}
          <button className="btn block lg" disabled={busy || !ready}>
            {busy ? 'Сохраняем…' : 'Сохранить и продолжить'}
          </button>
        </form>
        <button className="btn ghost sm" onClick={logout}>Выйти</button>
      </div>
    </div>
  );
}
