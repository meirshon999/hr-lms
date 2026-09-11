import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth';
import { get } from '../../api';
import { Logo } from '../../components/Logo';

interface Attention { waiting_internship: number; overdue: number }

export function HrLayout() {
  const { me, logout } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const place = useLocation();
  const [att, setAtt] = useState<Attention | null>(null);

  /*
   * Цифра у «Сотрудников» — замена уведомлениям, которых в системе нет.
   *
   * Слепое пятно было такое: стажёр прочитал пре-онбординг, нажал «Продолжить»
   * и ждёт, пока кадровик отметит стажировку. Кадровик об этом не узнает,
   * пока сам не откроет список. Теперь цифра видна с любого экрана.
   *
   * Перечитываем при каждом переходе, а не по таймеру: кадровик всё равно
   * ходит по разделам, а лишний опрос раз в минуту тут ничего не даёт.
   */
  useEffect(() => {
    let live = true;
    get<Attention>('/attention')
      .then((r) => { if (live) setAtt(r); })
      .catch(() => { /* сводка не критична: без неё меню просто без цифры */ });
    return () => { live = false; };
  }, [place.pathname]);

  const waiting = att?.waiting_internship ?? 0;

  return (
    <div className="hr-app">
      <nav className="hr-side">
        <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Logo size={26} light />
          <span>Pingwin LMS<small>управление онбордингом</small></span>
        </div>
        {/* на узком экране прокручивается только этот блок — выход остаётся на виду */}
        <div className="hr-nav">
          <NavLink to="/hr/overview" className={({ isActive }) => (isActive ? 'active' : '')}>Обзор</NavLink>
          <NavLink to="/hr/employees" className={({ isActive }) => (isActive ? 'active' : '')}
            title={waiting ? `${waiting} ждут отметки о стажировке` : undefined}>
            Сотрудники
            {waiting > 0 && (
              <span style={{
                marginLeft: 8, padding: '1px 7px', borderRadius: 10, fontSize: 11,
                fontWeight: 700, background: 'var(--error, #dc3545)', color: '#fff',
              }}>
                {waiting}
              </span>
            )}
          </NavLink>
          <NavLink to="/hr/constructor" className={({ isActive }) => (isActive ? 'active' : '')}>Конструктор</NavLink>
          {isAdmin && (
            <NavLink to="/hr/accounts" className={({ isActive }) => (isActive ? 'active' : '')}>Аккаунты</NavLink>
          )}
          <NavLink to="/hr/settings" className={({ isActive }) => (isActive ? 'active' : '')}>Настройки</NavLink>
        </div>
        <div className="who">
          <span className="acct">{me?.user.login} · {me?.user.role}</span>
          <button className="logout" onClick={logout} title="Выйти из системы">Выйти</button>
        </div>
      </nav>
      <main className="hr-main"><Outlet /></main>
    </div>
  );
}
