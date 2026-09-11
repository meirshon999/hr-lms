import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, put, ApiError } from '../../api';
import { useAsync, useBump, Loader, ErrorBox, useToast } from '../../lib';
import { InlineAdd, EditableTitle, MoveBtns, reordered } from '../../components/inline';
import { FilePicker } from '../../components/FilePicker';
import { MaterialForm } from '../../components/MaterialForm';
import { TestEditor } from '../../components/TestEditor';
import { ConstructorPreview } from '../../components/ConstructorPreview';
import { AiLessonDialog } from '../../components/AiLessonDialog';
import { AiPlanDialog } from '../../components/AiPlanDialog';
import { AiAttestationDialog } from '../../components/AiAttestationDialog';

interface Pos { id: string; name: string; trajectory_status: string; }

export function Constructor() {
  const { positionId } = useParams();
  const nav = useNavigate();
  const { bump, n } = useBump();
  const { data: pl, loading, error, reload } = useAsync(() => get<{ items: Pos[] }>('/positions'), []);

  useEffect(() => {
    if (!positionId && pl?.items.length) nav(`/hr/constructor/${pl.items[0].id}`, { replace: true });
  }, [positionId, pl, nav]);

  return (
    <>
      <h1>Конструктор</h1>
      <p className="subtitle">Должности, траектории обучения, тесты</p>

      <div className="desktop-only-note banner info" style={{ marginBottom: 14 }}>
        Конструктор рассчитан на компьютер — на телефоне редактировать неудобно.
        Откройте эту страницу на большом экране.
      </div>

      {loading && <Loader />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {pl && (
        <div className="builder">
          <div className="pos-list">
            {pl.items.map((p) => (
              <a key={p.id} href={`#/hr/constructor/${p.id}`} className={p.id === positionId ? 'active' : ''}>
                {p.name}
                <div className={`st ${p.trajectory_status === 'active' ? '' : ''}`}
                  style={{ color: p.trajectory_status === 'active' ? 'var(--success)' : 'var(--muted)' }}>
                  {p.trajectory_status === 'active' ? '● Опубликована' : '○ Черновик'}
                </div>
              </a>
            ))}
            <InlineAdd placeholder="Новая должность" onAdd={async (name) => {
              await post('/positions', { name }); bump();
            }} label="+ должность" />
          </div>

          {positionId && (
            <TrajectoryEditor
              key={positionId + n}
              positionId={positionId}
              positionName={pl.items.find((p) => p.id === positionId)?.name ?? 'должность'}
              onChange={bump}
            />
          )}
        </div>
      )}
    </>
  );
}

interface Traj {
  id: string; status: string; problems: string[];
  viewing_location: string | null;
  locations: { location_id: string; name: string; ready: boolean; problems: string[] }[];
  pre_onboarding: { id: string; title: string; content_type: string; text_body: string | null; file_url: string | null }[];
  blocks: any[];
}
interface Loc { id: string; name: string; city: string | null; }
interface AiStatus {
  enabled: boolean; provider: string; model: string | null; reason: string | null;
  /** Провайдер читает PDF сам — тогда .pdf можно принимать как есть. */
  reads_documents: boolean;
}

function TrajectoryEditor({ positionId, positionName, onChange }: {
  positionId: string; positionName: string; onChange: () => void;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [attAi, setAttAi] = useState(false);
  // Точка, глазами которой HR смотрит траекторию. Уроки с общим содержимым
  // выглядят одинаково на любой, а точечные показывают вариант выбранной.
  const [at, setAt] = useState('');
  const { data: locs } = useAsync(() => get<{ items: Loc[] }>('/locations'), []);
  // Кнопки ИИ показываем только там, где их есть чем обслужить.
  const { data: ai } = useAsync(() => get<AiStatus>('/ai/status'), []);

  useEffect(() => {
    if (!at && locs?.items.length) setAt(locs.items[0].id);
  }, [at, locs]);

  const { data, loading, error, reload } = useAsync(
    () => get<Traj>(`/trajectories/${positionId}${at ? `?location=${at}` : ''}`), [positionId, at],
  );
  const refresh = () => { reload(); onChange(); };

  if (loading && !data) return <Loader />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const att = data.blocks.find((b) => b.kind === 'attestation');
  const regular = data.blocks.filter((b) => b.kind === 'regular');

  const movePre = (i: number, dir: -1 | 1) =>
    put(`/trajectories/${positionId}/pre-onboarding/order`, {
      ids: reordered(data.pre_onboarding, i, dir).map((x) => x.id),
    }).then(refresh);
  const moveBlock = (i: number, dir: -1 | 1) =>
    put(`/trajectories/${positionId}/blocks/order`, {
      ids: reordered(regular, i, dir).map((x: any) => x.id),
    }).then(refresh);
  const moveLesson = (blockId: string, lessons: any[], i: number, dir: -1 | 1) =>
    put(`/blocks/${blockId}/lessons/order`, {
      ids: reordered(lessons, i, dir).map((x: any) => x.id),
    }).then(refresh);

  async function publish() {
    try { await post(`/trajectories/${positionId}/publish`); toast('Траектория опубликована'); refresh(); }
    catch (e) {
      const d = e instanceof ApiError ? (e.details as string[]) : null;
      toast(d?.length ? `Нельзя опубликовать: ${d[0]}` : 'Нельзя опубликовать', 'warn');
      reload();
    }
  }
  async function unpublish() { await post(`/trajectories/${positionId}/unpublish`); refresh(); }

  return (
    <div>
      <div className="panel row-between">
        <div>
          <b>{data.status === 'active' ? '● Опубликована' : '○ Черновик'}</b>
          <span className="muted" style={{ fontSize: 13 }}>
            {' '}— {data.status === 'active' ? 'по ней открывается онбординг' : 'новички ждут публикации'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {ai?.enabled && (
            <button className="btn ghost sm" onClick={() => setPlanning(true)}
              title="Загрузить документы и получить готовую траекторию целиком">
              ✨ Собрать из документов
            </button>
          )}
          <button className="btn ghost sm" onClick={() => setPreview(true)}>Предпросмотр</button>
          {data.status === 'active'
            ? <button className="btn ghost sm" onClick={unpublish}>Снять с публикации</button>
            : <button className="btn sm" onClick={publish}>Опубликовать</button>}
        </div>
      </div>

      {/* Точка, глазами которой смотрим, и готовность каждой из них. Траектория
          публикуется по каркасу, а онбординг открывается только на готовых точках. */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span className="muted">Смотрю как</span>
            <select value={at} onChange={(e) => setAt(e.target.value)}>
              {locs?.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.locations?.map((l) => (
              <button key={l.location_id} className="btn ghost sm"
                onClick={() => setAt(l.location_id)}
                title={l.ready ? 'Всё заполнено' : l.problems.slice(0, 3).join('; ')}
                style={{ borderColor: l.ready ? 'var(--success)' : 'var(--warn, #b8860b)' }}>
                {l.ready ? '●' : '○'} {l.name}
                {!l.ready && <span className="muted"> · не хватает {l.problems.length}</span>}
              </button>
            ))}
          </div>
        </div>
        {data.locations?.some((l) => !l.ready) && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
            На точках с ○ онбординг не откроется, пока не заполнены их уроки. Новички
            дождутся и уйдут учиться сами, как только пробел закроют.
          </p>
        )}
      </div>

      {planning && (
        <AiPlanDialog
          positionId={positionId}
          positionName={positionName}
          readsPdf={!!ai?.reads_documents}
          hasContent={regular.length > 0}
          onClose={() => setPlanning(false)}
          onApplied={refresh}
        />
      )}

      {attAi && att && (
        <AiAttestationDialog
          blockId={att.id}
          positionName={positionName}
          hasTest={!!att.test?.questions?.length}
          onClose={() => setAttAi(false)}
          onApplied={refresh}
        />
      )}

      {preview && <ConstructorPreview positionId={positionId} onClose={() => setPreview(false)} />}

      {data.problems.length > 0 && (
        <div className="banner warn" style={{ marginBottom: 16 }}>
          <b>Чтобы опубликовать, доделайте:</b>
          <ul style={{ margin: '6px 0 0 18px' }}>
            {data.problems.slice(0, 8).map((p, i) => <li key={i} style={{ fontSize: 13 }}>{p}</li>)}
          </ul>
        </div>
      )}

      {/* pre-onboarding */}
      <div className="builder-block">
        <header><h4>Пре-онбординг (материалы о компании)</h4></header>
        <div className="body">
          {data.pre_onboarding.map((it, i) => (
            <div key={it.id} className="b-lesson">
              <div className="lh">
                <MoveBtns i={i} count={data.pre_onboarding.length} onMove={(d) => movePre(i, d)} />
                <span className="tag">{typeLabel(it.content_type)}</span>
                <EditableTitle value={it.title} onSave={(v) => patch(`/pre-onboarding/${it.id}`, { title: v }).then(refresh)} />
                <button className="btn danger sm" onClick={() => del(`/pre-onboarding/${it.id}`).then(refresh)}>✕</button>
              </div>
              {it.content_type === 'text' ? (
                <textarea defaultValue={it.text_body ?? ''} rows={2} style={{ width: '100%', marginTop: 8 }}
                  onBlur={(e) => patch(`/pre-onboarding/${it.id}`, { text_body: e.target.value }).then(refresh)} />
              ) : (
                <div style={{ marginTop: 8 }}>
                  <FilePicker
                    kind={it.content_type === 'video' ? 'video' : 'pdf'}
                    value={it.file_url}
                    onChange={(url) => patch(`/pre-onboarding/${it.id}`, { file_url: url }).then(refresh)}
                  />
                </div>
              )}
            </div>
          ))}
          <InlineAdd placeholder="Заголовок материала" label="+ материал" withType
            onAdd={async (title, type) => {
              await post(`/trajectories/${positionId}/pre-onboarding`, {
                title, content_type: type,
                text_body: type === 'text' ? 'Текст материала…' : null,
                file_url: null,   // файл выбирается отдельно, ссылок-заглушек больше нет
              });
              refresh();
            }} />
        </div>
      </div>

      {/* regular blocks */}
      {regular.map((b, bi) => (
        <div key={b.id} className="builder-block">
          <header>
            <MoveBtns i={bi} count={regular.length} onMove={(d) => moveBlock(bi, d)} />
            <EditableTitle value={b.title} heading onSave={(v) => patch(`/blocks/${b.id}`, { title: v }).then(refresh)} />
            <button className="btn danger sm" onClick={() => {
              if (confirm('Удалить блок со всеми уроками?')) del(`/blocks/${b.id}`).then(refresh);
            }}>Удалить блок</button>
          </header>
          <div className="body">
            {b.lessons.map((l: any, li: number) => (
              <LessonEditor key={l.id} lesson={l} onChange={refresh} at={at} locations={locs?.items ?? []}
                ai={!!ai?.enabled} readsPdf={!!ai?.reads_documents}
                i={li} count={b.lessons.length} onMove={(d) => moveLesson(b.id, b.lessons, li, d)} />
            ))}
            <InlineAdd placeholder="Название урока" label="+ урок"
              onAdd={async (title) => { await post(`/blocks/${b.id}/lessons`, { title }); refresh(); }} />
          </div>
        </div>
      ))}

      <InlineAdd placeholder="Название блока" label="+ блок"
        onAdd={async (title) => { await post(`/trajectories/${positionId}/blocks`, { title }); refresh(); }} />

      {/* attestation */}
      {att && (
        <div className="builder-block" style={{ marginTop: 16, borderColor: 'var(--accent)' }}>
          <header className="row-between">
            <h4>★ Аттестация — финальный тест</h4>
            {ai?.enabled && (
              <button className="btn sm" onClick={() => setAttAi(true)}
                title="Свои вопросы по материалам всех уроков — не повторяющие уроки">
                ✨ Собрать ИИ
              </button>
            )}
          </header>
          <div className="body">
            <TestEditor
              test={att.test}
              onCreate={(pass) => put(`/blocks/${att.id}/test`, { pass_mark_pct: pass }).then(refresh)}
              onChange={refresh}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function LessonEditor({ lesson, onChange, i, count, onMove, at, locations, ai, readsPdf }: {
  lesson: any; onChange: () => void; i: number; count: number; onMove: (dir: -1 | 1) => void;
  at: string; locations: Loc[]; ai: boolean; readsPdf: boolean;
}) {
  const [tab, setTab] = useState<'material' | 'test' | 'scope' | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const hasMat = lesson.material && (lesson.material.text_body || lesson.material.file_url);
  const hasTest = lesson.test && lesson.test.questions.length > 0;
  // У точечного урока материал и тест заводятся под выбранную точку,
  // у общего — на всю сеть; сервер не даст перепутать одно с другим.
  const slot = lesson.content_per_location ? at : undefined;
  const here = locations.find((l) => l.id === at)?.name ?? 'этой точки';

  return (
    <div className="b-lesson">
      <div className="lh">
        <MoveBtns i={i} count={count} onMove={onMove} />
        <EditableTitle value={lesson.title} onSave={(v) => patch(`/lessons/${lesson.id}`, { title: v }).then(onChange)} />
        {lesson.content_per_location && <span className="tag">своё на точке</span>}
        {!lesson.everywhere && <span className="tag">только {lesson.locations?.length ?? 0} точки</span>}
        <span className={`tag ${hasMat ? 'ok' : 'no'}`}>материал {hasMat ? '✓' : '—'}</span>
        <span className={`tag ${hasTest ? 'ok' : 'no'}`}>тест {hasTest ? '✓' : '—'}</span>
        <button className="btn danger sm" onClick={() => {
          if (confirm('Удалить урок?')) del(`/lessons/${lesson.id}`).then(onChange);
        }}>✕</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn ghost sm" onClick={() => setTab(tab === 'material' ? null : 'material')}>Материал</button>
        <button className="btn ghost sm" onClick={() => setTab(tab === 'test' ? null : 'test')}>Тест</button>
        <button className="btn ghost sm" onClick={() => setTab(tab === 'scope' ? null : 'scope')}>Где и чьё</button>
        {ai && (
          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setAiOpen(true)}>
            Собрать ИИ
          </button>
        )}
      </div>

      {aiOpen && (
        <AiLessonDialog
          lessonId={lesson.id}
          lessonTitle={lesson.title}
          locationId={slot}
          locationName={slot ? here : undefined}
          readsPdf={readsPdf}
          onClose={() => setAiOpen(false)}
          onApplied={() => { setAiOpen(false); onChange(); }}
        />
      )}

      {tab === 'scope' && <LessonScope lesson={lesson} locations={locations} onChange={onChange} />}
      {lesson.content_per_location && (tab === 'material' || tab === 'test') && (
        <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
          Правите вариант точки <b>{here}</b>. На других точках он свой.
        </p>
      )}
      {tab === 'material' && (
        <div style={{ marginTop: 10 }}>
          <MaterialForm lessonId={lesson.id} material={lesson.material} locationId={slot}
            onSaved={() => { onChange(); }} />
        </div>
      )}
      {tab === 'test' && (
        <div style={{ marginTop: 10 }}>
          <TestEditor
            test={lesson.test}
            onCreate={(pass) => put(`/lessons/${lesson.id}/test`,
              { pass_mark_pct: pass, ...(slot ? { location_id: slot } : {}) }).then(onChange)}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

const typeLabel = (t: string) => (t === 'video' ? 'Видео' : t === 'pdf' ? 'PDF' : 'Текст');

/**
 * Где урок есть и чьё у него содержимое — два независимых решения.
 *
 * Разводить их важно: «Стандарты сервиса» одинаковы во всей сети, «План зала»
 * есть везде, но у каждой точки свой, а «Боулинг» существует не везде. Смешивать
 * это в один переключатель значит заставлять HR думать за модель данных.
 */
function LessonScope({ lesson, locations, onChange }: {
  lesson: any; locations: Loc[]; onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const chosen: string[] = lesson.locations ?? [];

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    try { await patch(`/lessons/${lesson.id}`, body); onChange(); }
    finally { setBusy(false); }
  }

  function toggleLocation(id: string) {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    save({ everywhere: false, locations: next });
  }

  return (
    <div style={{ marginTop: 10, background: '#fff', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
      <div className="field" style={{ marginBottom: 12 }}>
        <span>Где есть урок</span>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 4 }}>
          <input type="radio" checked={!!lesson.everywhere} disabled={busy}
            onChange={() => save({ everywhere: true })} /> На всех точках
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="radio" checked={!lesson.everywhere} disabled={busy}
            onChange={() => save({ everywhere: false, locations: chosen })} /> Только на выбранных
        </label>
        {!lesson.everywhere && (
          <div style={{ display: 'grid', gap: 4, marginTop: 6, paddingLeft: 22 }}>
            {locations.map((l) => (
              <label key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={chosen.includes(l.id)} disabled={busy}
                  onChange={() => toggleLocation(l.id)} /> {l.name}
              </label>
            ))}
            {chosen.length === 0 && (
              <span className="banner warn" style={{ fontSize: 12.5, marginTop: 4 }}>
                Не выбрано ни одной точки — такой урок не попадёт ни к кому.
              </span>
            )}
          </div>
        )}
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <span>Содержимое</span>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 4 }}>
          <input type="radio" checked={!lesson.content_per_location} disabled={busy}
            onChange={() => {
              if (lesson.content_per_location
                && !confirm('Материалы и тесты, заведённые по точкам, будут удалены. Продолжить?')) return;
              save({ content_per_location: false });
            }} /> Одинаковое везде
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="radio" checked={!!lesson.content_per_location} disabled={busy}
            onChange={() => {
              if (!lesson.content_per_location
                && !confirm('Общий материал и тест будут удалены — их нужно будет завести на каждой точке. Продолжить?')) return;
              save({ content_per_location: true });
            }} /> Своё на каждой точке
        </label>
      </div>
    </div>
  );
}
