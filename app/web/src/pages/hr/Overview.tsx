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
  funnel: { position: string; cohort: number; attested: number; blocks: { title: string; passed: number }[] }[];
}

export function Overview() {
  const { data, loading, error, reload } = useAsync(() => get<Analytics>('/analytics'), []);

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

          <h3 style={{ marginBottom: 10 }}>Воронка по должностям</h3>
          {data.funnel.length === 0 && (
            <div className="panel muted">Пока никто не дошёл до онбординга.</div>
          )}
          {data.funnel.map((f) => {
            const max = Math.max(f.cohort, 1);
            return (
              <div key={f.position} className="panel">
                <div className="row-between" style={{ marginBottom: 10 }}>
                  <b>{f.position}</b>
                  <span className="muted" style={{ fontSize: 13 }}>
                    в когорте {f.cohort} · завершили {f.attested}
                  </span>
                </div>
                {f.blocks.map((b) => (
                  <div key={b.title} style={{ marginBottom: 8 }}>
                    <div className="row-between" style={{ fontSize: 13, marginBottom: 3 }}>
                      <span>{b.title}</span>
                      <span className="muted">{b.passed} из {f.cohort}</span>
                    </div>
                    <div className="progress"><i style={{ width: `${(b.passed / max) * 100}%` }} /></div>
                  </div>
                ))}
                <div style={{ marginTop: 8 }}>
                  <div className="row-between" style={{ fontSize: 13, marginBottom: 3 }}>
                    <span>Аттестация пройдена</span>
                    <span className="muted">{f.attested} из {f.cohort}</span>
                  </div>
                  <div className="progress over" style={{ background: '#efe7dc' }}>
                    <i style={{ width: `${(f.attested / max) * 100}%`, background: 'var(--success)' }} />
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
