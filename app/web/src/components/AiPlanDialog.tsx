import { useRef, useState } from 'react';
import { ApiError, extractDocument, post } from '../api';
import { DOC_ACCEPT, useToast } from '../lib';

/**
 * ВСЯ ТРАЕКТОРИЯ ИЗ ДОКУМЕНТОВ.
 *
 * Порядок здесь обратный тому, что был раньше, и это главное. Раньше человек
 * заводил блок, потом искал, какой кусок регламента туда положить, потом
 * открывал каждый урок и собирал его отдельно — на пяти блоках по четыре
 * урока это двадцать заходов, и до конца доходили немногие.
 *
 * Теперь он приносит документы, а дерево строится само: блоки, уроки с
 * материалом и тестом, материалы знакомства с компанией и аттестация.
 *
 * Две зоны, а не одна куча: кадровик точно знает, что рассказ о сети — это
 * пре-онбординг, а регламент смены — обучение. Пусть скажет сам, чем гадать.
 *
 * Уроки собираются по одному и на глазах. Так человек видит, что происходит,
 * а не смотрит три минуты в пустой экран; оборвавшаяся связь стоит одного
 * урока; и если каркас вышел не тот, можно остановиться на втором уроке
 * и не платить за оставшиеся двадцать.
 *
 * В каталоге до нажатия «Создать» не меняется ничего (C-13).
 */

interface PlannedLesson { title: string; sections: number[] }
interface PlannedBlock { title: string; lessons: PlannedLesson[] }
interface Plan { blocks: PlannedBlock[] }
interface SectionInfo { index: number; title: string; chars: number }
interface Question { text: string; options: string[]; correct_index: number }
interface Draft { title: string; material: string; questions: Question[] }
interface PreItem { title: string; text: string }
interface Pre { items: PreItem[] }

type Phase = 'input' | 'filling' | 'ready';

