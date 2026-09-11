import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Loader } from './lib';
import { Login } from './pages/Login';
import { Invite } from './pages/Invite';
import { ChangePassword } from './pages/ChangePassword';
import { PreOnboarding } from './pages/employee/PreOnboarding';
import { Trajectory } from './pages/employee/Trajectory';
import { Lesson } from './pages/employee/Lesson';
import { Attestation } from './pages/employee/Attestation';
import { HrLayout } from './pages/hr/HrLayout';
import { Overview } from './pages/hr/Overview';
import { Employees } from './pages/hr/Employees';
import { EmployeeCard } from './pages/hr/EmployeeCard';
import { Constructor } from './pages/hr/Constructor';
import { Accounts } from './pages/hr/Accounts';
import { Settings } from './pages/hr/Settings';

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <Loader text="Загрузка…" />;

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Ссылка-приглашение: единственный адрес, доступный без входа. */}
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Временный пароль — единственный экран, доступный до его смены.
  if (me.user.must_change_password) return <ChangePassword />;

  const isHr = me.user.role === 'hr' || me.user.role === 'admin';
  // Администратор отвечает за доступы и устройство сети — кадровик за людей
  // и содержание. Маршрута аккаунтов у кадровика нет вовсе, а не просто
  // спрятана ссылка: адрес, набранный руками, тоже никуда не приведёт.
  const isAdmin = me.user.role === 'admin';

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      {/* Уже вошёл и открыл чужую ссылку — не сжигаем её, просто уводим домой. */}
      <Route path="/invite/:token" element={<Navigate to="/" replace />} />

      {!isHr && <>
        <Route path="/" element={<EmployeeHome />} />
        <Route path="/lesson/:id" element={<Lesson />} />
        <Route path="/attestation" element={<Attestation />} />
      </>}

      {isHr && <>
        <Route path="/" element={<Navigate to="/hr/overview" replace />} />
        <Route element={<HrLayout />}>
          <Route path="/hr/overview" element={<Overview />} />
          <Route path="/hr/employees" element={<Employees />} />
          <Route path="/hr/employees/:id" element={<EmployeeCard />} />
          <Route path="/hr/constructor" element={<Constructor />} />
          <Route path="/hr/constructor/:positionId" element={<Constructor />} />
          {isAdmin && <Route path="/hr/accounts" element={<Accounts />} />}
          <Route path="/hr/settings" element={<Settings />} />
        </Route>
      </>}

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Сотрудник: стажёр видит пре-онбординг, остальные — траекторию. */
function EmployeeHome() {
  const { me } = useAuth();
  return me?.employee?.stage === 'intern' ? <PreOnboarding /> : <Trajectory />;
}
