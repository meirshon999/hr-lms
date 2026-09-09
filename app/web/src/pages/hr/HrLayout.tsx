import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../auth';
import { Logo } from '../../components/Logo';

export function HrLayout() {
  const { me, logout } = useAuth();
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
          <NavLink to="/hr/employees" className={({ isActive }) => (isActive ? 'active' : '')}>Сотрудники</NavLink>
          <NavLink to="/hr/constructor" className={({ isActive }) => (isActive ? 'active' : '')}>Конструктор</NavLink>
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
