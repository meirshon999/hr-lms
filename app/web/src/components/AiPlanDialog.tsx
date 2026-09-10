import { useRef, useState } from 'react';
import { ApiError, extractDocument, post } from '../api';
import { useToast } from '../lib';

/**
 * СБОРКА ТРАЕКТОРИИ ИЗ ЦЕЛОГО ДОКУМЕНТА.
 *
 * Кадровик приносит регламент — модель предлагает дерево: какие блоки, какие
 * уроки и из какого куска документа каждый урок вырастет.
 *
 * Дерево редактируется до того, как что-то попадёт в каталог: переименовать,
 * выбросить лишний урок, выбросить целый блок. Пока не нажата «Создать»,
 * в каталоге ничего не меняется — то же правило, что и для одного урока.
 *
 * Уроки создаются пустыми. Материал и тест собираются потом, по одному,
 * и каждый смотрит человек: за раз проверить сорок уроков нельзя, а значит
 * их никто и не проверит.
 */

interface PlannedLesson { title: string; sections: number[] }
interface PlannedBlock { title: string; lessons: PlannedLesson[] }
interface Plan { blocks: PlannedBlock[] }
interface SectionInfo { index: number; title: string; chars: number }

export function AiPlanDialog({ positionId, positionName, onClose, onApplied }: {
  positionId: string;
  positionName: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const toast = useToast();
  const [source, setSource] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [busy, setBusy] = useState<'doc' | 'plan' | 'apply' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const filePick = useRef<HTMLInputElement | null>(null);

  const lessonCount = plan?.blocks.reduce((n, b) => n + b.lessons.length, 0) ?? 0;

  async function pickDocument(file: File) {
    setBusy('doc'); setErr(null);
    try {
      const r = await extractDocument(file);
      setSource((prev) => (prev.trim() ? `${prev.trim()}\n\n${r.text}` : r.text));
      toast(`Прочитано ${r.chars} символов`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось прочитать документ');
    } finally {
      setBusy(null);
      if (filePick.current) filePick.current.value = '';
    }
  }

  async function build() {
    setBusy('plan'); setErr(null);
    try {
      const r = await post<{ plan: Plan; sections: SectionInfo[] }>(
        `/ai/trajectories/${positionId}/plan`, { source_text: source },
      );
      setPlan(r.plan);
      setSections(r.sections);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось разобрать документ');
    } finally { setBusy(null); }
  }

  async function apply() {
    if (!plan) return;
    setBusy('apply'); setErr(null);
    try {
      const r = await post<{ blocks: number; lessons: number }>(
        `/ai/trajectories/${positionId}/plan/apply`, { plan },
      );
      toast(`Создано: ${r.blocks} блоков, ${r.lessons} уроков`);
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

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal ai-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between" style={{ marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Собрать траекторию из документа</h3>
          <button className="btn ghost sm" onClick={onClose}>Закрыть</button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Должность «{positionName}» · модель предложит блоки и уроки, вы поправите
        </p>

        <div className="ai-grid">
          <div>
            <label className="field" style={{ marginBottom: 8 }}>
              <span>Регламент целиком</span>
              <textarea
                value={source} rows={16}
                placeholder="Загрузите файл Word или вставьте текст со всеми заголовками"
                onChange={(e) => setSource(e.target.value)}
                style={{ width: '100%', fontFamily: 'inherit', fontSize: 13.5, lineHeight: 1.5 }}
              />
            </label>
            <div className="row-between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="muted" style={{ fontSize: 12 }}>{source.trim().length} символов</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input ref={filePick} type="file" accept=".docx,.txt,.md" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) pickDocument(f); }} />
                <button className="btn ghost sm" disabled={busy !== null}
                  onClick={() => filePick.current?.click()}>
                  {busy === 'doc' ? 'Читаем…' : '📄 Загрузить документ'}
                </button>
                <button className="btn sm" disabled={busy !== null || source.trim().length < 500}
                  onClick={build}>
                  {busy === 'plan' ? 'Разбираем…' : plan ? 'Разобрать заново' : 'Разобрать'}
                </button>
              </span>
            </div>
            {source.trim().length > 0 && source.trim().length < 500 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Для целой траектории нужен документ побольше. Из короткой памятки
                выйдет один урок — соберите его кнопкой в самом уроке.
              </p>
            )}
            {sections.length > 0 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Разделов в документе: {sections.length}
              </p>
            )}
          </div>

          <div>
            {!plan && (
              <div className="panel muted" style={{ fontSize: 13.5 }}>
                Здесь появится предложенная структура: блоки и уроки в них.
                Всё можно поправить до того, как оно попадёт в каталог.
              </div>
            )}

            {plan && (
              <>
                <div className="row-between" style={{ marginBottom: 8 }}>
                  <b>{plan.blocks.length} блоков · {lessonCount} уроков</b>
                  <span className="muted" style={{ fontSize: 12 }}>уроки создадутся пустыми</span>
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
                        onClick={() => edit((p) => { p.blocks.splice(bi, 1); })}>✕</button>
                    </div>

                    {b.lessons.map((l, li) => (
                      <div key={li} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                        <input
                          value={l.title}
                          onChange={(e) => edit((p) => { p.blocks[bi].lessons[li].title = e.target.value; })}
                          style={{ flex: 1, fontSize: 13.5 }}
                        />
                        <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}
                          title={l.sections.map((i) => sections[i]?.title || `раздел ${i}`).join(', ')}>
                          {l.sections.length === 1 ? '1 раздел' : `${l.sections.length} разд.`}
                        </span>
                        <button className="btn ghost sm" title="Убрать урок"
                          onClick={() => edit((p) => {
                            p.blocks[bi].lessons.splice(li, 1);
                            if (p.blocks[bi].lessons.length === 0) p.blocks.splice(bi, 1);
                          })}>✕</button>
                      </div>
                    ))}
                  </div>
                ))}

                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn" disabled={busy !== null || plan.blocks.length === 0}
                    onClick={apply}>
                    {busy === 'apply' ? 'Создаём…' : 'Создать в каталоге'}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  После создания откройте любой урок и нажмите «Собрать ИИ» — нужный
                  кусок регламента уже будет подставлен в поле.
                </p>
              </>
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
