import { useEffect, useRef, useState } from 'react';
import { del, extractDocument, get, post, ApiError } from '../api';
import { DOC_ACCEPT, useToast } from '../lib';

interface Question { text: string; options: string[]; correct_index: number }
interface Draft { title: string; material: string; questions: Question[] }

/**
 * СБОРКА УРОКА ИЗ РЕГЛАМЕНТА.
 *
 * Слева — то, что HR принёс, справа — что предложила модель. Правая часть
 * редактируется целиком: заголовок, текст, любой вопрос и любой вариант.
 *
 * Пока не нажата «Применить», в каталоге ничего не меняется. Это не осторожность
 * ради осторожности: по короткому или неоднозначному регламенту модель напишет
 * уверенный и неверный тест, и заметит это только человек, знающий смену.
 */
export function AiLessonDialog({
  lessonId, lessonTitle, locationId, locationName, readsPdf, onClose, onApplied,
}: {
  lessonId: string;
  lessonTitle: string;
  /** Провайдер читает PDF сам — тогда и .pdf можно загрузить как есть. */
  readsPdf?: boolean;
  /** Пусто — урок общий на сеть. Иначе правим вариант этой точки. */
  locationId?: string;
  locationName?: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const toast = useToast();
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(null);
  const [busy, setBusy] = useState<'build' | 'apply' | 'doc' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const filePick = useRef<HTMLInputElement | null>(null);

  const q = locationId ? `?location=${encodeURIComponent(locationId)}` : '';

  // Черновик мог остаться с прошлого раза — платить за него второй раз незачем.
  useEffect(() => {
    let live = true;
    get<{ draft: Draft; source_text: string; provider: string; model: string }>(
      `/ai/lessons/${lessonId}/draft${q}`,
    ).then((r) => {
      if (!live) return;
      setDraft(r.draft);
      setSource(r.source_text);
      setMeta({ provider: r.provider, model: r.model });
    }).catch(() => {
      // Черновика нет — обычное дело. Но если урок вырос из плана по документу,
      // его кусок регламента уже сохранён: подставим, чтобы кадровик не искал
      // нужный абзац в сорока страницах заново.
      if (!live) return;
      get<{ source_text: string }>(`/ai/lessons/${lessonId}/source`)
        .then((r) => { if (live) setSource(r.source_text); })
        .catch(() => { /* урок заводили руками — поле остаётся пустым */ });
    });
    return () => { live = false; };
  }, [lessonId, q]);

  async function build() {
    setBusy('build'); setErr(null);
    try {
      const r = await post<{ draft: Draft; provider: string; model: string }>(
        `/ai/lessons/${lessonId}/draft`,
        { source_text: source, ...(locationId ? { location_id: locationId } : {}) },
      );
      setDraft(r.draft);
      setMeta({ provider: r.provider, model: r.model });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось собрать урок');
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!draft) return;
    setBusy('apply'); setErr(null);
    try {
      await post(`/ai/lessons/${lessonId}/apply`, {
        draft, ...(locationId ? { location_id: locationId } : {}),
      });
      toast(`Урок собран: вопросов ${draft.questions.length}`);
      onApplied();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось применить');
      setBusy(null);
    }
  }

  async function discard() {
    if (!confirm('Удалить черновик? Исходник тоже сотрётся.')) return;
    await del(`/ai/lessons/${lessonId}/draft${q}`).catch(() => {});
    setDraft(null); setSource(''); setMeta(null);
  }

  function editQuestion(i: number, patch: Partial<Question>) {
    if (!draft) return;
    const questions = draft.questions.map((x, k) => (k === i ? { ...x, ...patch } : x));
    setDraft({ ...draft, questions });
  }

  /**
   * Документ добавляется к тому, что уже набрано, а не затирает его: HR может
   * собрать урок из двух памяток или дописать своё к выгруженному тексту.
   */
  async function pickDocument(file: File) {
    setBusy('doc'); setErr(null);
    try {
      const r = await extractDocument(file);
      setSource((prev) => (prev.trim() ? `${prev.trim()}

${r.text}` : r.text));
      toast(`Прочитано ${r.chars} символов`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось прочитать документ');
    } finally {
      setBusy(null);
      // Сбрасываем выбор: иначе тот же файл вторым разом не выберется.
      if (filePick.current) filePick.current.value = '';
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal ai-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between" style={{ marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Собрать урок из регламента</h3>
          <button className="btn ghost sm" onClick={onClose}>Закрыть</button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Урок «{lessonTitle}»
          {locationName ? <> · вариант точки <b>{locationName}</b></> : <> · общий на всю сеть</>}
          {meta && <> · собрал {meta.provider === 'anthropic' ? 'Claude' : 'Groq'}</>}
        </p>

        <div className="ai-grid">
          <div>
            <label className="field" style={{ marginBottom: 8 }}>
              <span>Регламент, инструкция, памятка</span>
              <textarea
                value={source} rows={16} placeholder="Вставьте текст как есть — заголовки, пункты, всё подряд"
                onChange={(e) => setSource(e.target.value)}
                style={{ width: '100%', fontFamily: 'inherit', fontSize: 13.5, lineHeight: 1.5 }}
              />
            </label>
            <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="muted" style={{ fontSize: 12 }}>{source.trim().length} символов</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input ref={filePick} type="file" accept={DOC_ACCEPT(readsPdf)} hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) pickDocument(f); }} />
                <button className="btn ghost sm" disabled={busy !== null}
                  onClick={() => filePick.current?.click()}>
                  {busy === 'doc' ? 'Читаем…' : '📄 Загрузить документ'}
                </button>
                <button className="btn sm" disabled={busy !== null || source.trim().length < 200} onClick={build}>
                  {busy === 'build' ? 'Собираем…' : draft ? 'Собрать заново' : 'Собрать'}
                </button>
              </span>
            </div>
            {busy === null && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Можно не печатать: загрузите файл Word{readsPdf && ' или PDF'} —
                текст добавится сюда же.
              </p>
            )}
            {source.trim().length > 0 && source.trim().length < 200 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Нужно хотя бы 200 символов — из пары строк урока не выйдет.
              </p>
            )}
          </div>

          <div>
            {!draft && (
              <div className="panel muted" style={{ fontSize: 13.5 }}>
                Здесь появится черновик: текст урока и тест к нему. Всё можно будет
                поправить до того, как он попадёт в каталог.
              </div>
            )}

            {draft && (
              <>
                <label className="field" style={{ marginBottom: 10 }}>
                  <span>Название урока</span>
                  <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </label>
                <label className="field" style={{ marginBottom: 14 }}>
                  <span>Материал</span>
                  <textarea
                    value={draft.material} rows={10}
                    onChange={(e) => setDraft({ ...draft, material: e.target.value })}
                    style={{ width: '100%', fontFamily: 'inherit', fontSize: 13.5, lineHeight: 1.55 }}
                  />
                </label>

                <div className="muted" style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
                  Тест · {draft.questions.length}
                </div>
                {draft.questions.map((qn, i) => (
                  <div key={i} className="panel" style={{ marginBottom: 10, padding: 12 }}>
                    <div className="row-between" style={{ gap: 8, marginBottom: 8 }}>
                      <textarea
                        value={qn.text} rows={2}
                        onChange={(e) => editQuestion(i, { text: e.target.value })}
                        style={{ flex: 1, fontFamily: 'inherit', fontSize: 13.5 }}
                      />
                      <button
                        className="btn danger sm"
                        title="Удалить вопрос"
                        onClick={() => setDraft({ ...draft, questions: draft.questions.filter((_, k) => k !== i) })}
                      >✕</button>
                    </div>
                    {qn.options.map((opt, oi) => (
                      <label key={oi} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 5 }}>
                        <input
                          type="radio" checked={qn.correct_index === oi}
                          onChange={() => editQuestion(i, { correct_index: oi })}
                        />
                        <input
                          value={opt}
                          onChange={(e) => editQuestion(i, {
                            options: qn.options.map((o, k) => (k === oi ? e.target.value : o)),
                          })}
                          style={{ flex: 1, fontSize: 13.5 }}
                        />
                      </label>
                    ))}
                    <span className="muted" style={{ fontSize: 12 }}>Точка слева отмечает верный вариант</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {err && <div className="banner warn" style={{ marginTop: 12 }}>{err}</div>}

        {draft && (
          <div className="row" style={{ marginTop: 14, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>
              Пока не нажали «Применить», в каталоге ничего не изменилось.
            </span>
            <button className="btn ghost sm" onClick={discard}>Удалить черновик</button>
            <button className="btn sm" disabled={busy !== null} onClick={apply}>
              {busy === 'apply' ? 'Применяем…' : 'Применить к уроку'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