export function AiPlanDialog({ positionId, positionName, hasContent, onClose, onApplied }: {
  positionId: string;
  positionName: string;
  /** В траектории уже есть блоки — значит, надо спросить: заменить или добавить. */
  hasContent?: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const toast = useToast();

  const [source, setSource] = useState('');
  const [preSource, setPreSource] = useState('');
  const [loaded, setLoaded] = useState<{ zone: 'train' | 'pre'; name: string }[]>([]);

  const [plan, setPlan] = useState<Plan | null>(null);
  const [pre, setPre] = useState<Pre | null>(null);
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [filled, setFilled] = useState<Record<string, Draft>>({});
  const [attestation, setAttestation] = useState<{ questions: Question[] } | null>(null);

  const [phase, setPhase] = useState<Phase>('input');
  const [busy, setBusy] = useState<'doc' | 'parse' | 'apply' | null>(null);
  const [doing, setDoing] = useState<string | null>(null);
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // Остановка — через ref: цикл заполнения читает её между уроками, а состояние
  // внутри уже запущенного цикла осталось бы прежним.
  const stop = useRef(false);
  const trainPick = useRef<HTMLInputElement | null>(null);
  const prePick = useRef<HTMLInputElement | null>(null);

  const lessonCount = plan?.blocks.reduce((n, b) => n + b.lessons.length, 0) ?? 0;
  const filledCount = Object.keys(filled).length;

  async function pickDocuments(files: FileList, zone: 'train' | 'pre') {
    setBusy('doc'); setErr(null);
    try {
      for (const file of Array.from(files)) {
        const r = await extractDocument(file);
        const add = (prev: string) => (prev.trim() ? `${prev.trim()}\n\n${r.text}` : r.text);
        if (zone === 'train') setSource(add); else setPreSource(add);
        setLoaded((l) => [...l, { zone, name: file.name }]);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось прочитать документ');
    } finally {
      setBusy(null);
      if (trainPick.current) trainPick.current.value = '';
      if (prePick.current) prePick.current.value = '';
    }
  }

  /** Первый шаг: каркас и материалы о компании. Быстрый и дешёвый. */
  async function parse() {
    setBusy('parse'); setErr(null);
    try {
      const r = await post<{ plan: Plan; pre: Pre | null; sections: SectionInfo[] }>(
        `/ai/trajectories/${positionId}/plan`,
        { source_text: source.trim() || undefined, pre_text: preSource.trim() || undefined },
      );
      setPlan(r.plan);
      setPre(r.pre);
      setSections(r.sections);
      setFilled({});
      setAttestation(null);
      setBusy(null);
      if (r.plan.blocks.length) await fillAll(r.plan);
      else setPhase('ready');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось разобрать документы');
      setBusy(null);
    }
  }

  /** Второй шаг: уроки по одному, на глазах, с возможностью остановиться. */
  async function fillAll(p: Plan) {
    stop.current = false;
    setPhase('filling');
    const got: Record<string, Draft> = {};

    for (let bi = 0; bi < p.blocks.length; bi++) {
      for (let li = 0; li < p.blocks[bi].lessons.length; li++) {
        if (stop.current) { setPhase('ready'); return; }
        setDoing(p.blocks[bi].lessons[li].title);
        try {
          const r = await post<{ draft: Draft }>(
            `/ai/trajectories/${positionId}/plan/fill`, { block: bi, lesson: li },
          );
          got[`${bi}:${li}`] = r.draft;
          setFilled({ ...got });
        } catch (e) {
          // Один урок не собрался — это не повод бросать остальные: он останется
          // пустым, и человек соберёт его отдельно.
          setErr(e instanceof ApiError
            ? `«${p.blocks[bi].lessons[li].title}»: ${e.message}`
            : 'Урок не собрался');
        }
      }
    }

    setDoing('Аттестация');
    if (Object.keys(got).length) {
      try {
        const r = await post<{ attestation: { questions: Question[] } }>(
          `/ai/trajectories/${positionId}/plan/attestation`, {},
        );
        setAttestation(r.attestation);
      } catch (e) {
        setErr(e instanceof ApiError ? `Аттестация: ${e.message}` : 'Аттестация не собралась');
      }
    }
    setDoing(null);
    setPhase('ready');
  }

  async function apply() {
    if (!plan) return;
    setBusy('apply'); setErr(null);
    try {
      const r = await post<{ blocks: number; lessons: number; filled: number; pre: number; attestation: number }>(
        `/ai/trajectories/${positionId}/plan/apply`,
        { plan, pre: pre ?? undefined, attestation: attestation ?? undefined, mode },
      );
      toast(`Создано: ${r.blocks} блоков, ${r.lessons} уроков, ${r.pre} материалов о компании`);
      onApplied();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать');
      setBusy(null);
    }
  }

  const edit = (fn: (p: Plan) => void) => {
    if (!plan) return;
    const copy: Plan = JSON.parse(JSON.stringify(plan));
    fn(copy);
    setPlan(copy);
  };
  const editPre = (fn: (p: Pre) => void) => {
    if (!pre) return;
    const copy: Pre = JSON.parse(JSON.stringify(pre));
    fn(copy);
    setPre(copy);
  };

  const zone = (which: 'train' | 'pre') => loaded.filter((f) => f.zone === which);

  return (
    <div className="modal-bg" onClick={phase === 'filling' ? undefined : onClose}>
      <div className="modal ai-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between" style={{ marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Собрать траекторию из документов</h3>
          <button className="btn ghost sm" disabled={phase === 'filling'} onClick={onClose}>Закрыть</button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Должность «{positionName}» · принесите документы — блоки, уроки, тесты
          и аттестацию система соберёт сама, а вы поправите. В каталог ничего
          не попадёт, пока вы не нажмёте «Создать»
        </p>

        {/* Пока разбирать нечего, правая колонка — это серая подсказка на
            полэкрана. Отдаём всю ширину полям: в них вставляют регламенты. */}
        <div className={plan || pre ? 'ai-grid' : undefined}>
          {/* ---------------- слева: документы ---------------- */}
          <div>
            <div className="panel" style={{ marginBottom: 10 }}>
              <b style={{ fontSize: 13.5 }}>Обучение</b>
              <p className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>
                Регламенты и инструкции: из них вырастут блоки, уроки и тесты
              </p>
              <input ref={trainPick} type="file" multiple accept={DOC_ACCEPT} hidden
                onChange={(e) => { const f = e.target.files; if (f?.length) pickDocuments(f, 'train'); }} />
              <button className="btn ghost sm" disabled={busy !== null || phase === 'filling'}
                onClick={() => trainPick.current?.click()}>
                {busy === 'doc' ? 'Читаем…' : '📄 Загрузить документы'}
              </button>
              {zone('train').map((f, i) => (
                <div key={i} className="muted" style={{ fontSize: 12, marginTop: 6 }}>✓ {f.name}</div>
              ))}
              <textarea
                value={source} rows={zone('train').length ? 4 : 7}
                placeholder="…или вставьте текст со всеми заголовками"
                onChange={(e) => setSource(e.target.value)}
                style={{ width: '100%', marginTop: 8, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }}
              />
              <span className="muted" style={{ fontSize: 11 }}>{source.trim().length} символов</span>
            </div>

            <div className="panel" style={{ marginBottom: 10 }}>
              <b style={{ fontSize: 13.5 }}>О компании</b>
              <p className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>
                Рассказ о сети: его читают дома, до первой смены. Тестов здесь нет
              </p>
              <input ref={prePick} type="file" multiple accept={DOC_ACCEPT} hidden
                onChange={(e) => { const f = e.target.files; if (f?.length) pickDocuments(f, 'pre'); }} />
              <button className="btn ghost sm" disabled={busy !== null || phase === 'filling'}
                onClick={() => prePick.current?.click()}>
                {busy === 'doc' ? 'Читаем…' : '📄 Загрузить документы'}
              </button>
              {zone('pre').map((f, i) => (
                <div key={i} className="muted" style={{ fontSize: 12, marginTop: 6 }}>✓ {f.name}</div>
              ))}
              <textarea
                value={preSource} rows={zone('pre').length ? 3 : 5}
                placeholder="…или вставьте текст"
                onChange={(e) => setPreSource(e.target.value)}
                style={{ width: '100%', marginTop: 8, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }}
              />
              <span className="muted" style={{ fontSize: 11 }}>{preSource.trim().length} символов</span>
            </div>

            <button className="btn" style={{ width: '100%' }}
              disabled={busy !== null || phase === 'filling'
                || (source.trim().length < 500 && preSource.trim().length < 300)}
              onClick={parse}>
              {busy === 'parse' ? 'Разбираем…' : plan ? 'Разобрать заново' : 'Разобрать'}
            </button>

            {source.trim().length > 0 && source.trim().length < 500 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Для целой траектории нужен документ побольше. Из короткой памятки
                выйдет один урок — соберите его кнопкой в самом уроке.
              </p>
            )}
            {sections.length > 0 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Разделов в документах: {sections.length}
              </p>
            )}
          </div>

          {/* ---------------- справа: что получилось ---------------- */}
          <div>
            {phase === 'filling' && (
              <div className="panel" style={{ marginBottom: 10 }}>
                <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13.5 }}>
                    Собираем: {doing} — {filledCount} из {lessonCount}
                  </b>
                  <button className="btn ghost sm" onClick={() => { stop.current = true; }}>
                    Остановить
                  </button>
                </div>
                <div style={{
                  height: 4, background: 'var(--line, #ddd)', borderRadius: 2, marginTop: 8,
                }}>
                  <div style={{
                    height: 4, borderRadius: 2, background: 'var(--accent, #555)',
                    width: `${lessonCount ? Math.round((filledCount / lessonCount) * 100) : 0}%`,
                    transition: 'width .3s',
                  }} />
                </div>
                <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                  Можно остановить в любой момент — собранное останется,
                  остальные уроки создадутся пустыми.
                </p>
              </div>
            )}

            {pre && pre.items.length > 0 && (
              <div className="panel" style={{ marginBottom: 10 }}>
                <b style={{ fontSize: 13.5 }}>О компании · {pre.items.length}</b>
                {pre.items.map((it, i) => (
                  <div key={i} style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input value={it.title} style={{ flex: 1, fontSize: 13.5 }}
                        onChange={(e) => editPre((p) => { p.items[i].title = e.target.value; })} />
                      <button className="btn ghost sm" title="Убрать материал"
                        onClick={() => editPre((p) => { p.items.splice(i, 1); })}>✕</button>
                    </div>
                    <textarea value={it.text} rows={3}
                      onChange={(e) => editPre((p) => { p.items[i].text = e.target.value; })}
                      style={{ width: '100%', marginTop: 4, fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.5 }} />
                  </div>
                ))}
              </div>
            )}

            {plan && plan.blocks.length > 0 && (
              <>
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <b>{plan.blocks.length} блоков · {lessonCount} уроков</b>
                  <span className="muted" style={{ fontSize: 12 }}>
                    собрано {filledCount} из {lessonCount}
                  </span>
                </div>

                {plan.blocks.map((b, bi) => (
                  <div key={bi} className="panel" style={{ marginBottom: 10 }}>
                    <div className="row-between" style={{ gap: 8, marginBottom: 8 }}>
                      <input
                        value={b.title}
                        onChange={(e) => edit((p) => { p.blocks[bi].title = e.target.value; })}
                        style={{ fontWeight: 600, flex: 1 }}
                      />
                      <button className="btn ghost sm" title="Убрать блок целиком"
                        disabled={phase === 'filling'}
                        onClick={() => edit((p) => { p.blocks.splice(bi, 1); })}>✕</button>
                    </div>

                    {b.lessons.map((l, li) => {
                      const key = `${bi}:${li}`;
                      const d = filled[key];
                      return (
                        <div key={li} style={{ marginBottom: 6 }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              value={d?.title ?? l.title}
                              onChange={(e) => edit((p) => { p.blocks[bi].lessons[li].title = e.target.value; })}
                              style={{ flex: 1, fontSize: 13.5 }}
                            />
                            <button className="btn ghost sm" style={{ whiteSpace: 'nowrap' }}
                              title={d ? 'Посмотреть, что собралось' : 'Урок ещё не собран'}
                              disabled={!d}
                              onClick={() => setOpen(open === key ? null : key)}>
                              {d ? `✓ ${d.questions.length} вопр.` : '○ пусто'}
                            </button>
                            <button className="btn ghost sm" title="Убрать урок"
                              disabled={phase === 'filling'}
                              onClick={() => edit((p) => {
                                p.blocks[bi].lessons.splice(li, 1);
                                if (p.blocks[bi].lessons.length === 0) p.blocks.splice(bi, 1);
                              })}>✕</button>
                          </div>
                          {open === key && d && (
                            <div className="panel" style={{ marginTop: 6, fontSize: 12.5 }}>
                              <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{d.material}</p>
                              <ol style={{ paddingLeft: 18, marginBottom: 0 }}>
                                {d.questions.map((q, qi) => (
                                  <li key={qi} style={{ marginBottom: 4 }}>
                                    {q.text}
                                    <div className="muted">
                                      Верный ответ: {q.options[q.correct_index]}
                                    </div>
                                  </li>
                                ))}
                              </ol>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </>
            )}

            {attestation && (
              <div className="panel" style={{ marginBottom: 10 }}>
                <div className="row-between">
                  <b style={{ fontSize: 13.5 }}>Аттестация · {attestation.questions.length} вопросов</b>
                  <button className="btn ghost sm"
                    onClick={() => setOpen(open === 'att' ? null : 'att')}>
                    {open === 'att' ? 'Свернуть' : 'Посмотреть'}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
                  Свои вопросы по материалам уроков — они не повторяют урочные
                </p>
                {open === 'att' && (
                  <ol style={{ paddingLeft: 18, fontSize: 12.5, marginBottom: 0, marginTop: 8 }}>
                    {attestation.questions.map((q, qi) => (
                      <li key={qi} style={{ marginBottom: 4 }}>
                        {q.text}
                        <div className="muted">Верный ответ: {q.options[q.correct_index]}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}

            {phase === 'ready' && (plan?.blocks.length || pre?.items.length) && (
              <div className="panel">
                {hasContent && (
                  <label className="field" style={{ marginBottom: 10 }}>
                    <span>В траектории уже есть блоки</span>
                    <select value={mode} onChange={(e) => setMode(e.target.value as 'append' | 'replace')}>
                      <option value="append">Добавить к тому, что есть</option>
                      <option value="replace">Заменить всё прежнее</option>
                    </select>
                  </label>
                )}
                {hasContent && mode === 'replace' && (
                  <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
                    Прежние блоки и уроки будут удалены. Те, кто уже учится,
                    этого не заметят: их обучение заморожено снимком.
                  </p>
                )}
                <button className="btn" style={{ width: '100%' }}
                  disabled={busy !== null} onClick={apply}>
                  {busy === 'apply' ? 'Создаём…' : 'Создать в каталоге'}
                </button>
                {filledCount < lessonCount && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                    {lessonCount - filledCount} уроков создадутся пустыми — нужный
                    кусок регламента у каждого уже подставлен, откройте и нажмите
                    «Собрать ИИ».
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {err && (
          <p style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{err}</p>
        )}
      </div>
    </div>
  );
}
