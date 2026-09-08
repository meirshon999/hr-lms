import { useEffect, useState } from 'react';
import { get } from '../api';
import { useBump } from '../lib';

interface Ev { ts: string; type: string; detail: string; }

export function EventLog({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<Ev[]>([]);
  const { n } = useBump();

  useEffect(() => {
    let live = true;
    const tick = () => get<{ events: Ev[] }>('/dev/events').then((r) => { if (live) setEvents(r.events); }).catch(() => {});
    tick();
    const iv = setInterval(tick, 2000);
    return () => { live = false; clearInterval(iv); };
  }, [n]);

  return (
    <div className="evlog">
      <header>
        <b>События системы</b>
        <button onClick={onClose} style={{ color: '#e6cfa0' }}>✕</button>
      </header>
      <div className="list">
        {events.length === 0 && <div className="empty">Пока тихо. Действия в приложении появятся здесь.</div>}
        {events.map((e, i) => (
          <div className="e" key={i}>
            <span className="t">{e.type}</span><br />
            <span className="d">{e.detail}</span>
            <span className="d" style={{ float: 'right', fontSize: 11 }}>
              {new Date(e.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
