import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, post, setToken } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../components/Logo';

/**
 * ВХОД ПО ССЫЛКЕ-ПРИГЛАШЕНИЮ.
 *
 * Экрана как такового нет: человек открывает ссылку, и его сразу пускают
 * внутрь, а дальше — на выбор пароля. Просить его тут что-то нажимать незачем.
 *
 * По-настоящему этот экран нужен ради отказа. Ссылка одноразовая и живёт
 * трое суток, так что «уже не работает» будет случаться, и человек должен
 * понять, что делать, а не смотреть в пустую страницу.
 */
export function Invite() {
  const { token } = useParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  // Строгий режим React вызывает эффект дважды, а приглашение одноразовое:
  // второй вызов погасил бы только что выданный вход.
  const used = useRef(false);

  useEffect(() => {
    if (used.current || !token) return;
    used.current = true;
    (async () => {
      try {
        const r = await post<{ token: string }>(`/auth/invite/${token}`);
        setToken(r.token);
        await refresh();
        nav('/', { replace: true });
      } catch (e) {
        setErr(e instanceof ApiError ? e.message : 'Ссылка не сработала');
      }
    })();
  }, [token, nav, refresh]);

  return (
    <div style={{
      minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: '30px 16px',
      background: 'radial-gradient(120% 50% at 50% 0%, #efe0cf 0%, var(--bg) 55%)',
    }}>
      <div style={{ width: '100%', maxWidth: 420, display: 'grid', gap: 20, justifyItems: 'center' }}>
        <Logo size={44} wordmark />
        <div className="card" style={{ padding: 24, width: '100%' }}>
          {err ? (
            <>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>Ссылка не действует</h3>
              <div className="banner warn" style={{ fontSize: 13.5, marginBottom: 14 }}>{err}</div>
              <button className="btn" style={{ width: '100%' }}
                onClick={() => nav('/login', { replace: true })}>
                Войти по логину и паролю
              </button>
            </>
          ) : (
            <p className="muted" style={{ margin: 0, textAlign: 'center' }}>Заходим…</p>
          )}
        </div>
      </div>
    </div>
  );
}
