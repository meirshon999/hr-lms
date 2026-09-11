import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post, put, ApiError } from '../../api';
import { useAsync, useBump, Loader, ErrorBox, useToast } from '../../lib';
import { InlineAdd, EditableTitle, MoveBtns, reordered } from '../../components/inline';
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
  const { bump, n } = useBump();
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
          <div className="pos-list">
            {pl.items.map((p) => (
              <a key={p.id} href={`#/hr/constructor/${p.id}`} className={p.id === positionId ? 'active' : ''}>
                {p.name}
                <div className="st" style={{ color: p.trajectory_status === 'active' ? 'var(--success)' : 'var(--muted)' }}>
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

/** Пробел в дереве: где он и какую вкладку открыть, чтобы его закрыть. */
interface Gap { nodeId: string; lessonId?: string; tab?: LessonTab; }
type LessonTab = 'material' | 'test' | 'scope';
/** Куда перевели человека кнопкой «Показать» — урок и вкладка в нём. */
type Focus = { lessonId: string; tab: LessonTab; at: number } | null;

function TrajectoryEditor({ positionId, positionName, onChange }: {
  positionId: string; positionName: string; onChange: () => void;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [attAi, setAttAi] = useState(false);
  const [focus, setFocus] = useState<Focus>(null);
  // Человек нажал «собрать вручную» — показываем пустое дерево вместо приглашения.
  const [manual, setManual] = useState(false);
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
   * Гасить кнопку по ним значило бы запереть кадровика, у которого готовы
   * две точки из трёх, — сервер бы такую публикацию принял.
   */
  const currentLocation = data.locations?.find((l) => l.location_id === at);
  const hereProblems = currentLocation?.problems ?? [];
  const canPublish = data.problems.length === 0;

  const att = data.blocks.find((b) => b.kind === 'attestation');
  const regular = data.blocks.filter((b) => b.kind === 'regular');
  const published = data.status === 'active';
  // Должность, в которой ещё ничего нет: встречаем приглашением, а не списком
  // недоделок. Человек не сделал ничего плохого — он просто начал.
  const blank = regular.length === 0 && data.pre_onboarding.length === 0 && !manual;

  /*
   * Где именно пробел. Сервер присылает недоделки строками — для каркаса
   * это правильно (там бывает «нет блока аттестации», которому не соответствует
   * ни один узел). А вот незаполненное содержимое всегда лежит в конкретном
   * уроке, и его мы находим по тому же признаку, по которому рисуем метки
   * «материал ✓ / тест —»: одни данные, одно правило, расхождению взяться неоткуда.
   */
  const gaps: Gap[] = [];
  for (const b of regular) {
    if (!b.lessons?.length) { gaps.push({ nodeId: `blk-${b.id}` }); continue; }
    for (const l of b.lessons) {
      if (!l.everywhere && !l.locations?.length) gaps.push({ nodeId: `les-${l.id}`, lessonId: l.id, tab: 'scope' });
      if (!hasMaterial(l)) gaps.push({ nodeId: `les-${l.id}`, lessonId: l.id, tab: 'material' });
      if (!hasTest(l)) gaps.push({ nodeId: `les-${l.id}`, lessonId: l.id, tab: 'test' });
    }
  }
  if (att && !att.test?.questions?.length) gaps.push({ nodeId: 'att' });

  /** Перевести человека к первому пробелу: прокрутить, раскрыть, подсветить. */
  function showFirstGap() {
    const g = gaps[0];
    if (!g) return;
    if (g.lessonId && g.tab) setFocus({ lessonId: g.lessonId, tab: g.tab, at: Date.now() });
    // Вкладка раскрывается этим же кадром, поэтому прокрутку откладываем:
    // иначе целимся в узел прежней высоты и промахиваемся.
    setTimeout(() => {
      const el = document.getElementById(g.nodeId);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1400);
    }, 60);
  }

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
      <div className="page-head">
        <div>
          <span className={`pill ${published ? 'passed' : 'locked'}`}>
            {published ? 'Опубликована' : 'Черновик'}
          </span>
          <span className="muted" style={{ fontSize: 13, marginLeft: 10 }}>
            {published ? 'по ней открывается онбординг' : 'новички ждут публикации'}
          </span>
        </div>
        {/*
          Залита одна кнопка — та, которая сейчас главная. На пустой должности
          это сборка из документов: именно так траекторию и собирают (правило 3).
          Как только каркас есть, акцент переходит на публикацию.
        */}
        <div className="acts">
          {ai?.enabled && (
            <button className={`btn sm${blank ? '' : ' ghost'}`} onClick={() => setPlanning(true)}
              title="Загрузить документы и получить готовую траекторию целиком">
              <Icon name="wand" /> Собрать из документов
            </button>
          )}
          <button className="btn ghost sm" onClick={() => setPreview(true)}>
            <Icon name="eye" /> Предпросмотр
          </button>
          {published
            ? <button className="btn ghost sm" onClick={unpublish}>Снять с публикации</button>
            : (
              <button className={`btn sm${blank ? ' ghost' : ''}`} onClick={publish} disabled={!canPublish}
                title={canPublish ? 'Открыть онбординг по этой траектории'
                  : 'Сначала доделайте каркас — строка ниже'}>
                Опубликовать
              </button>
            )}
        </div>
      </div>

      {planning && (
        <AiPlanDialog
          positionId={positionId}
          positionName={positionName}
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

      {blank ? (
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
      ) : (
        <>
          {/* Точка, глазами которой смотрим, и её готовность. Траектория публикуется
              по каркасу, а онбординг открывается только на готовых точках. */}
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

          {/* Каркас — то, на чём откажет сервер. Пишем отдельно и первым: эти
              недоделки общие на сеть, и части из них не соответствует узел дерева. */}
          {data.problems.length > 0 && (
            <details className="notice bad">
              <summary>
                <Icon name="alert" />
                <b className="grow">
                  Каркас не готов: {data.problems.length} {plural(data.problems.length, 'недоделка', 'недоделки', 'недоделок')}
                </b>
                <span style={{ fontSize: 12.5, opacity: .8 }}>показать</span>
              </summary>
              <ul>
                {data.problems.slice(0, 12).map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </details>
          )}

          {/* Содержимое точки. Публикацию не держит — держит онбординг на ней,
              и сказать надо именно это, а не «нельзя опубликовать». */}
          {hereProblems.length > 0 && (
            <div className="notice warn">
              <Icon name="clock" />
              <span className="grow">
                <b>«{currentLocation?.name}»</b> — новички этой точки будут ждать:
                не заполнено {hereProblems.length} {plural(hereProblems.length, 'место', 'места', 'мест')}.
                На готовых точках онбординг откроется сразу.
              </span>
              {gaps.length > 0 && (
                <button className="btn ghost sm" onClick={showFirstGap}>Показать первое</button>
              )}
            </div>
          )}

          {/* pre-onboarding */}
          <div className="builder-block">
            <header><h4>Пре-онбординг — материалы о компании</h4></header>
            <div className="body">
              {data.pre_onboarding.map((it, i) => (
                <div key={it.id} className="b-lesson">
                  <div className="lh">
                    <MoveBtns i={i} count={data.pre_onboarding.length} onMove={(d) => movePre(i, d)} />
                    <span className="tag">{typeLabel(it.content_type)}</span>
                    <EditableTitle value={it.title} onSave={(v) => patch(`/pre-onboarding/${it.id}`, { title: v }).then(refresh)} />
                    <button className="btn icon danger" title="Удалить материал"
                      onClick={() => del(`/pre-onboarding/${it.id}`).then(refresh)}><Icon name="trash" /></button>
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
                    file_url: null,   // файл выбирается отдельно, ссылок-заглушек больше нет
                  });
                  refresh();
                }} />
            </div>
          </div>

          {/* regular blocks */}
          {regular.map((b, bi) => (
            <div key={b.id} id={`blk-${b.id}`}
              className={`builder-block${b.lessons?.length ? '' : ' empty'}`}>
              <header>
                <MoveBtns i={bi} count={regular.length} onMove={(d) => moveBlock(bi, d)} />
                <EditableTitle value={b.title} heading onSave={(v) => patch(`/blocks/${b.id}`, { title: v }).then(refresh)} />
                {!b.lessons?.length && <span className="tag no">нет уроков</span>}
                <button className="btn icon danger" title="Удалить блок со всеми уроками"
                  onClick={() => {
                    if (confirm('Удалить блок со всеми уроками?')) del(`/blocks/${b.id}`).then(refresh);
                  }}><Icon name="trash" /></button>
              </header>
              <div className="body">
                {b.lessons.map((l: any, li: number) => (
                  <LessonEditor key={l.id} lesson={l} onChange={refresh} at={at} locations={locs?.items ?? []}
                    ai={!!ai?.enabled} focus={focus}
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
            <div className="builder-block" id="att" style={{ marginTop: 18 }}>
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
        </>
      )}
    </div>
  );
}

const hasMaterial = (l: any) => !!(l.material && (l.material.text_body || l.material.file_url));
const hasTest = (l: any) => !!(l.test && l.test.questions.length > 0);

/** «3 недоделки» против «3 недоделок» — мелочь, по которой видно, писал человек или нет. */
function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function LessonEditor({ lesson, onChange, i, count, onMove, at, locations, ai, focus }: {
  lesson: any; onChange: () => void; i: number; count: number; onMove: (dir: -1 | 1) => void;
  at: string; locations: Loc[]; ai: boolean; focus: Focus;
}) {
  const [tab, setTab] = useState<LessonTab | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const hasMat = hasMaterial(lesson);
  const hasT = hasTest(lesson);
  const noScope = !lesson.everywhere && !lesson.locations?.length;
  // У точечного урока материал и тест заводятся под выбранную точку,
  // у общего — на всю сеть; сервер не даст перепутать одно с другим.
  const slot = lesson.content_per_location ? at : undefined;
  const here = locations.find((l) => l.id === at)?.name ?? 'этой точки';

  // Кнопка «Показать первое» переводит человека к пробелу — значит, нужная
  // вкладка должна раскрыться сама, иначе он окажется у закрытого урока.
  useEffect(() => {
    if (focus && focus.lessonId === lesson.id) setTab(focus.tab);
  }, [focus, lesson.id]);

  return (
    <div className={`b-lesson${hasMat && hasT && !noScope ? '' : ' gap'}`} id={`les-${lesson.id}`}>
      <div className="lh">
        <MoveBtns i={i} count={count} onMove={onMove} />
        <EditableTitle value={lesson.title} onSave={(v) => patch(`/lessons/${lesson.id}`, { title: v }).then(onChange)} />
        {lesson.content_per_location && <span className="tag">своё на точке</span>}
        {!lesson.everywhere && (
          <span className={`tag ${noScope ? 'no' : ''}`}>
            {noScope ? 'точки не выбраны' : `только ${lesson.locations.length} точки`}
          </span>
        )}
        <span className={`tag ${hasMat ? 'ok' : 'no'}`}>материал {hasMat ? '✓' : '—'}</span>
        <span className={`tag ${hasT ? 'ok' : 'no'}`}>тест {hasT ? '✓' : '—'}</span>
        <button className="btn icon danger" title="Удалить урок" onClick={() => {
          if (confirm('Удалить урок?')) del(`/lessons/${lesson.id}`).then(onChange);
        }}><Icon name="trash" /></button>
      </div>
      <div className="acts">
        <button className={`btn ghost sm${tab === 'material' ? ' on' : ''}`}
          onClick={() => setTab(tab === 'material' ? null : 'material')}>Материал</button>
        <button className={`btn ghost sm${tab === 'test' ? ' on' : ''}`}
          onClick={() => setTab(tab === 'test' ? null : 'test')}>Тест</button>
        <button className={`btn ghost sm${tab === 'scope' ? ' on' : ''}`}
          onClick={() => setTab(tab === 'scope' ? null : 'scope')}>Где и чьё</button>
        {ai && (
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setAiOpen(true)}>
            <Icon name="wand" /> Собрать ИИ
          </button>
        )}
      </div>

      {aiOpen && (
        <AiLessonDialog
          lessonId={lesson.id}
          lessonTitle={lesson.title}
          locationId={slot}
          locationName={slot ? here : undefined}
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
    <div className="pane" style={{ marginTop: 10 }}>
      <div className="field" style={{ marginBottom: 14 }}>
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
              <span className="notice bad" style={{ fontSize: 12.5, marginTop: 6, marginBottom: 0 }}>
                <Icon name="alert" size={14} />
                <span>Не выбрано ни одной точки — такой урок не попадёт ни к кому</span>
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
