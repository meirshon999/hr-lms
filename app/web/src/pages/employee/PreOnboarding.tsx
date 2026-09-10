import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../../api';
import { useAuth } from '../../auth';
import { useAsync, useBump, SkeletonList, ErrorBox } from '../../lib';
import { Phone } from '../../components/Phone';

interface Item {
  id: string; title: string; content_type: 'video' | 'pdf' | 'text';
  file_url: string | null; text_body: string | null; viewed: boolean;
}

export function PreOnboarding() {
  const { me, refresh } = useAuth();
  const { bump } = useBump();
  const nav = useNavigate();
  const { data, loading, error, reload } = useAsync(
    () => get<{ done: boolean; items: Item[] }>('/me/pre-onboarding'), [],
  );
  const [open, setOpen] = useState<string | null>(null);

  async function markViewed(id: string) {
    const r = await post<{ onboarding_opened: boolean }>(`/me/pre-onboarding/${id}/view`);
    setOpen(null);
    if (r.onboarding_opened) { await refresh(); bump(); nav('/'); return; }
    bump();
    reload();
  }

  // Материалы пройдены — ждём кнопку HR. Экран должен обновиться сам, без перезахода:
  // как только стажировка отмечена, EmployeeHome покажет траекторию.
  const waiting = !!data?.done;
  // refresh пересоздаётся на каждом рендере. Через ссылку опрос всегда зовёт
  // свежую версию, а таймер не перезапускается по десять раз в минуту.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { refreshRef.current(); }, 10_000);
    const onFocus = () => refreshRef.current();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [waiting]);

  const nextItem = data?.items.find((i) => !i.viewed);
  const action = nextItem && open !== nextItem.id ? (
    <button className="btn block" onClick={() => setOpen(nextItem.id)}>Продолжить изучение</button>
  ) : undefined;

  return (
    <Phone
      hello={`Добро пожаловать, ${firstName(me?.employee?.full_name)}`}
      sub="Пингвин ждёт вас на стажировке"
      action={action}
      actionHint={nextItem ? nextItem.title : undefined}
    >
      {loading && <SkeletonList rows={3} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <div className="banner info" style={{ marginBottom: 16 }}>
            Пока идёт стажировка, изучите материалы о компании. Онбординг откроется,
            когда HR отметит стажировку пройденной.
          </div>

          <h2>Материалы о компании</h2>
          <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Просмотрено {data.items.filter((i) => i.viewed).length} из {data.items.length}
          </p>

          <div className="card" style={{ padding: '4px 14px' }}>
            {data.items.map((it) => (
              <div key={it.id}>
                <div
                  className={`lesson-row clickable ${it.viewed ? 'passed' : 'available'}`}
                  onClick={() => setOpen(open === it.id ? null : it.id)}
                >
                  <div className="ico">{it.viewed ? '✓' : icon(it.content_type)}</div>
                  <div className="tx"><b>{it.title}</b>
                    <span className="muted" style={{ fontSize: 13 }}>{typeLabel(it.content_type)}</span>
                  </div>
                  <span className="muted">{open === it.id ? '▲' : '▸'}</span>
                </div>
                {open === it.id && (
                  <div className="material">
                    {it.content_type === 'video' ? (
                      <div className="video-stub">
                        <div className="play">▶</div>
                        <div>Демо-видео (заглушка)</div>
                        <div style={{ fontSize: 12, opacity: .7, marginTop: 4 }}>
                          В реальной версии здесь плеер
                        </div>
                      </div>
                    ) : (
                      <p style={{ whiteSpace: 'pre-wrap' }}>{it.text_body}</p>
                    )}
                    <button className="btn block mt16" onClick={() => markViewed(it.id)}>
                      {it.viewed ? 'Просмотрено ✓' : 'Отметить просмотренным'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {data.done && (
            <div className="banner ok mt16">
              <b>Все материалы изучены.</b><br />
              Осталось пройти стажировку. Как только руководитель её отметит, обучение
              откроется прямо здесь — страницу перезагружать не нужно.
            </div>
          )}
        </>
      )}
    </Phone>
  );
}

const firstName = (n?: string) => (n ?? '').split(' ')[0] || 'коллега';
const icon = (t: string) => (t === 'video' ? '▶' : t === 'pdf' ? '⬇' : '≡');
const typeLabel = (t: string) => (t === 'video' ? 'Видео' : t === 'pdf' ? 'Документ' : 'Текст');
