import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, put, ApiError, extractDocument } from '../../api';
import { useAsync, useBump, Loader, ErrorBox, useToast, DOC_ACCEPT } from '../../lib';
import { InlineAdd, EditableTitle, MoveBtns, reordered } from '../../components/inline';
import { useDragList, moved } from '../../components/dnd';
import { Icon } from '../../components/Icon';
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
  const { bump } = useBump();
  const { data: pl, loading, error, reload } = useAsync(() => get<{ items: Pos[] }>('/positions'), []);

  useEffect(() => {
    if (!positionId && pl?.items.length) nav(`/hr/constructor/${pl.items[0].id}`, { replace: true });
  }, [positionId, pl, nav]);

  return (
    <>
      <h1>Конструктор</h1>
      <p className="subtitle">Должности, траектории обучения, тесты</p>

      <div className="desktop-only-note notice info" style={{ marginBottom: 14 }}>
        <Icon name="alert" />
        <span className="grow">
          Конструктор рассчитан на компьютер — на телефоне редактировать неудобно.
        </span>
      </div>

      {loading && <Loader />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {pl && (
        <div className="builder">
          {/* Должности — строкой наверху, а не колонкой слева: место колонки
              заняла панель свойств справа, а должность выбирают раз за сеанс. */}
          <div className="pos-bar">
            {pl.items.map((p) => (
              <a key={p.id} href={`#/hr/constructor/${p.id}`}
                className={`chip${p.id === positionId ? ' on' : ''}`}>
                <i className={`dot${p.trajectory_status === 'active' ? ' live' : ''}`} />
                {p.name}
              </a>
            ))}
            <InlineAdd placeholder="Новая должность" onAdd={async (name) => {
              await post('/positions', { name }); bump();
            }} label="+ должность" />
          </div>

          {positionId && (
            /*
             * Ключ — только должность, и это важно.
             *
             * Раньше сюда подмешивался общий счётчик обновлений, и любое
             * сохранение меняло ключ: React выбрасывал редактор и собирал
             * заново. Вместе с ним умирало всё, что помнил экран, — раскрытый
             * урок, выбранная точка (сбрасывалась на первую) и место, где
             * человек стоял прокруткой.
             */
            <TrajectoryEditor
              key={positionId}
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
/** Ход пакетной сборки: какой урок собираем сейчас и сколько всего. */
interface Filling { title: string; done: number; total: number; }

function TrajectoryEditor({ positionId, positionName, onChange }: {
  positionId: string; positionName: string; onChange: () => void;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [attAi, setAttAi] = useState(false);
  const [lessonAi, setLessonAi] = useState(false);
  // Раскрытый урок и он же выбранный: панель справа показывает именно его.
  // Одно состояние вместо двух — не приходится гадать, к чему относится панель.
  const [sel, setSel] = useState<string | null>(null);
  // Человек нажал «собрать вручную» — показываем пустое дерево вместо приглашения.
  const [manual, setManual] = useState(false);
  const [filling, setFilling] = useState<Filling | null>(null);
  // Уроки, которым для сборки не хватило исходного текста: у них спрашиваем
  // документ, а не отправляем человека обходить их поодиночке.
  const [needDoc, setNeedDoc] = useState<any[] | null>(null);
  const stopFill = useRef(false);
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
  // Одного счётчика хватает: `useAsync` держит его в зависимостях и перечитывает
  // и траекторию, и список должностей. Отдельный reload() здесь означал бы
  // два запроса на каждое сохранение.
  const refresh = () => onChange();

  if (loading && !data) return <Loader />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  /*
   * Два разных списка недоделок, и путать их нельзя.
   *
   * `data.problems` — каркас на всю сеть: нет блока с уроком, нет аттестации,
   * у точечного урока не выбраны точки. Ровно на этом сервер отказывает
   * в публикации, поэтому кнопка гаснет именно по нему.
   *
   * Ошибки точки — это незаполненное содержимое. Публикацию они НЕ держат:
   * траектория публикуется целиком, а в онбординг с неготовой точки система
   * просто не пускает и подбирает людей сама, как только пробел закроют.
   */
  const currentLocation = data.locations?.find((l) => l.location_id === at);
  const hereProblems = currentLocation?.problems ?? [];
  const canPublish = data.problems.length === 0;

  const att = data.blocks.find((b) => b.kind === 'attestation');
  const regular = data.blocks.filter((b) => b.kind === 'regular');
  const published = data.status === 'active';
  const blank = regular.length === 0 && data.pre_onboarding.length === 0 && !manual;

  const allLessons: any[] = regular.flatMap((b: any) => b.lessons ?? []);
  const selLesson = allLessons.find((l) => l.id === sel) ?? null;
  const emptyLessons = allLessons.filter((l) => !hasMaterial(l) || !hasTest(l));

  /*
   * Где именно пробел. Сервер присылает недоделки строками — для каркаса это
   * правильно (бывает «нет блока аттестации», которому не соответствует ни один
   * узел). А незаполненное содержимое всегда лежит в конкретном уроке, и его
   * находим по тому же признаку, по которому рисуем метки «материал ✓ / тест —».
   */
  const gaps: { nodeId: string; lessonId?: string }[] = [];
  for (const b of regular) {
    if (!b.lessons?.length) { gaps.push({ nodeId: `blk-${b.id}` }); continue; }
    for (const l of b.lessons) {
      if ((!l.everywhere && !l.locations?.length) || !hasMaterial(l) || !hasTest(l)) {
        gaps.push({ nodeId: `les-${l.id}`, lessonId: l.id });
      }
    }
  }
  if (att && !att.test?.questions?.length) gaps.push({ nodeId: 'att' });

  /** Перевести человека к первому пробелу: раскрыть, прокрутить, подсветить. */
  function showFirstGap() {
    const g = gaps[0];
    if (!g) return;
    if (g.lessonId) setSel(g.lessonId);
    // Урок раскрывается этим же кадром, поэтому прокрутку откладываем: иначе
    // целимся в узел прежней высоты и промахиваемся.
    setTimeout(() => {
      const el = document.getElementById(g.nodeId);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1400);
    }, 60);
  }

  /*
   * ПАКЕТНАЯ СБОРКА УРОКОВ.
   *
   * Раньше кнопка «Собрать ИИ» висела в каждом уроке: на пяти блоках по четыре
   * урока это двадцать две кнопки и двадцать два захода. Теперь их две — на
   * блок и на всю траекторию, — а обход делает машина.
   *
   * Исходный текст искать не нужно: когда траекторию собирали из документов,
   * сервер запомнил, какой кусок регламента относится к какому уроку. У урока,
   * заведённого руками, такого куска нет — его честно пропускаем и говорим об
   * этом, а собрать его можно поодиночке из панели справа, там спрашивают текст.
   */
  async function sourceOf(lessonId: string): Promise<string | null> {
    try {
      const r = await get<{ source_text: string }>(`/ai/lessons/${lessonId}/source`);
      return r.source_text;
    } catch {
      return null; // исходника нет — это не поломка, а обычный ручной урок
    }
  }

  /**
   * Заполнить пустые уроки списка.
   *
   * `fallback` — текст, который человек принёс сам; он идёт тем урокам,
   * у которых сохранённого куска регламента нет. Без него такие уроки
   * не пропускаем молча, а спрашиваем документ: «соберите их по одному» —
   * это не ответ, когда уроков семь.
   */
  async function fillLessons(list: any[], fallback?: string) {
    const need = list.filter((l) => !hasMaterial(l) || !hasTest(l));
    if (!need.length) return;
    stopFill.current = false;
    const skipped: any[] = [];
    let done = 0;
    let built = 0;

    for (const l of need) {
      if (stopFill.current) break;
      setFilling({ title: l.title, done, total: need.length });
      const src = fallback ?? await sourceOf(l.id);
      if (!src) { skipped.push(l); done++; continue; }
      // У точечного урока содержимое заводится под выбранную точку,
      // у общего — на всю сеть; сервер не даст перепутать одно с другим.
      const slot = l.content_per_location ? { location_id: at } : {};
      try {
        const r = await post<{ draft: { title: string } }>(
          `/ai/lessons/${l.id}/draft`, { source_text: src, ...slot });
        // Название оставляем человеческое. Поодиночке черновик показывают, и
        // заголовок из него — предложение, которое можно принять. В пакетной
        // сборке человек черновиков не видит, и переименовать ему «Безопасность
        // и эвакуацию» во что-то своё значит молча сломать дерево, которое он
        // же и построил.
        await post(`/ai/lessons/${l.id}/apply`,
          { draft: { ...r.draft, title: l.title }, ...slot });
        built++;
      } catch (e) {
        // Один урок не собрался — остальные это не отменяет.
        toast(e instanceof ApiError ? `«${l.title}»: ${e.message}` : `«${l.title}» не собрался`, 'warn');
      }
      done++;
    }

    setFilling(null);
    refresh();
    if (built) toast(`Собрано уроков: ${built}`);
    // Осталось то, что собрать было не из чего — спрашиваем документ.
    if (skipped.length) setNeedDoc(skipped);
  }

  const movePre = (i: number, dir: -1 | 1) =>
    put(`/trajectories/${positionId}/pre-onboarding/order`, {
      ids: reordered(data.pre_onboarding, i, dir).map((x) => x.id),
    }).then(refresh);
  const orderBlocks = (ids: string[]) =>
    put(`/trajectories/${positionId}/blocks/order`, { ids }).then(refresh);
  const orderLessons = (blockId: string, ids: string[]) =>
    put(`/blocks/${blockId}/lessons/order`, { ids }).then(refresh);

  async function publish() {
    try { await post(`/trajectories/${positionId}/publish`); toast('Траектория опубликована'); refresh(); }
    catch (e) {
      const d = e instanceof ApiError ? (e.details as string[]) : null;
      toast(d?.length ? `Нельзя опубликовать: ${d[0]}` : 'Нельзя опубликовать', 'warn');
      reload();
    }
  }
  async function unpublish() { await post(`/trajectories/${positionId}/unpublish`); refresh(); }

  const dialogs = (
    <>
      {planning && (
        <AiPlanDialog
          positionId={positionId} positionName={positionName}
          hasContent={regular.length > 0}
          onClose={() => setPlanning(false)} onApplied={refresh}
        />
      )}
      {attAi && att && (
        <AiAttestationDialog
          blockId={att.id} positionName={positionName}
          hasTest={!!att.test?.questions?.length}
          onClose={() => setAttAi(false)} onApplied={refresh}
        />
      )}
      {lessonAi && selLesson && (
        <AiLessonDialog
          lessonId={selLesson.id} lessonTitle={selLesson.title}
          locationId={selLesson.content_per_location ? at : undefined}
          locationName={selLesson.content_per_location ? currentLocation?.name : undefined}
          onClose={() => setLessonAi(false)}
          onApplied={() => { setLessonAi(false); refresh(); }}
        />
      )}
      {preview && <ConstructorPreview positionId={positionId} onClose={() => setPreview(false)} />}
      {needDoc && (
        <BlockDocDialog
          lessons={needDoc}
          onClose={() => setNeedDoc(null)}
          onText={(text) => { const list = needDoc; setNeedDoc(null); fillLessons(list, text); }}
        />
      )}
    </>
  );

  if (blank) {
    return (
      <>
        {dialogs}
        <div className="invite">
          <div className="ico"><Icon name="layers" size={26} /></div>
          <h3>В должности «{positionName}» пока ничего нет</h3>
          <p>
            Принесите регламенты и инструкции — блоки, уроки с тестами и финальная
            аттестация соберутся сами, а вы их поправите. Собирать дерево вручную
            и искать под каждый урок нужный кусок текста не придётся.
          </p>
          {ai?.enabled ? (
            <button className="btn" onClick={() => setPlanning(true)}>
              <Icon name="wand" /> Собрать из документов
            </button>
          ) : (
            <p className="notice warn" style={{ display: 'inline-flex' }}>
              <Icon name="alert" />
              <span>Сборка из документов выключена: в настройках нет ключа ИИ</span>
            </p>
          )}
          <div className="or">
            <button className="btn icon" style={{ padding: '6px 10px', textDecoration: 'underline' }}
              onClick={() => setManual(true)}>
              или собрать вручную
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {dialogs}

      {/* Точка, глазами которой смотрим, и её готовность. */}
      <div className="tabs">
        {data.locations?.map((l) => (
          <button key={l.location_id} className={l.location_id === at ? 'on' : ''}
            onClick={() => setAt(l.location_id)}
            title={l.ready ? 'Всё заполнено' : l.problems.slice(0, 3).join('; ')}>
            {l.name}
            {l.ready
              ? <Icon name="check" size={14} className="done" />
              : <span className="n">{l.problems.length}</span>}
          </button>
        ))}
      </div>

      <div className="build">
        <div className="tree">
          {/* Каркас — то, на чём откажет сервер. Первым и отдельно. */}
          {data.problems.length > 0 && (
            <details className="notice bad">
              <summary>
                <Icon name="alert" />
                <b className="grow">
                  Каркас не готов: {data.problems.length}{' '}
                  {plural(data.problems.length, 'недоделка', 'недоделки', 'недоделок')}
                </b>
                <span style={{ fontSize: 12.5, opacity: .8 }}>показать</span>
              </summary>
              <ul>{data.problems.slice(0, 12).map((p, i) => <li key={i}>{p}</li>)}</ul>
            </details>
          )}

          {hereProblems.length > 0 && (
            <div className="notice warn">
              <Icon name="clock" />
              <span className="grow">
                <b>«{currentLocation?.name}»</b> — новички этой точки будут ждать:
                не заполнено {hereProblems.length}{' '}
                {plural(hereProblems.length, 'место', 'места', 'мест')}.
                На готовых точках онбординг откроется сразу.
              </span>
              {gaps.length > 0 && (
                <button className="btn ghost sm" onClick={showFirstGap}>Показать первое</button>
              )}
            </div>
          )}

          {/* Пакетная сборка: одна кнопка вместо обхода всех пустых уроков. */}
          {filling ? (
            <div className="notice info">
              <span className="grow">
                <b>Собираем: {filling.title}</b> — {filling.done} из {filling.total}
                <span className="bar">
                  <i style={{ width: `${Math.round((filling.done / filling.total) * 100)}%` }} />
                </span>
              </span>
              <button className="btn ghost sm" onClick={() => { stopFill.current = true; }}>
                Остановить
              </button>
            </div>
          ) : ai?.enabled && emptyLessons.length > 0 && (
            <div className="notice info">
              <Icon name="wand" />
              <span className="grow">
                {emptyLessons.length}{' '}
                {plural(emptyLessons.length, 'урок ещё пустой', 'урока ещё пустые', 'уроков ещё пустые')}
              </span>
              <button className="btn sm" onClick={() => fillLessons(allLessons)}>
                Заполнить пустые уроки
              </button>
            </div>
          )}

          {/*
            * Два этапа разведены заголовками, и это не украшение.
            * Пре-онбординг читают дома, до первой смены, и тестов в нём нет;
            * онбординг открывается только после отметки о стажировке. Пока
            * карточки шли подряд и выглядели одинаково, кадровик складывал
            * регламент смены туда, где его прочитают до найма.
            */}
          <div className="stage-h">
            <h3>Пре-онбординг</h3>
            <p>Читают дома, пока идёт стажировка. Рассказ о сети, без тестов</p>
          </div>

          <div className="bcard">
            <header><h4>Материалы о компании</h4></header>
            <div className="body">
              {data.pre_onboarding.map((it, i) => (
                <div key={it.id} className="b-lesson">
                  <div className="lh">
                    <MoveBtns i={i} count={data.pre_onboarding.length} onMove={(d) => movePre(i, d)} />
                    <span className="tag">{typeLabel(it.content_type)}</span>
                    <EditableTitle value={it.title}
                      onSave={(v) => patch(`/pre-onboarding/${it.id}`, { title: v }).then(refresh)} />
                    <button className="btn icon danger" title="Удалить материал"
                      onClick={() => del(`/pre-onboarding/${it.id}`).then(refresh)}>
                      <Icon name="trash" />
                    </button>
                  </div>
                  {it.content_type === 'text' ? (
                    <textarea defaultValue={it.text_body ?? ''} rows={3} style={{ width: '100%', marginTop: 8 }}
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
                    file_url: null,
                  });
                  refresh();
                }} />
            </div>
          </div>

          <div className="stage-h">
            <h3>Онбординг</h3>
            <p>
              Открывается, когда вы отметите стажировку пройденной. Блоки, уроки
              с тестами и финальная аттестация
            </p>
          </div>

          <Blocks
            blocks={regular} at={at} ai={!!ai?.enabled} sel={sel} busy={!!filling}
            onSelect={(id) => setSel((s) => (s === id ? null : id))}
            onChange={refresh}
            onOrderBlocks={orderBlocks}
            onOrderLessons={orderLessons}
            onFillBlock={(b) => fillLessons(b.lessons ?? [])}
            onAddLesson={async (blockId, title) => {
              await post(`/blocks/${blockId}/lessons`, { title }); refresh();
            }}
          />

          <InlineAdd placeholder="Название блока" label="+ блок"
            onAdd={async (title) => { await post(`/trajectories/${positionId}/blocks`, { title }); refresh(); }} />

          {att && (
            <div className="bcard" id="att" style={{ marginTop: 18 }}>
              <header>
                <Icon name="award" size={18} />
                <h4>Аттестация — финальный тест</h4>
                {!att.test?.questions?.length && <span className="tag no">нет вопросов</span>}
                {ai?.enabled && (
                  <button className="btn ghost sm" onClick={() => setAttAi(true)}
                    title="Свои вопросы по материалам всех уроков — не повторяющие урочные">
                    <Icon name="wand" /> Собрать ИИ
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

        <Inspector
          positionName={positionName}
          published={published} canPublish={canPublish}
          blocks={regular.length} lessons={allLessons.length}
          seconds={allLessons.reduce((s, l) => s + (l.study_seconds ?? 0), 0)}
          empty={emptyLessons.length}
          ai={!!ai?.enabled}
          lesson={selLesson} locations={locs?.items ?? []} here={currentLocation?.name ?? 'этой точки'}
          onPlan={() => setPlanning(true)}
          onPreview={() => setPreview(true)}
          onPublish={publish} onUnpublish={unpublish}
          onLessonAi={() => setLessonAi(true)}
          onChange={refresh}
        />
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- дерево */

function Blocks({
  blocks, at, ai, sel, busy, onSelect, onChange, onOrderBlocks, onOrderLessons, onFillBlock, onAddLesson,
}: {
  blocks: any[]; at: string; ai: boolean; sel: string | null; busy: boolean;
  onSelect: (id: string) => void; onChange: () => void;
  onOrderBlocks: (ids: string[]) => void;
  onOrderLessons: (blockId: string, ids: string[]) => void;
  onFillBlock: (b: any) => void;
  onAddLesson: (blockId: string, title: string) => void;
}) {
  const drag = useDragList((from, to) => onOrderBlocks(moved(blocks, from, to).map((b) => b.id)));

  return (
    <>
      {blocks.map((b, bi) => {
        const lessons: any[] = b.lessons ?? [];
        const sec = lessons.reduce((s, l) => s + (l.study_seconds ?? 0), 0);
        const gaps = lessons.filter((l) => !hasMaterial(l) || !hasTest(l)).length;
        const d = drag(bi);
        return (
          <div key={b.id} id={`blk-${b.id}`}
            className={`bcard${lessons.length ? '' : ' empty'} ${d.className}`}>
            <header draggable={d.draggable} onDragStart={d.onDragStart} onDragOver={d.onDragOver}
              onDragLeave={d.onDragLeave} onDrop={d.onDrop} onDragEnd={d.onDragEnd}>
              <span className="grip" title="Перетащите, чтобы переставить блок">
                <Icon name="grip" size={15} />
              </span>
              <EditableTitle value={b.title} heading
                onSave={(v) => patch(`/blocks/${b.id}`, { title: v }).then(onChange)} />
              {lessons.length ? (
                <span className="sum">
                  {lessons.length} {plural(lessons.length, 'урок', 'урока', 'уроков')}
                  {sec ? ` · ≈ ${dur(sec)}` : ''}
                </span>
              ) : <span className="tag no">нет уроков</span>}
              {ai && gaps > 0 && (
                <button className="btn ghost sm" disabled={busy} onClick={() => onFillBlock(b)}
                  title="Собрать материал и тест во всех пустых уроках блока">
                  <Icon name="wand" /> Заполнить блок
                </button>
              )}
              <button className="btn icon danger" title="Удалить блок со всеми уроками"
                onClick={() => {
                  if (confirm('Удалить блок со всеми уроками?')) del(`/blocks/${b.id}`).then(onChange);
                }}>
                <Icon name="trash" />
              </button>
            </header>
            <div className="body">
              <Lessons
                lessons={lessons} at={at} sel={sel} onSelect={onSelect} onChange={onChange}
                onOrder={(ids) => onOrderLessons(b.id, ids)}
              />
              <InlineAdd placeholder="Название урока" label="+ урок"
                onAdd={(title) => onAddLesson(b.id, title)} />
            </div>
          </div>
        );
      })}
    </>
  );
}

function Lessons({ lessons, at, sel, onSelect, onChange, onOrder }: {
  lessons: any[]; at: string; sel: string | null;
  onSelect: (id: string) => void; onChange: () => void; onOrder: (ids: string[]) => void;
}) {
  const drag = useDragList((from, to) => onOrder(moved(lessons, from, to).map((l) => l.id)));

  return (
    <>
      {lessons.map((l, i) => (
        <LessonRow key={l.id} lesson={l} at={at} open={sel === l.id}
          onOpen={() => onSelect(l.id)} onChange={onChange}
          i={i} count={lessons.length} drag={drag(i)}
          onMove={(dir) => onOrder(reordered(lessons, i, dir).map((x: any) => x.id))} />
      ))}
    </>
  );
}

function LessonRow({ lesson, at, open, onOpen, onChange, i, count, onMove, drag }: {
  lesson: any; at: string; open: boolean; onOpen: () => void; onChange: () => void;
  i: number; count: number; onMove: (dir: -1 | 1) => void;
  drag: ReturnType<ReturnType<typeof useDragList>>;
}) {
  const hasMat = hasMaterial(lesson);
  const hasT = hasTest(lesson);
  const noScope = !lesson.everywhere && !lesson.locations?.length;
  const gap = !hasMat || !hasT || noScope;
  // У точечного урока материал и тест заводятся под выбранную точку,
  // у общего — на всю сеть; сервер не даст перепутать одно с другим.
  const slot = lesson.content_per_location ? at : undefined;

  return (
    <div className={`lrow${gap ? ' gap' : ''}${open ? ' open' : ''} ${drag.className}`}
      id={`les-${lesson.id}`}>
      <div className="lhead" draggable={drag.draggable} onDragStart={drag.onDragStart}
        onDragOver={drag.onDragOver} onDragLeave={drag.onDragLeave}
        onDrop={drag.onDrop} onDragEnd={drag.onDragEnd}>
        <span className="grip" title="Перетащите, чтобы переставить урок">
          <Icon name="grip" size={15} />
        </span>
        <button className="chev" onClick={onOpen} title={open ? 'Свернуть' : 'Раскрыть'}>
          <Icon name={open ? 'down' : 'right'} size={15} />
        </button>
        <b className="name" onClick={onOpen}>{lesson.title}</b>
        {lesson.study_seconds > 0 && <span className="dur">{dur(lesson.study_seconds)}</span>}
        {lesson.content_per_location && <span className="tag">своё на точке</span>}
        {!lesson.everywhere && (
          <span className={`tag ${noScope ? 'no' : ''}`}>
            {noScope ? 'точки не выбраны' : `только ${lesson.locations.length} точки`}
          </span>
        )}
        <span className={`tag ${hasMat ? 'ok' : 'no'}`}>материал {hasMat ? '✓' : '—'}</span>
        <span className={`tag ${hasT ? 'ok' : 'no'}`}>тест {hasT ? '✓' : '—'}</span>
        {/* Стрелки остаются рядом с ручкой: мышью удобно, но с клавиатуры
            перетащить нельзя, а порядок уроков не должен быть доступен
            только тем, кто работает мышью. */}
        <MoveBtns i={i} count={count} onMove={onMove} />
        <button className="btn icon danger" title="Удалить урок" onClick={() => {
          if (confirm('Удалить урок?')) del(`/lessons/${lesson.id}`).then(onChange);
        }}>
          <Icon name="trash" />
        </button>
      </div>

      {open && (
        <div className="lbody">
          {lesson.content_per_location && (
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
              Правите вариант выбранной точки. На других точках он свой.
            </p>
          )}
          <div className="section">
            <div className="shead"><Icon name="doc" size={14} /><b>Материал</b></div>
            <MaterialForm lessonId={lesson.id} material={lesson.material} locationId={slot}
              onSaved={onChange} />
          </div>
          <div className="section">
            <div className="shead"><Icon name="check" size={14} /><b>Тест</b></div>
            <TestEditor
              test={lesson.test}
              onCreate={(pass) => put(`/lessons/${lesson.id}/test`,
                { pass_mark_pct: pass, ...(slot ? { location_id: slot } : {}) }).then(onChange)}
              onChange={onChange}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ инспектор */

/**
 * Панель свойств справа.
 *
 * Наверху всегда траектория — состояние и главные кнопки; они не должны
 * исчезать оттого, что человек ткнул в урок. Ниже — свойства выбранного урока:
 * раньше они жили внутри строки третьей кнопкой-вкладкой и распирали дерево
 * изнутри, а два переключателя с радиокнопками заставляли кадровика думать
 * за модель данных.
 */
function Inspector({
  positionName, published, canPublish, blocks, lessons, seconds, empty, ai,
  lesson, locations, here, onPlan, onPreview, onPublish, onUnpublish, onLessonAi, onChange,
}: {
  positionName: string; published: boolean; canPublish: boolean;
  blocks: number; lessons: number; seconds: number; empty: number; ai: boolean;
  lesson: any | null; locations: Loc[]; here: string;
  onPlan: () => void; onPreview: () => void; onPublish: () => void; onUnpublish: () => void;
  onLessonAi: () => void; onChange: () => void;
}) {
  return (
    <aside className="inspector">
      <div className="panel">
        <div className="row-between" style={{ marginBottom: 8 }}>
          <b>{positionName}</b>
          <span className={`pill ${published ? 'passed' : 'locked'}`}>
            {published ? 'Опубликована' : 'Черновик'}
          </span>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          {blocks} {plural(blocks, 'блок', 'блока', 'блоков')} · {lessons}{' '}
          {plural(lessons, 'урок', 'урока', 'уроков')}
          {seconds > 0 && <> · ≈ {dur(seconds)} обучения</>}
          <br />
          {published ? 'По ней открывается онбординг' : 'Новички ждут публикации'}
        </p>

        <div className="stack" style={{ gap: 8 }}>
          {ai && (
            <button className="btn ghost block" onClick={onPlan}
              title="Загрузить документы и пересобрать траекторию">
              <Icon name="wand" /> Собрать из документов
            </button>
          )}
          <button className="btn ghost block" onClick={onPreview}>
            <Icon name="eye" /> Предпросмотр
          </button>
          {published
            ? <button className="btn ghost block" onClick={onUnpublish}>Снять с публикации</button>
            : (
              /* Залита та кнопка, которая сейчас главная. Пока в траектории
                 есть пустые уроки, главное — заполнить их, а не публиковать. */
              <button className={`btn block${empty > 0 ? ' ghost' : ''}`}
                onClick={onPublish} disabled={!canPublish}
                title={canPublish ? 'Открыть онбординг по этой траектории'
                  : 'Сначала доделайте каркас — строка слева'}>
                Опубликовать
              </button>
            )}
        </div>
      </div>

      {lesson ? (
        <LessonProps lesson={lesson} locations={locations} here={here} ai={ai}
          onLessonAi={onLessonAi} onChange={onChange} />
      ) : (
        <p className="muted" style={{ fontSize: 12.5, padding: '0 4px' }}>
          Выберите урок — здесь появятся его настройки: на каких точках он есть
          и чьё у него содержимое.
        </p>
      )}
    </aside>
  );
}

/**
 * Где урок есть и чьё у него содержимое — два независимых решения.
 *
 * Разводить их важно: «Стандарты сервиса» одинаковы во всей сети, «План зала»
 * есть везде, но у каждой точки свой, а «Боулинг» существует не везде. Смешивать
 * это в один переключатель значит заставлять HR думать за модель данных.
 */
function LessonProps({ lesson, locations, here, ai, onLessonAi, onChange }: {
  lesson: any; locations: Loc[]; here: string; ai: boolean;
  onLessonAi: () => void; onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const chosen: string[] = lesson.locations ?? [];
  const everywhere = !!lesson.everywhere;

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    try { await patch(`/lessons/${lesson.id}`, body); onChange(); }
    finally { setBusy(false); }
  }

  function toggleLocation(id: string) {
    // Из «везде» щелчок по точке означает «только здесь» — это то, чего человек
    // и хочет, а не «убрать одну из всех».
    const next = everywhere
      ? [id]
      : chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    save({ everywhere: false, locations: next });
  }

  return (
    <div className="panel">
      <div className="row-between" style={{ marginBottom: 10 }}>
        <b style={{ fontSize: 14 }}>Урок</b>
        {lesson.study_seconds > 0 && (
          <span className="muted" style={{ fontSize: 12.5 }}>{dur(lesson.study_seconds)}</span>
        )}
      </div>

      <label className="field">
        <span>Название</span>
        <input key={lesson.id} defaultValue={lesson.title}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== lesson.title) patch(`/lessons/${lesson.id}`, { title: v }).then(onChange);
          }} />
      </label>

      <div className="field">
        <span>Где есть урок</span>
        <div className="chips">
          <button className={`chip${everywhere ? ' on' : ''}`} disabled={busy}
            onClick={() => save({ everywhere: true })}>Везде</button>
          {locations.map((l) => (
            <button key={l.id} disabled={busy}
              className={`chip${!everywhere && chosen.includes(l.id) ? ' on' : ''}`}
              onClick={() => toggleLocation(l.id)}>{l.name}</button>
          ))}
        </div>
        {!everywhere && chosen.length === 0 && (
          <span className="notice bad" style={{ fontSize: 12.5, marginTop: 8, marginBottom: 0 }}>
            <Icon name="alert" size={14} />
            <span>Урок не попадёт ни к кому — выберите хотя бы одну точку</span>
          </span>
        )}
      </div>

      <div className="field">
        <span>Содержимое</span>
        <div className="chips">
          <button className={`chip${!lesson.content_per_location ? ' on' : ''}`} disabled={busy}
            onClick={() => {
              if (lesson.content_per_location
                && !confirm('Материалы и тесты, заведённые по точкам, будут удалены. Продолжить?')) return;
              save({ content_per_location: false });
            }}>Одинаковое везде</button>
          <button className={`chip${lesson.content_per_location ? ' on' : ''}`} disabled={busy}
            onClick={() => {
              if (!lesson.content_per_location
                && !confirm('Общий материал и тест будут удалены — их нужно будет завести на каждой точке. Продолжить?')) return;
              save({ content_per_location: true });
            }}>Своё на каждой точке</button>
        </div>
        {lesson.content_per_location && (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            Правите вариант точки «{here}».
          </p>
        )}
      </div>

      {lesson.test && (
        <div className="field" style={{ marginBottom: ai ? 14 : 0 }}>
          <span>Тест</span>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {lesson.test.questions.length}{' '}
            {plural(lesson.test.questions.length, 'вопрос', 'вопроса', 'вопросов')} ·
            проходной балл {lesson.test.pass_mark_pct}%
          </p>
        </div>
      )}

      {ai && (
        <button className="btn ghost block" onClick={onLessonAi}
          title="Собрать материал и тест этого урока из текста">
          <Icon name="wand" /> Собрать этот урок
        </button>
      )}
    </div>
  );
}

/**
 * ДОКУМЕНТ ДЛЯ БЛОКА.
 *
 * Когда траекторию собирали из документов, сервер запомнил, какой кусок
 * регламента относится к какому уроку, и «Заполнить блок» работает молча.
 * Уроки, заведённые руками, такого куска не имеют — и раньше человек получал
 * отказ: «соберите их по одному». Для семи уроков это не ответ.
 *
 * Поэтому спрашиваем один документ на всё, чего не хватило. Модель получает
 * его целиком и название каждого урока отдельно — ровно так же, как при сборке
 * одного урока, где текст тоже приносит человек.
 */
function BlockDocDialog({ lessons, onClose, onText }: {
  lessons: any[]; onClose: () => void; onText: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement | null>(null);

  async function read(files: FileList) {
    setBusy(true); setErr(null);
    try {
      for (const file of Array.from(files)) {
        const r = await extractDocument(file);
        setText((prev) => (prev.trim() ? `${prev.trim()}\n\n${r.text}` : r.text));
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось прочитать документ');
    } finally {
      setBusy(false);
      if (pick.current) pick.current.value = '';
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: 6 }}>Из чего собирать?</h3>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          {lessons.length} {plural(lessons.length, 'урок заведён', 'урока заведены', 'уроков заведены')}{' '}
          вручную, и куска регламента у {lessons.length === 1 ? 'него' : 'них'} нет.
          Принесите документ — материал и тест соберутся по нему, каждому уроку
          своё по его названию.
        </p>

        <div className="hint" style={{ marginBottom: 12, fontSize: 12.5 }}>
          {lessons.slice(0, 6).map((l) => l.title).join(' · ')}
          {lessons.length > 6 && ` и ещё ${lessons.length - 6}`}
        </div>

        <input ref={pick} type="file" multiple accept={DOC_ACCEPT} hidden
          onChange={(e) => { const f = e.target.files; if (f?.length) read(f); }} />
        <button className="btn ghost sm" disabled={busy} onClick={() => pick.current?.click()}>
          <Icon name="upload" /> {busy ? 'Читаем…' : 'Загрузить документ'}
        </button>

        <textarea value={text} rows={7} placeholder="…или вставьте текст"
          onChange={(e) => setText(e.target.value)}
          style={{ width: '100%', marginTop: 10, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }} />
        <span className="muted" style={{ fontSize: 11 }}>{text.trim().length} символов</span>

        {err && <p style={{ color: 'var(--error)', fontSize: 13, marginTop: 8 }}>{err}</p>}

        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={onClose}>Не сейчас</button>
          <button className="btn sm" disabled={busy || text.trim().length < 200}
            onClick={() => onText(text.trim())}>
            Заполнить {lessons.length}{' '}
            {plural(lessons.length, 'урок', 'урока', 'уроков')}
          </button>
        </div>
        {text.trim().length > 0 && text.trim().length < 200 && (
          <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
            Текста маловато — из пары строк урока не выйдет.
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- мелочь */

const hasMaterial = (l: any) => !!(l.material && (l.material.text_body || l.material.file_url));
const hasTest = (l: any) => !!(l.test && l.test.questions.length > 0);
const typeLabel = (t: string) => (t === 'video' ? 'Видео' : t === 'pdf' ? 'PDF' : 'Текст');

/**
 * Сколько времени материал займёт у сотрудника.
 *
 * Это оценка, а не хронометраж: для текста она считается по числу слов, для
 * ролика — по его длительности. Там, где длительность неизвестна, сервер
 * присылает ноль, и мы не показываем ничего — придуманная минута хуже пустоты.
 */
function dur(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

/** «3 недоделки» против «3 недоделок» — мелочь, по которой видно, писал человек или нет. */
function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
