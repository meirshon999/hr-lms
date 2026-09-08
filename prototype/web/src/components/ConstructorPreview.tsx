import { useState } from 'react';
import { get } from '../api';
import { useAsync, Loader, ErrorBox } from '../lib';

/** Предпросмотр траектории глазами сотрудника (read-only, всё открыто, верные ответы подсвечены). */
export function ConstructorPreview({ positionId, onClose }: { positionId: string; onClose: () => void }) {
  const { data, loading, error } = useAsync(() => get<any>(`/trajectories/${positionId}`), [positionId]);
  const [openLesson, setOpenLesson] = useState<string | null>(null);
  const [tab, setTab] = useState<'pre' | 'onb'>('pre');

  const regular = data?.blocks?.filter((b: any) => b.kind === 'regular') ?? [];
  const att = data?.blocks?.find((b: any) => b.kind === 'attestation');

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 480, padding: 0, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ background: 'var(--primary)', color: '#fff', padding: '16px 18px' }}>
          <div className="row-between">
            <b style={{ fontFamily: 'Playfair Display, serif', fontSize: 17 }}>Предпросмотр — как видит сотрудник</b>
            <button onClick={onClose} style={{ color: '#e6cfa0' }}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className={`btn sm ${tab === 'pre' ? '' : 'ghost'}`}
              style={tab === 'pre' ? {} : { background: 'rgba(255,255,255,.12)', color: '#f0e2d5', border: 'none' }}
              onClick={() => setTab('pre')}>Пре-онбординг</button>
            <button className={`btn sm ${tab === 'onb' ? '' : 'ghost'}`}
              style={tab === 'onb' ? {} : { background: 'rgba(255,255,255,.12)', color: '#f0e2d5', border: 'none' }}
              onClick={() => setTab('onb')}>Онбординг</button>
          </div>
        </div>

        <div style={{ padding: '16px 16px 24px', overflowY: 'auto', background: 'var(--bg)' }}>
          {loading && <Loader />}
          {error && <ErrorBox error={error} />}
          {data && tab === 'pre' && (
            <div className="stack">
              {data.pre_onboarding.length === 0 && <p className="muted">Материалы пре-онбординга не добавлены.</p>}
              {data.pre_onboarding.map((it: any) => (
                <div key={it.id} className="material" style={{ margin: 0 }}>
                  <b>{it.title}</b>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{typeLabel(it.content_type)}</div>
                  {it.content_type === 'text'
                    ? <p style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{it.text_body || <span className="muted">(текст пустой)</span>}</p>
                    : <div className="video-stub" style={{ padding: 20 }}><div className="play" style={{ width: 40, height: 40 }}>▶</div>видео</div>}
                </div>
              ))}
            </div>
          )}

          {data && tab === 'onb' && (
            <div className="stack">
              {regular.map((b: any) => (
                <div key={b.id}>
                  <div className="block-h">{b.title}</div>
                  <div className="card" style={{ padding: '2px 12px', marginTop: 4 }}>
                    {b.lessons.map((l: any) => (
                      <div key={l.id}>
                        <div className="lesson-row clickable" onClick={() => setOpenLesson(openLesson === l.id ? null : l.id)}>
                          <div className="ico">{l.material?.content_type === 'video' ? '▶' : '≡'}</div>
                          <div className="tx"><b>{l.title}</b></div>
                          <span className="muted">{openLesson === l.id ? '▲' : '▸'}</span>
                        </div>
                        {openLesson === l.id && <LessonPreview lesson={l} />}
                      </div>
                    ))}
                    {b.lessons.length === 0 && <p className="muted" style={{ fontSize: 13, padding: 8 }}>Уроков нет</p>}
                  </div>
                </div>
              ))}
              <div className="block-h">Аттестация</div>
              <div className="card" style={{ padding: 12 }}>
                {att?.test?.questions?.length
                  ? <QuestionsPreview questions={att.test.questions} passMark={att.test.pass_mark_pct} />
                  : <p className="muted" style={{ fontSize: 13 }}>Тест аттестации не заполнен</p>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LessonPreview({ lesson }: { lesson: any }) {
  return (
    <div className="material" style={{ margin: '4px 0 10px' }}>
      {lesson.material?.content_type === 'text'
        ? <p style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{lesson.material.text_body || <span className="muted">(материал пустой)</span>}</p>
        : <div className="video-stub" style={{ padding: 20 }}><div className="play" style={{ width: 40, height: 40 }}>▶</div>видео {lesson.material?.min_watch_pct ? `(${lesson.material.min_watch_pct}%)` : ''}</div>}
      <div className="block-h" style={{ marginTop: 10 }}>Тест по уроку</div>
      {lesson.test?.questions?.length
        ? <QuestionsPreview questions={lesson.test.questions} passMark={lesson.test.pass_mark_pct} />
        : <p className="muted" style={{ fontSize: 13 }}>Тест не заполнен</p>}
    </div>
  );
}

function QuestionsPreview({ questions, passMark }: { questions: any[]; passMark: number }) {
  return (
    <>
      <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{questions.length} вопросов · порог {passMark}%</p>
      {questions.map((q: any, i: number) => (
        <div key={q.id} style={{ marginBottom: 10, fontSize: 14 }}>
          <b>{i + 1}. {q.text}</b>
          <ul style={{ margin: '4px 0 0 18px' }}>
            {q.options.map((o: string, oi: number) => (
              <li key={oi} style={oi === q.correct_index ? { color: 'var(--success)', fontWeight: 700 } : {}}>
                {o}{oi === q.correct_index ? '  ✓ верный' : ''}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

const typeLabel = (t: string) => (t === 'video' ? 'Видео' : t === 'pdf' ? 'PDF' : 'Текст');
