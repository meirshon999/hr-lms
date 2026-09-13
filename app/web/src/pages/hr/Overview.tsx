import { Fragment, useState } from 'react';
import { get } from '../../api';
import { useAsync, Loader, ErrorBox, STAGE_LABEL } from '../../lib';
import { Icon } from '../../components/Icon';

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

interface Attention {
  waiting_internship: number; overdue: number;
  items?: {
    id: string; full_name: string; kind: 'internship' | 'overdue';
    days: number; position: string | null; location: string | null;
  }[];
}

interface Loc { id: string; name: string }

export function Overview() {
  const [loc, setLoc] = useState('');
  const { data, loading, error, reload } = useAsync(
    () => get<Analytics>(`/analytics${loc ? `?location=${loc}` : ''}`), [loc]);
  const { data: locs } = useAsync(() => get<{ items: Loc[] }>('/locations'), []);
  const { data: att } = useAsync(() => get<Attention>('/attention?list=1'), []);

  return (
    <>
      <h1>Обзор</h1>
      <p className="subtitle">Сводка по онбордингу</p>

      {loading && <Loader />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <AttentionWidget att={att} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, marginBottom: 18 }}>
            {(['intern', 'onboarding', 'completed', 'archived'] as const).map((s) => (
              <div key={s} className="panel kpi">
                <div className="n">{data.by_stage[s] ?? 0}</div>
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
              <div className="n">{data.avg_onboarding_days ?? '—'}</div>
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

          <div className="row-between" style={{ marginBottom: 10, alignItems: 'baseline', gap: 10 }}>
            <h3 style={{ margin: 0 }}>Воронка по должностям</h3>
            <select value={loc} onChange={(e) => setLoc(e.target.value)} style={{ maxWidth: 260 }}>
              <option value="">Вся сеть</option>
              {locs?.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: -4, marginBottom: 12 }}>
            Столбик — сколько человек дошло до ступени, кружок между столбиками —
            какая доля перешла с предыдущей. Там и видно, где теряем.
          </p>

          {data.funnel.length === 0 && (
            <div className="panel muted">На эти должности ещё никого не заводили.</div>
          )}

          {data.funnel.map((f) => (
            <div key={f.position_id} className="panel">
              <div className="row-between" style={{ marginBottom: 14 }}>
                <b>{f.position}</b>
                <span className="muted" style={{ fontSize: 13 }}>всего заведено {f.cohort}</span>
              </div>
              <Funnel steps={f.steps} cohort={f.cohort} />
            </div>
          ))}
        </>
      )}
    </>
  );
}

/**
 * ТРЕБУЮТ ВНИМАНИЯ.
 *
 * Слепое пятно кадровика: стажёр прочитал пре-онбординг и ждёт, пока ему
 * отметят стажировку, а узнать об этом можно было, только открыв список и
 * пройдясь по нему глазами. Уведомлений в системе нет по решению заказчика,
 * поэтому его заменяет этот список: он лежит первым на экране, с которого
 * начинается день, и каждая строка ведёт прямо в карточку.
 *
 * Просроченные идут первыми: у них срок уже прошёл, а стажёр просто ждёт.
 */
function AttentionWidget({ att }: { att: Attention | undefined }) {
  const items = att?.items ?? [];
  if (!items.length) return null;

  return (
    <div className="panel attention" style={{ marginBottom: 18 }}>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <b>Требуют внимания</b>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {att?.overdue ? `просрочено ${att.overdue}` : ''}
          {att?.overdue && att?.waiting_internship ? ' · ' : ''}
          {att?.waiting_internship ? `ждут отметки ${att.waiting_internship}` : ''}
        </span>
      </div>
      {items.map((i) => (
        <a key={i.id} className="arow" href={`#/hr/employees/${i.id}`}>
          <span className={`mark${i.kind === 'overdue' ? ' overdue' : ''}`} />
          <span className="who">
            <b>{i.full_name}</b>
            <span className="muted">
              {i.position ? ` · ${i.position}` : ''}{i.location ? ` · ${i.location}` : ''}
            </span>
          </span>
          <span className="what">
            {i.kind === 'overdue'
              ? `срок прошёл ${i.days > 0 ? `${i.days} дн. назад` : 'сегодня'}`
              : `ждёт отметки о стажировке${i.days > 0 ? ` · ${i.days} дн.` : ''}`}
          </span>
          <Icon name="right" size={14} />
        </a>
      ))}
    </div>
  );
}

/**
 * ВОРОНКА СТОЛБИКАМИ.
 *
 * Горизонтальные полосы одна под другой сливались: четыре числа в строку —
 * дошли, сейчас, ушли, срок — и все одним кеглем. Главный вопрос к воронке
 * один: где теряем. На него отвечает не абсолютная цифра, а доля перешедших
 * с предыдущей ступени, поэтому она и вынесена между столбиками.
 *
 * Высота столбика считается от всей когорты, а не от применимых: только так
 * столбики сравнимы между собой. Что блока нет у части точек, подписано
 * отдельной строкой — иначе честная разница выглядела бы провалом.
 */
function Funnel({ steps, cohort }: {
  steps: Analytics['funnel'][number]['steps']; cohort: number;
}) {
  const base = Math.max(cohort, 1);
  return (
    <div className="funnel">
      {steps.map((st, i) => {
        const prev = i > 0 ? steps[i - 1] : null;
        // Доля перешедших с прошлой ступени. Больше 100% бывает, когда ступень
        // применима к большему числу людей, чем предыдущая; такую цифру
        // показывать незачем — ограничиваем.
        const conv = prev && prev.reached > 0
          ? Math.min(100, Math.round((st.reached / prev.reached) * 100))
          : null;
        return (
          <Fragment key={st.key}>
            {i > 0 && <span className="conv">{conv === null ? '—' : `${conv}%`}</span>}
            <div className="fcol">
              <div className="fbar" title={`${st.reached} из ${st.applicable}`}>
                <i className={st.key === 'attested' ? 'done' : undefined}
                  style={{ height: `${Math.round((st.reached / base) * 100)}%` }} />
              </div>
              <b className="fn">{st.reached}</b>
              <span className="ft">{st.title}</span>
              <span className="fs">
                {st.now > 0 && <>сейчас {st.now}</>}
                {st.lost > 0 && <span className="lost">{st.now > 0 ? ' · ' : ''}ушли {st.lost}</span>}
                {st.avg_days !== null && <>{st.now > 0 || st.lost > 0 ? ' · ' : ''}{st.avg_days} дн.</>}
                {st.applicable < cohort && (
                  <><br />есть у {st.applicable} из {cohort}</>
                )}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
