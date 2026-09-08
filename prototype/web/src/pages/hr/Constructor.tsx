import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, put, ApiError } from '../../api';
import { useAsync, useBump, Loader, ErrorBox, useToast } from '../../lib';
import { InlineAdd, EditableTitle, MoveBtns, reordered } from '../../components/inline';
import { MaterialForm } from '../../components/MaterialForm';
import { TestEditor } from '../../components/TestEditor';
import { ConstructorPreview } from '../../components/ConstructorPreview';

interface Pos { id: string; name: string; trajectory_status: string; }

export function Constructor() {
  const { positionId } = useParams();
  const nav = useNavigate();
  const { bump, n } = useBump();
  const toast = useToast();
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

          {positionId && <TrajectoryEditor key={positionId + n} positionId={positionId} onChange={bump} />}
        </div>
      )}
    </>
  );
}

interface Traj {
  id: string; status: string; problems: string[];
  pre_onboarding: { id: string; title: string; content_type: string; text_body: string | null; file_url: string | null }[];
  blocks: any[];
}

function TrajectoryEditor({ positionId, onChange }: { positionId: string; onChange: () => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState(false);
  const { data, loading, error, reload } = useAsync(
    () => get<Traj>(`/trajectories/${positionId}`), [positionId],
  );
  const refresh = () => { reload(); onChange(); };

  if (loading) return <Loader />;
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
          <button className="btn ghost sm" onClick={() => setPreview(true)}>Предпросмотр</button>
          {data.status === 'active'
            ? <button className="btn ghost sm" onClick={unpublish}>Снять с публикации</button>
            : <button className="btn sm" onClick={publish}>Опубликовать</button>}
        </div>
      </div>

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
              {it.content_type === 'text' && (
                <textarea defaultValue={it.text_body ?? ''} rows={2} style={{ width: '100%', marginTop: 8 }}
                  onBlur={(e) => patch(`/pre-onboarding/${it.id}`, { text_body: e.target.value }).then(refresh)} />
              )}
            </div>
          ))}
          <InlineAdd placeholder="Заголовок материала" label="+ материал" withType
            onAdd={async (title, type) => {
              await post(`/trajectories/${positionId}/pre-onboarding`, {
                title, content_type: type,
                text_body: type === 'text' ? 'Текст материала…' : null,
                file_url: type !== 'text' ? 'demo:file' : null,
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
              <LessonEditor key={l.id} lesson={l} onChange={refresh}
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
          <header><h4>★ Аттестация — финальный тест</h4></header>
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

function LessonEditor({ lesson, onChange, i, count, onMove }: {
  lesson: any; onChange: () => void; i: number; count: number; onMove: (dir: -1 | 1) => void;
}) {
  const [tab, setTab] = useState<'material' | 'test' | null>(null);
  const hasMat = lesson.material && (lesson.material.text_body || lesson.material.file_url);
  const hasTest = lesson.test && lesson.test.questions.length > 0;

  return (
    <div className="b-lesson">
      <div className="lh">
        <MoveBtns i={i} count={count} onMove={onMove} />
        <EditableTitle value={lesson.title} onSave={(v) => patch(`/lessons/${lesson.id}`, { title: v }).then(onChange)} />
        <span className={`tag ${hasMat ? 'ok' : 'no'}`}>материал {hasMat ? '✓' : '—'}</span>
        <span className={`tag ${hasTest ? 'ok' : 'no'}`}>тест {hasTest ? '✓' : '—'}</span>
        <button className="btn danger sm" onClick={() => {
          if (confirm('Удалить урок?')) del(`/lessons/${lesson.id}`).then(onChange);
        }}>✕</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn ghost sm" onClick={() => setTab(tab === 'material' ? null : 'material')}>Материал</button>
        <button className="btn ghost sm" onClick={() => setTab(tab === 'test' ? null : 'test')}>Тест</button>
      </div>
      {tab === 'material' && (
        <div style={{ marginTop: 10 }}>
          <MaterialForm lessonId={lesson.id} material={lesson.material} onSaved={() => { onChange(); }} />
        </div>
      )}
      {tab === 'test' && (
        <div style={{ marginTop: 10 }}>
          <TestEditor
            test={lesson.test}
            onCreate={(pass) => put(`/lessons/${lesson.id}/test`, { pass_mark_pct: pass }).then(onChange)}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

const typeLabel = (t: string) => (t === 'video' ? 'Видео' : t === 'pdf' ? 'PDF' : 'Текст');
