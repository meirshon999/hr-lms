import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, ApiError } from '../../api';
import { useAsync, useBump, ErrorBox, SkeletonLesson, useToast } from '../../lib';
import { Phone } from '../../components/Phone';
import { TestRunner } from '../../components/TestRunner';
import { VideoPlayer } from '../../components/VideoPlayer';
import { PdfView } from '../../components/PdfView';

interface Study {
  seconds_spent: number; needed_seconds: number;
  need_scroll: boolean; scroll_pct: number; can_complete: boolean; why: string;
}

interface LessonDto {
  id: string; title: string; status: string; material_done: boolean; video_pct: number;
  study: Study;
  index: number; total: number;
  material: { content_type: 'video' | 'pdf' | 'text'; file_url: string | null; text_body: string | null; min_watch_pct: number | null } | null;
  test: {
    id: string; pass_mark_pct: number;
    questions: { id: string; text: string; options: string[] }[];
    last_attempt: { score_pct: number; passed: boolean } | null;
  } | null;
}

/** Как часто говорим серверу «я всё ещё здесь». Реже — грубее счёт, чаще — зря шумим. */
const BEAT_SEC = 15;

/** «Ещё 40 секунд» понятнее, чем «ещё 0.7 минуты». */
const human = (sec: number) =>
  sec >= 90 ? `${Math.ceil(sec / 60)} мин` : `${Math.max(5, Math.ceil(sec / 5) * 5)} сек`;

export function Lesson() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { bump } = useBump();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get<LessonDto>(`/me/lessons/${id}`), [id]);

  const [step, setStep] = useState<'material' | 'test'>('material');
  const [, setVideoPct] = useState(0);
  const [study, setStudy] = useState<Study | null>(null);
  const [busy, setBusy] = useState(false);
  // Прокрутку храним в ref: её читает таймер, а перерисовывать из-за неё нечего.
  const scroll = useRef(0);

  useEffect(() => {
    if (!data) return;
    setVideoPct(data.video_pct);
    setStudy(data.study);
    setStep(data.material_done && data.test ? 'test' : 'material');
    scroll.current = data.study?.scroll_pct ?? 0;
  }, [data?.id, data?.material_done]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * УДАРЫ СЕРДЦА: «я всё ещё здесь».
   *
   * Каждые пятнадцать секунд говорим серверу, что материал открыт. Он режет
   * присланное по своим часам, так что накрутить время нельзя — можно только
   * потратить его.
   *
   * Считаем только когда вкладка видна: человек ушёл в другое окно — время не
   * идёт. Это не строгость ради строгости, а честность: «сидел с открытой
   * вкладкой» и «читал» — разные вещи, и первое мы за второе не принимаем.
   */
  const lessonId = data?.id;
  const done = data?.material_done;
  useEffect(() => {
    if (!lessonId || done) return;
    let live = true;
    const tick = async () => {
      if (!live || document.hidden) return;
      try {
        const r = await post<Study & { can_complete: boolean }>(
          `/me/lessons/${lessonId}/beat`,
          { seconds: BEAT_SEC, scroll_pct: scroll.current },
        );
        if (live) setStudy((s) => (s ? { ...s, ...r } : s));
      } catch {
        // Сеть моргнула — молчим: в следующий удар всё сойдётся.
      }
    };
    // Первый удар сразу: он заводит отсчёт на сервере.
    tick();
    const timer = setInterval(tick, BEAT_SEC * 1000);
    return () => { live = false; clearInterval(timer); };
  }, [lessonId, done]);

  /**
   * «Дочитал» определяем по обычной прокрутке страницы: когда конец текста
   * попал в экран. Без вложенного скролла — на телефоне это мучение.
   */
  const endRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) { scroll.current = 100; io.disconnect(); }
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

  // скелетон только на первой загрузке: bump() после ответа не должен
  // размонтировать TestRunner и стирать экран результата
  if (loading && !data) return <Phone hello="Урок" back><SkeletonLesson /></Phone>;
  if (error) return <Phone hello="Урок" back><ErrorBox error={error} onRetry={reload} /></Phone>;
  if (!data) return null;

  const m = data.material;
  const needPct = m?.min_watch_pct ?? 90;
  // Готовность решает сервер: он один знает, сколько времени прошло на самом
  // деле. Клиент только показывает, сколько осталось.
  const materialReady = study?.can_complete ?? false;
  const left = Math.max(0, (study?.needed_seconds ?? 0) - (study?.seconds_spent ?? 0));

  const action = step === 'material' && !data.material_done ? (
    <button className="btn block" disabled={!materialReady || busy} onClick={materialDone}>
      {busy ? 'Сохраняем…' : 'Отметить пройденным'}
    </button>
  ) : step === 'material' && data.material_done ? (
    <button className="btn block" onClick={() => (data.test ? setStep('test') : nav('/'))}>
      {data.test ? 'К тесту' : 'Вернуться к траектории'}
    </button>
  ) : undefined;

  const needScroll = !!study?.need_scroll && scroll.current < 90;
  const hint = step === 'material' && !materialReady
    ? (left > 0 && needScroll ? `Дочитайте до конца — и ещё ${human(left)}`
      : left > 0 ? (m?.content_type === 'video'
        ? `Смотреть ещё ${human(left)} — нужно ${needPct}% ролика`
        : `Ещё ${human(left)} на материале`)
      : 'Дочитайте материал до конца')
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
              src={m.file_url}
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
              <PdfView src={m.file_url} onOpened={() => { scroll.current = 100; }} />
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
