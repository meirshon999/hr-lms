import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../../api';
import { ApiError } from '../../api';
import { useAsync, useBump, Loader, ErrorBox, fmtDate, STAGE_LABEL, useToast } from '../../lib';

interface Row {
  id: string; iin: string; full_name: string; position: string; position_id: string;
  location: string; location_id: string; phone: string;
  start_date: string; stage: string; onboarding_due_date: string | null; overdue: boolean;
  paused?: boolean;
  progress: { passed: number; total: number };
}
interface Pos { id: string; name: string; trajectory_status: string; }
interface Page { items: Row[]; total: number; limit: number; offset: number }

/** Сколько строк показываем сразу. Больше экрана всё равно не читают. */
const PAGE = 50;

interface Loc { id: string; name: string; city: string | null; }

export function Employees() {
  const nav = useNavigate();
  const { bump } = useBump();
  const [q, setQ] = useState({ search: '', stage: '', location_id: '', include_archived: false });
  const [adding, setAdding] = useState(false);

  const qs = new URLSearchParams();
  if (q.search) qs.set('search', q.search);
  if (q.stage) qs.set('stage', q.stage);
  if (q.location_id) qs.set('location_id', q.location_id);
  if (q.include_archived) qs.set('include_archived', '1');

  /*
   * Список грузится страницами. При 50–70 наймах в месяц за год набирается
   * под тысячу человек, и отдавать их разом значит подвешивать браузер.
   *
   * Страницы не нумеруем, а досыпаем кнопкой: кадровик ищет человека, а не
   * листает реестр, и «показать ещё» ему понятнее номеров страниц. Отбор и
   * поиск считаются на сервере по всему списку, поэтому найдётся и тот, кто
   * на десятой сотне.
   */
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [qs.toString()]);

  const { data, loading, error, reload } = useAsync(
    () => get<Page>(`/employees?${qs}&limit=${limit}`), [qs.toString(), limit],
  );
  const { data: locs } = useAsync(() => get<{ items: Loc[] }>('/locations'), []);

  return (
    <>
      <h1>Сотрудники</h1>
      <p className="subtitle">Новички на онбординге и их прогресс</p>

      <div className="toolbar">
        <input className="grow" placeholder="Поиск по ФИО, телефону или ИИН"
          value={q.search} onChange={(e) => setQ({ ...q, search: e.target.value })} />
        <select value={q.location_id} onChange={(e) => setQ({ ...q, location_id: e.target.value })}>
          <option value="">Все точки</option>
          {locs?.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
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
            <tr><th>ФИО</th><th>Точка</th><th>Должность</th><th>Этап</th><th>Прогресс</th><th>Срок</th></tr>
          </thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id} onClick={() => nav(`/hr/employees/${e.id}`)}>
                <td data-label="ФИО"><b>{e.full_name}</b><br /><span className="muted" style={{ fontSize: 12 }}>{e.phone}</span></td>
                <td data-label="Точка">{e.location}</td>
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
                  {e.paused
                    ? <span className="pill">На паузе</span>
                    : e.overdue
                    ? <span className="pill overdue">Просрочено</span>
                    : <span className="muted" style={{ fontSize: 13 }}>{fmtDate(e.onboarding_due_date)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.total > data.items.length && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 14, gap: 10, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 13 }}>
            Показано {data.items.length} из {data.total}
          </span>
          <button className="btn ghost sm" disabled={loading}
            onClick={() => setLimit((n) => n + PAGE)}>
            {loading ? 'Грузим…' : 'Показать ещё'}
          </button>
        </div>
      )}

      {adding && <AddEmployee onClose={() => setAdding(false)} onDone={() => { setAdding(false); bump(); reload(); }} />}
    </>
  );
}

const pct = (p: { passed: number; total: number }) => (p.total ? Math.round((p.passed / p.total) * 100) : 0);

/**
 * Временный пароль придумывать незачем.
 *
 * Сотрудник сменит его при первом входе, а чаще и вовсе не увидит — доступ
 * отдают ссылкой-приглашением. Пустое поле на этом месте заставляло кадровика
 * останавливаться и выдумывать, и выдумывал он «123456» пятьдесят раз подряд.
 */
const tempPassword = () =>
  Math.random().toString(36).slice(-4) + Math.random().toString(36).slice(-4);

function AddEmployee({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data: pos, loading: posLoading, error: posError } = useAsync(() => get<{ items: Pos[] }>('/positions'), []);
  const { data: locs, loading: locLoading, error: locError } = useAsync(() => get<{ items: Loc[] }>('/locations'), []);
  const [f, setF] = useState(() => ({
    iin: '', full_name: '', position_id: '', location_id: '', phone: '+7',
    start_date: new Date().toISOString().slice(0, 10), login: '', password: tempPassword(),
  }));
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
        {/* ИИН первым: это ключ человека в сети. Если такой уже заведён, сервер
            откажет и покажет, кто это — до того, как заполнена вся форма. */}
        <label className="field"><span>ИИН</span>
          <input value={f.iin} inputMode="numeric" maxLength={12} placeholder="12 цифр"
            onChange={(e) => setF({ ...f, iin: e.target.value.replace(/\D/g, '').slice(0, 12) })} required />
          <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Из удостоверения. По нему сотрудник узнаётся на любой точке сети.
          </span>
        </label>
        <label className="field"><span>ФИО</span>
          <input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} required /></label>
        <label className="field"><span>Точка</span>
          <select value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })} required>
            <option value="">{locLoading ? 'Загружаем точки…' : '—'}</option>
            {locs?.items.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.city ? `, ${l.city}` : ''}</option>
            ))}
          </select>
          {locError && (
            <span className="banner warn" style={{ fontSize: 12.5, marginTop: 6 }}>
              Не удалось загрузить точки. Обновите страницу или войдите заново.
            </span>
          )}
        </label>
        <label className="field"><span>Должность</span>
          <select value={f.position_id} onChange={(e) => setF({ ...f, position_id: e.target.value })} required>
            <option value="">{posLoading ? 'Загружаем должности…' : '—'}</option>
            {pos?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.trajectory_status !== 'active' ? ' (черновик)' : ''}
              </option>
            ))}
          </select>
          {posError && (
            <span className="banner warn" style={{ fontSize: 12.5, marginTop: 6 }}>
              Не удалось загрузить должности. Обновите страницу или войдите заново.
            </span>
          )}
          {!posLoading && !posError && pos?.items.length === 0 && (
            <span className="banner warn" style={{ fontSize: 12.5, marginTop: 6 }}>
              Должностей пока нет — создайте должность в «Конструкторе».
            </span>
          )}
        </label>
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="field" style={{ flex: 1 }}><span>Телефон</span>
            <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required /></label>
          <label className="field" style={{ flex: 1 }}><span>Дата выхода</span>
            <input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} required /></label>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="field" style={{ flex: 1 }}><span>Логин</span>
            <input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} required /></label>
          <label className="field" style={{ flex: 1 }}><span>Временный пароль</span>
            <input value={f.password} minLength={6}
              onChange={(e) => setF({ ...f, password: e.target.value })} required />
            <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Придуман за вас. Сотрудник сменит его при первом входе, а чаще
              доступ отдают ссылкой-приглашением из карточки
            </span>
          </label>
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
