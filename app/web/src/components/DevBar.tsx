import { useState } from 'react';
import { get, post } from '../api';
import { useAsync, useBump, useToast } from '../lib';
import { useAuth } from '../auth';
import { EventLog } from './EventLog';

export function DevBar() {
  const { bump } = useBump();
  const { me, logout } = useAuth();
  const toast = useToast();
  const { data } = useAsync(() => get<{ today: string; overridden: boolean }>('/dev/clock'), []);
  const [showEvents, setShowEvents] = useState(false);

  async function move(days: number) {
    const r = await post<{ today: string }>('/dev/clock/advance', { days });
    bump();
    try {
      const a = await get<{ overdue: number }>('/analytics');
      const d = new Date(r.today).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      toast(`Дата: ${d}. Просрочено онбордингов: ${a.overdue}`, a.overdue ? 'warn' : 'ok');
    } catch { /* сотрудник не видит аналитику — просто без тоста */ }
  }
  async function resetClock() { await post('/dev/clock/reset'); bump(); toast('Дата сброшена'); }
  async function resetDemo() {
    if (!confirm('Сбросить все демо-данные к исходному состоянию?')) return;
    await post('/dev/reset');
    logout();
    location.reload();
  }

  // На боевом сервере адресов /dev/* не существует — панель просто не появляется.
  // Одна и та же сборка работает и там, и на тестовом стенде.
  if (!data) return null;

  const today = new Date(data.today)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <>
      <div className="devbar">
        <span className="tag2">DEMO</span>
        <span><span className="hide-sm">сегодня: </span><b>{today}</b>{data.overridden ? ' ⏱' : ''}</span>
        {me && (
          <div className="grp">
            <button onClick={() => move(1)}>+1д</button>
            <button onClick={() => move(5)}>+5д</button>
            <button onClick={() => move(14)}>+14д</button>
            <button onClick={resetClock}>сброс даты</button>
          </div>
        )}
        <span className="spacer" />
        {me && <button onClick={() => setShowEvents((s) => !s)}>{showEvents ? 'скрыть' : 'События'}</button>}
        {me && <button className="warn" onClick={resetDemo}>Сброс демо</button>}
      </div>

      {showEvents && <EventLog onClose={() => setShowEvents(false)} />}
    </>
  );
}
