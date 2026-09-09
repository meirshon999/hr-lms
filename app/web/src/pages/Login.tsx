import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api';
import { useAuth } from '../auth';
import { useAsync, STAGE_LABEL } from '../lib';
import { Logo } from '../components/Logo';

interface DemoAcc { login: string; password: string; role: string; name: string | null; stage: string | null; }

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ login: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: accounts } = useAsync(() => get<DemoAcc[]>('/demo/accounts'), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await login(f.login.trim(), f.password);
      nav('/');
    } catch {
      setErr('Неверный логин или пароль');
    } finally {
      setBusy(false);
    }
  }

  const [showAll, setShowAll] = useState(false);
  const NAMED = ['ivan', 'petr', 'olga', 'sveta'];
  const allEmployees = accounts?.filter((a) => a.role === 'employee') ?? [];
  const employees = showAll ? allEmployees : allEmployees.filter((a) => NAMED.includes(a.login));
  const staff = accounts?.filter((a) => a.role !== 'employee') ?? [];

  // Панель демо-аккаунтов существует только на тестовом стенде. В бою её нет,
  // и тогда экран должен быть узким и по центру, а не половиной пустой сетки.
  const withDemo = !!accounts?.length;

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      // снизу оставляем место только под демо-панель, которой в бою нет
      padding: withDemo ? '30px 16px 90px' : '30px 16px',
      background: 'radial-gradient(120% 50% at 50% 0%, #efe0cf 0%, var(--bg) 55%)',
    }}>
      <div style={{ width: '100%', maxWidth: withDemo ? 760 : 420, display: 'grid', gap: 20,
        gridTemplateColumns: 'minmax(0,1fr)' }}>
        <div style={{ textAlign: 'center', display: 'grid', justifyItems: 'center', gap: 6 }}>
          <Logo size={44} wordmark />
          <p className="muted" style={{ marginTop: 2 }}>Обучение новых сотрудников</p>
        </div>

        <div style={{ display: 'grid', gap: 18, gridTemplateColumns: '1fr', alignItems: 'start' }}
          className={withDemo ? 'login-grid' : undefined}>
          <form className="card" style={{ padding: 24 }} onSubmit={submit}>
            <h3 style={{ marginBottom: 14 }}>Вход</h3>
            <label className="field"><span>Логин</span>
              <input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} autoFocus />
            </label>
            <label className="field"><span>Пароль</span>
              <input type="password" value={f.password}
                onChange={(e) => setF({ ...f, password: e.target.value })} />
            </label>
            {err && <div className="banner warn" style={{ marginBottom: 12 }}>{err}</div>}
            <button className="btn block lg" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
          </form>

          {!!accounts?.length && <div className="card" style={{ padding: 20 }}>
            <h3 style={{ marginBottom: 4 }}>Демо-аккаунты</h3>
            <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              Нажмите, чтобы подставить в форму. Пароль = логин + «123».
            </p>
            <div className="muted" style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', margin: '4px 0 6px' }}>Управление</div>
            {staff.map((a) => <AccBtn key={a.login} a={a} onPick={() => setF({ login: a.login, password: a.password })} />)}
            <div className="muted" style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', margin: '12px 0 6px' }}>Сотрудники по сценарию</div>
            {employees.map((a) => <AccBtn key={a.login} a={a} onPick={() => setF({ login: a.login, password: a.password })} />)}
            {!showAll && allEmployees.length > employees.length && (
              <button className="btn ghost sm" style={{ marginTop: 4 }} onClick={() => setShowAll(true)}>
                + ещё {allEmployees.length - employees.length} для аналитики
              </button>
            )}
          </div>}
        </div>
      </div>
      <style>{`@media(min-width:720px){.login-grid{grid-template-columns:1fr 1fr!important}}`}</style>
    </div>
  );
}

function AccBtn({ a, onPick }: { a: DemoAcc; onPick: () => void }) {
  return (
    <button onClick={onPick} style={{
      display: 'flex', width: '100%', gap: 8, alignItems: 'center', textAlign: 'left',
      padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 9, marginBottom: 6, background: '#fff',
    }}>
      <b style={{ fontFamily: 'monospace' }}>{a.login}</b>
      <span className="muted" style={{ flex: 1, fontSize: 13 }}>
        {a.name ?? (a.role === 'hr' ? 'HR' : 'Администратор')}
      </span>
      {a.stage && <span className={`pill stage-${a.stage}`}>{STAGE_LABEL[a.stage]}</span>}
    </button>
  );
}
