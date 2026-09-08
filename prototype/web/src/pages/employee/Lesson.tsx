import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, ApiError } from '../../api';
import { useAsync, useBump, ErrorBox, SkeletonLesson, useToast } from '../../lib';
import { Phone } from '../../components/Phone';
import { TestRunner } from '../../components/TestRunner';
import { VideoPlayer } from '../../components/VideoPlayer';

interface LessonDto {
  id: string; title: string; status: string; material_done: boolean; video_pct: number;
  index: number; total: number;
  material: { content_type: 'video' | 'pdf' | 'text'; file_url: string | null; text_body: string | null; min_watch_pct: number | null } | null;
  test: {
    id: string; pass_mark_pct: number;
    questions: { id: string; text: string; options: string[] }[];
    last_attempt: { score_pct: number; passed: boolean } | null;
  } | null;
}

export function Lesson() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { bump } = useBump();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get<LessonDto>(`/me/lessons/${id}`), [id]);

  const [step, setStep] = useState<'material' | 'test'>('material');
  const [videoPct, setVideoPct] = useState(0);
  const [scrolledEnd, setScrolledEnd] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setVideoPct(data.video_pct);
    setStep(data.material_done && data.test ? 'test' : 'material');
    setScrolledEnd(data.material?.content_type !== 'text');
  }, [data?.id, data?.material_done]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * «Дочитал» определяем по обычной прокрутке страницы: когда конец текста
   * попал в экран. Без вложенного скролла — на телефоне это мучение.
   */
  const endRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) { setScrolledEnd(true); io.disconnect(); }
    }, { rootMargin: '0px 0px -40px 0px' });
    io.observe(el);
  }, []);

  async function materialDone() {
    setBusy(true);
    try {
      await post(`/me/lessons/${id}/material-done`);
      bump();
      const fresh = await get<LessonDto>(`/me/lessons/${id}`);
      if (fresh.test) setStep('test'); else nav('/');
      reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Не удалось сохранить', 'warn');
    } finally { setBusy(false); }
  }

  if (loading) return <Phone hello="Урок" back><SkeletonLesson /></Phone>;
  if (error) return <Phone hello="Урок" back><ErrorBox error={error} onRetry={reload} /></Phone>;
  if (!data) return null;

  const m = data.material;
  const needPct = m?.min_watch_pct ?? 90;
  const materialReady =
    m?.content_type === 'video' ? videoPct >= needPct
      : m?.content_type === 'text' ? scrolledEnd
        : true;

  const action = step === 'material' && !data.material_done ? (
    <button className="btn block" disabled={!materialReady || busy} onClick={materialDone}>
      {busy ? 'Сохраняем…' : 'Отметить пройденным'}
    </button>
  ) : step === 'material' && data.material_done ? (
    <button className="btn block" onClick={() => (data.test ? setStep('test') : nav('/'))}>
      {data.test ? 'К тесту' : 'Вернуться к траектории'}
    </button>
  ) : undefined;

  const hint = step === 'material' && !materialReady
    ? (m?.content_type === 'video' ? `Досмотрите видео до ${needPct}%` : 'Дочитайте материал до конца')
    : undefined;

  return (
    <Phone
      hello={data.title}
      sub={`Урок ${data.index} из ${data.total}`}
      back
      action={action}
      actionHint={hint}
    >
      <div className="steps-bar">
        <div className={`s ${data.material_done ? 'done' : 'on'}`} />
        <div className={`s ${step === 'test' ? (data.status === 'passed' ? 'done' : 'on') : ''}`} />
      </div>

      {data.status === 'passed' && (
        <div className="banner ok" style={{ marginBottom: 12, fontSize: 13 }}>
          Урок пройден. Можно повторить материал или тест.
        </div>
      )}

      {step === 'material' && (
        <>
          {m?.content_type === 'video' && (
            <VideoPlayer
              lessonId={id}
              minWatchPct={m.min_watch_pct}
              initialPct={data.video_pct}
              onProgress={setVideoPct}
            />
          )}
          {m?.content_type === 'text' && (
            <div className="material">
              <p style={{ whiteSpace: 'pre-wrap' }}>{m.text_body}</p>
              <div ref={endRef} style={{ height: 1 }} />
            </div>
          )}
          {m?.content_type === 'pdf' && (
            <div className="material">
              <div className="video-stub" style={{ padding: 30 }}>
                <div className="play">⬇</div>
                <div>PDF-документ (демо)</div>
              </div>
            </div>
          )}
          {data.material_done && (
            <div className="banner ok mt16" style={{ fontSize: 13 }}>Материал пройден ✓</div>
          )}
        </>
      )}

      {step === 'test' && data.test && (
        <>
          <div className="block-h" style={{ marginTop: 0 }}>Тест по уроку</div>
          <button className="btn ghost sm" style={{ marginBottom: 10 }} onClick={() => setStep('material')}>
            ← к материалу
          </button>
          <TestRunner
            sticky
            title="Урок"
            questions={data.test.questions}
            onSubmit={async (answers) => {
              const r = await post(`/me/lessons/${id}/test`, { answers });
              bump();
              return r;
            }}
            onPassedContinue={() => nav('/')}
            continueLabel="Вернуться к траектории"
          />
        </>
      )}

      {step === 'test' && !data.test && (
        <div className="banner info">У этого урока нет теста.</div>
      )}
    </Phone>
  );
}
