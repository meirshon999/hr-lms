import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../../api';
import { ApiError } from '../../api';
import { useAsync, useBump, Loader, ErrorBox, fmtDate, STAGE_LABEL, useToast } from '../../lib';

interface Row {
  id: string; full_name: string; position: string; position_id: string; phone: string;
  start_date: string; stage: string; onboarding_due_date: string | null; overdue: boolean;
  progress: { passed: number; total: number };
}
interface Pos { id: string; name: string; trajectory_status: string; }

export function Employees() {
  const nav = useNavigate();
  const { bump } = useBump();
  const [q, setQ] = useState({ search: '', stage: '', include_archived: false });
  const [adding, setAdding] = useState(false);

  const qs = new URLSearchParams();
  if (q.search) qs.set('search', q.search);
  if (q.stage) qs.set('stage', q.stage);
  if (q.include_archived) qs.set('include_archived', '1');

  const { data, loading, error, reload } = useAsync(
    () => get<{ items: Row[] }>(`/employees?${qs}`), [qs.toString()],
  );

  return (
    <>
      <h1>Сотрудники</h1>
      <p className="subtitle">Новички на онбординге и их прогресс</p>

      <div className="toolbar">
        <input className="grow" placeholder="Поиск по ФИО или телефону"
          value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} />
        <select value={q.stage} onChange={(e) => setQ({ ...q, stage: e.target.value })}>
          <option value="">Все этапы</option>
          {['intern', 'onboarding', 'completed'].map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={q.include_archived}
            onChange={(e) => setQ({ ...q, include_archived: e.target.checked })} /> архивные
        </label>
        <button className="btn sm" onClick={() => setAdding(true)}>+ Добавить сотрудника</button>
      </div>

      {loading && <Loader />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && data.items.length === 0 && (
        <div className="panel" style={{ textAlign: 'center', color: 'var(--muted)' }}>
          Здесь появятся сотрудники после добавления.
        </div>
      )}
      {data && data.items.length > 0 && (
        <table className="grid">
          <thead>
            <tr><th>ФИО</th><th>Должность</th><th>Этап</th><th>Прогресс</th><th>Срок</th></tr>
          </thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id} onClick={() => nav(`/hr/employees/${e.id}`)}>
                <td data-label="ФИО"><b>{e.full_name}</b><br /><span className="muted" style={{ fontSize: 12 }}>{e.phone}</span></td>
                <td data-label="Должность">{e.position}</td>
                <td data-label="Этап"><span className={`pill stage-${e.stage}`}>{STAGE_LABEL[e.stage]}</span></td>
                <td data-label="Прогресс">
                  {e.stage === 'intern' ? <span className="muted">—</span> : (
                    <div className="mini-progress">
                      <div className={`progress ${e.overdue ? 'over' : ''}`}>
                        <i style={{ width: `${pct(e.progress)}%` }} />
                      </div>
                      <span className="muted" style={{ fontSize: 12 }}>{e.progress.passed}/{e.progress.total}</span>
                    </div>
                  )}
                </td>
                <td data-label="Срок">
                  {e.overdue
                    ? <span className="pill overdue">Просрочено</span>
                    : <span className="muted" style={{ fontSize: 13 }}>{fmtDate(e.onboarding_due_date)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && <AddEmployee onClose={() => setAdding(false)} onDone={() => { setAdding(false); bump(); reload(); }} />}
    </>
  );
}

const pct = (p: { passed: number; total: number }) => (p.total ? Math.round((p.passed / p.total) * 100) : 0);

function AddEmployee({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data: pos } = useAsync(() => get<{ items: Pos[] }>('/positions'), []);
  const [f, setF] = useState({
    full_name: '', position_id: '', phone: '+7', start_date: new Date().toISOString().slice(0, 10),
    login: '', password: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await post<{ warnings: string[] }>('/employees', f);
      if (r.warnings?.includes('no_active_trajectory'))
        toast('Сотрудник создан. Траектория должности ещё не опубликована — онбординг откроется после публикации.', 'warn');
      else toast('Сотрудник добавлен');
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Новый сотрудник</h3>
        <label className="field"><span>ФИО</span>
          <input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required /></label>
        <label className="field"><span>Должность</span>
          <select value={f.position_id} onChange={(e) => setF({ ...f, position_id: e.target.value })} required>
            <option value="">—</option>
            {pos?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.trajectory_status !== 'active' ? ' (черновик)' : ''}
              </option>
            ))}
          </select></label>
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="field" style={{ flex: 1 }}><span>Телефон</span>
            <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required /></label>
          <label className="field" style={{ flex: 1 }}><span>Дата выхода</span>
            <input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} required /></label>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="field" style={{ flex: 1 }}><span>Логин</span>
            <input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} required /></label>
          <label className="field" style={{ flex: 1 }}><span>Стартовый пароль</span>
            <input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></label>
        </div>
        {err && <div className="banner warn" style={{ marginBottom: 10 }}>{err}</div>}
        <div className="row">
          <button type="button" className="btn ghost sm" onClick={onClose}>Отмена</button>
          <button className="btn sm" disabled={busy}>{busy ? 'Сохраняем…' : 'Добавить'}</button>
        </div>
      </form>
    </div>
  );
}
