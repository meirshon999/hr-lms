import { useState } from 'react';
import { get } from '../../api';
import { useAsync, Loader, ErrorBox, STAGE_LABEL } from '../../lib';

interface Analytics {
  by_stage: Record<string, number>;
  total: number;
  overdue: number;
  avg_onboarding_days: number | null;
  by_location: {
    location_id: string; name: string; total: number;
    intern: number; onboarding: number; completed: number; overdue: number;
    completion_pct: number | null; avg_onboarding_days: number | null;
  }[];
  hardest: { title: string; attempts: number; fail_pct: number }[];
  funnel: {
    position_id: string; position: string; cohort: number;
    steps: {
      key: string; title: string;
      applicable: number; reached: number; now: number; lost: number;
      avg_days: number | null;
    }[];
  }[];
}

interface Loc { id: string; name: string }

export function Overview() {
  const [loc, setLoc] = useState('');
  const { data, loading, error, reload } = useAsync(
    () => get<Analytics>(`/analytics${loc ? `?location=${loc}` : ''}`), [loc]);
  const { data: locs } = useAsync(() => get<{ items: Loc[] }>('/locations'), []);

  return (
    <>
      <h1>Обзор</h1>
      <p className="subtitle">Сводка по онбордингу</p>

      {loading && <Loader />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginBottom: 18 }}>
            {(['intern', 'onboarding', 'completed', 'archived'] as const).map((s) => (
              <div key={s} className="panel kpi">
                <div className="n">
                  {data.by_stage[s] ?? 0}
                </div>
                <div className="muted" style={{ fontSize: 13 }}>{STAGE_LABEL[s]}</div>
              </div>
            ))}
            <div className="panel kpi">
              <div className="n" style={{ color: data.overdue ? 'var(--error)' : 'var(--muted)' }}>
                {data.overdue}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>Просрочено</div>
            </div>
            <div className="panel kpi">
              <div className="n">
                {data.avg_onboarding_days ?? '—'}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>Средний срок, дней</div>
            </div>
          </div>

          <h3 style={{ marginBottom: 10 }}>Точки сети</h3>
          <div className="panel" style={{ padding: 0, overflowX: 'auto', marginBottom: 18 }}>
            <table className="grid" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Точка</th><th>Всего</th><th>Стажировка</th><th>Онбординг</th>
                  <th>Завершили</th><th>Дошли до конца</th><th>Средний срок</th><th>Просрочено</th>
                </tr>
              </thead>
              <tbody>
                {data.by_location.map((l) => (
                  <tr key={l.location_id}>
                    <td data-label="Точка"><b>{l.name}</b></td>
                    <td data-label="Всего">{l.total}</td>
                    <td data-label="Стажировка">{l.intern}</td>
                    <td data-label="Онбординг">{l.onboarding}</td>
                    <td data-label="Завершили">{l.completed}</td>
                    <td data-label="Дошли до конца">
                      {l.completion_pct === null ? <span className="muted">—</span> : `${l.completion_pct}%`}
                    </td>
                    <td data-label="Средний срок">
                      {l.avg_onboarding_days === null
                        ? <span className="muted">—</span> : `${l.avg_onboarding_days} дн.`}
                    </td>
                    <td data-label="Просрочено">
                      {l.overdue ? <b style={{ color: 'var(--error)' }}>{l.overdue}</b> : '0'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.by_location.length > 0 && data.by_location.every((l) => l.total === 0) && (
            <p className="muted" style={{ fontSize: 13, marginTop: -12, marginBottom: 18 }}>
              Сотрудников пока нет — цифры появятся, когда HR заведёт людей.
            </p>
          )}

          {data.hardest.length > 0 && (
            <>
              <h3 style={{ marginBottom: 10 }}>Где чаще всего спотыкаются</h3>
              <div className="panel" style={{ marginBottom: 18 }}>
                {data.hardest.map((h) => (
                  <div key={h.title} style={{ marginBottom: 8 }}>
                    <div className="row-between" style={{ fontSize: 13, marginBottom: 3 }}>
                      <span>{h.title}</span>
                      <span className="muted">{h.fail_pct}% попыток мимо · всего {h.attempts}</span>
                    </div>
                    <div className="progress over"><i style={{ width: `${h.fail_pct}%` }} /></div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="row-between" style={{ marginBottom: 10, alignItems: "baseline", gap: 10 }}>
            <h3 style={{ margin: 0 }}>Воронка по должностям</h3>
            <select value={loc} onChange={(e) => setLoc(e.target.value)} style={{ maxWidth: 260 }}>
              <option value="">Вся сеть</option>
              {locs?.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: -4, marginBottom: 10 }}>
            На каждой ступени: <b>дошли</b> за всё время, <b>сейчас</b> стоят на ней,
            <b> ушли</b> — те, кто на ней и закончился. Дни — средний срок:
            у «начал обучение» от найма до старта, дальше — от старта обучения.
          </p>

          {data.funnel.length === 0 && (
            <div className="panel muted">На эти должности ещё никого не заводили.</div>
          )}

          {data.funnel.map((f) => (
            <div key={f.position_id} className="panel">
              <div className="row-between" style={{ marginBottom: 12 }}>
                <b>{f.position}</b>
                <span className="muted" style={{ fontSize: 13 }}>всего заведено {f.cohort}</span>
              </div>

              {f.steps.map((st) => {
                // Полоса считается от применимых, а не от всей когорты: блок,
                // которого нет у части точек, иначе выглядел бы провалом.
                const base = Math.max(st.applicable, 1);
                return (
                  <div key={st.key} style={{ marginBottom: 10 }}>
                    <div className="row-between" style={{ fontSize: 13, marginBottom: 3, gap: 10 }}>
                      <span>
                        {st.title}
                        {st.applicable < f.cohort && (
                          <span className="muted" style={{ fontSize: 12 }}>
                            {" "}· есть у {st.applicable} из {f.cohort}
                          </span>
                        )}
                      </span>
                      <span style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                        <b>{st.reached}</b>
                        <span className="muted"> из {st.applicable}</span>
                        {st.now > 0 && <span className="muted"> · сейчас {st.now}</span>}
                        {st.lost > 0 && <span style={{ color: "var(--error)" }}> · ушли {st.lost}</span>}
                        {st.avg_days !== null && <span className="muted"> · {st.avg_days} дн.</span>}
                      </span>
                    </div>
                    <div className="progress">
                      <i style={{
                        width: `${Math.round((st.reached / base) * 100)}%`,
                        background: st.key === "attested" ? "var(--success)" : undefined,
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </>
  );
}
