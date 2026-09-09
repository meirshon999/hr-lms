import { useNavigate } from 'react-router-dom';
import { get } from '../../api';
import { useAuth } from '../../auth';
import { useAsync, SkeletonList, ErrorBox, fmtDate } from '../../lib';
import { Phone } from '../../components/Phone';

function DoneScreen({ name, blocks, lessons, date }: { name: string; blocks: number; lessons: number; date: string | null }) {
  return (
    <div className="done-screen">
      <div className="seal">✓</div>
      <h2>Онбординг завершён!</h2>
      <p className="who">{name}, вы прошли программу{date ? ` ${fmtDate(date)}` : ''}</p>
      <div className="stats">
        <div className="s"><b>{blocks}</b><span>блоков</span></div>
        <div className="s"><b>{lessons}</b><span>уроков</span></div>
        <div className="s"><b>100%</b><span>аттестация</span></div>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Все уроки остаются доступны — можно вернуться и повторить.</p>
    </div>
  );
}

interface Lesson { id: string; title: string; status: 'locked' | 'available' | 'passed'; material_type: string | null; }
interface Block { id: string; title: string; lessons: Lesson[]; }
interface Traj {
  stage: string;
  onboarding_due_date: string | null;
  overdue: boolean;
  completed_at: string | null;
  block_count: number;
  progress: { passed: number; total: number };
  trajectory: {
    blocks: Block[];
    attestation: { available: boolean; passed: boolean; question_count: number; pass_mark_pct: number };
  } | null;
}

export function Trajectory() {
  const { me } = useAuth();
  const nav = useNavigate();
  const { data, loading, error, reload } = useAsync(() => get<Traj>('/me/trajectory'), []);

  const flat = data?.trajectory?.blocks.flatMap((b) => b.lessons) ?? [];
  const nextLesson = flat.find((l) => l.status === 'available');
  const att = data?.trajectory?.attestation;
  const completed = data?.stage === 'completed';

  const action = completed ? undefined
    : nextLesson ? (
      <button className="btn block" onClick={() => nav(`/lesson/${nextLesson.id}`)}>Продолжить</button>
    ) : att?.available && !att.passed ? (
      <button className="btn block" onClick={() => nav('/attestation')}>Перейти к аттестации</button>
    ) : undefined;

  return (
    <Phone
      hello={firstName(me?.employee?.full_name)}
      sub={me?.employee ? posHint() : undefined}
      action={data?.trajectory ? action : undefined}
    >
      {loading && <SkeletonList rows={5} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data?.trajectory && (
        <>
          {completed ? (
            <DoneScreen
              name={firstName(me?.employee?.full_name)}
              blocks={data.block_count}
              lessons={data.progress.total}
              date={data.completed_at}
            />
          ) : nextLesson ? (
            <div className="next-card">
              <div className="label">Ваш следующий шаг</div>
              <div className="title">{nextLesson.title}</div>
            </div>
          ) : att?.available && !att.passed ? (
            <div className="next-card">
              <div className="label">Финальный шаг</div>
              <div className="title">Аттестация — {att.question_count} вопросов</div>
            </div>
          ) : null}

          <div className="mt24">
            {data.trajectory.blocks.map((b) => (
              <div key={b.id}>
                <div className="block-h">{b.title}</div>
                <div className="card" style={{ padding: '2px 14px', marginTop: 6 }}>
                  {b.lessons.map((l) => (
                    <div
                      key={l.id}
                      className={`lesson-row ${l.status} ${l.status !== 'locked' ? 'clickable' : ''}`}
                      onClick={() => l.status !== 'locked' && nav(`/lesson/${l.id}`)}
                    >
                      <div className="ico">
                        {l.status === 'passed' ? '✓' : l.status === 'locked' ? '🔒' : matIcon(l.material_type)}
                      </div>
                      <div className="tx"><b>{l.title}</b></div>
                      <span className={`pill ${l.status}`}>{statusLabel(l.status)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div className="block-h">Аттестация</div>
            <div className="card" style={{ padding: '2px 14px', marginTop: 6 }}>
              <div className={`lesson-row ${att?.passed ? 'passed' : att?.available ? 'available' : 'locked'} ${att?.available && !att.passed ? 'clickable' : ''}`}
                onClick={() => att?.available && !att.passed && nav('/attestation')}>
                <div className="ico">{att?.passed ? '✓' : att?.available ? '★' : '🔒'}</div>
                <div className="tx"><b>Финальный тест</b>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {att?.question_count} вопросов · порог {att?.pass_mark_pct}%
                  </span>
                </div>
                <span className={`pill ${att?.passed ? 'passed' : att?.available ? 'available' : 'locked'}`}>
                  {att?.passed ? 'Пройдена' : att?.available ? 'Доступна' : 'Закрыта'}
                </span>
              </div>
            </div>
          </div>

          <div className="mt24">
            <div className="row-between" style={{ fontSize: 13, marginBottom: 5 }}>
              <span className="muted">Пройдено {data.progress.passed} из {data.progress.total} уроков</span>
              {data.onboarding_due_date && !completed && (
                <span className={data.overdue ? '' : 'muted'} style={data.overdue ? { color: 'var(--error)', fontWeight: 700 } : {}}>
                  {data.overdue ? 'Срок прошёл' : `до ${fmtDate(data.onboarding_due_date)}`}
                </span>
              )}
            </div>
            <div className={`progress ${data.overdue ? 'over' : ''}`}>
              <i style={{ width: `${pct(data.progress)}%` }} />
            </div>
            {data.overdue && !completed && (
              <p className="banner warn mt8" style={{ fontSize: 13 }}>
                Срок прошёл — пройдите оставшиеся шаги как можно скорее.
              </p>
            )}
          </div>
        </>
      )}
      {data && !data.trajectory && (
        <div className="banner info mt16">Траектория для вашей должности пока не готова.</div>
      )}
    </Phone>
  );
}

const firstName = (n?: string) => (n ?? '').split(' ')[0] || 'коллега';
const posHint = () => 'Ваш путь обучения';
const statusLabel = (s: string) => (s === 'passed' ? 'Пройден' : s === 'available' ? 'Доступен' : 'Закрыт');
const matIcon = (t: string | null) => (t === 'video' ? '▶' : t === 'pdf' ? '⬇' : '≡');
const pct = (p: { passed: number; total: number }) => (p.total ? Math.round((p.passed / p.total) * 100) : 0);
