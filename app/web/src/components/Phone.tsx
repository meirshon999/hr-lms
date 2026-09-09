import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Logo } from './Logo';

/**
 * Мобильный app-shell: компактная липкая шапка + прокручиваемое тело +
 * липкая нижняя панель с главным действием (достаётся большим пальцем).
 */
export function Phone({
  hello, sub, back, action, actionHint, children,
}: {
  hello: string; sub?: string; back?: boolean;
  action?: ReactNode; actionHint?: string; children: ReactNode;
}) {
  const nav = useNavigate();
  const { logout } = useAuth();
  return (
    <div className="phone-wrap">
      <div className="phone">
        <div className="phone-top">
          <div className="bar">
            {back
              ? <button onClick={() => nav('/')} style={{ color: '#e6cfa0', fontWeight: 700 }}>← Назад</button>
              : <Logo size={22} light />}
            <button onClick={logout} style={{ color: '#e6cfa0', fontSize: 13 }}>выйти</button>
          </div>
          <div className="hello">{hello}</div>
          {sub && <div className="sub">{sub}</div>}
        </div>

        <div className="phone-body">{children}</div>

        {action && (
          <div className="phone-action">
            {actionHint && <div className="hint">{actionHint}</div>}
            {action}
          </div>
        )}
      </div>
    </div>
  );
}
