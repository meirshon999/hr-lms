import { useEffect, useState } from 'react';
import { ApiError, del, get, post } from '../api';
import { useToast } from '../lib';

/**
 * ФИНАЛЬНАЯ АТТЕСТАЦИЯ ОДНОЙ КНОПКОЙ.
 *
 * Собирается по материалам уроков — но вопросы **свои**, не те, что были
 * в уроках. Повторить их значило бы проверять память на уже виденные ответы:
 * человек прошёл эти тесты час назад.
 *
 * Как и везде, между моделью и каталогом стоит человек: пока не нажата
 * «Поставить в аттестацию», в каталоге ничего не меняется.
 */

interface Question { text: string; options: string[]; correct_index: number }
interface Draft { questions: Question[] }
interface Built {
  draft: Draft; provider: string; model: string;
  based_on: number; empty: number; per_location: number; avoided: number;
}

export function AiAttestationDialog({ blockId, positionName, hasTest, onClose, onApplied }: {
  blockId: string;
  positionName: string;
  /** В аттестации уже есть вопросы — предупредим, что они заменятся. */
  hasTest: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const toast = useToast();
  const [count, setCount] = useState(10);
  const [built, setBuilt] = useState<Built | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'build' | 'apply' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Собранное вчера не должно пропадать оттого, что диалог закрыли.
  useEffect(() => {
    let live = true;
    get<Built>(`/ai/blocks/${blockId}/attestation`)
      .then((r) => { if (live) { setBuilt(r); setDraft(r.draft); } })
      .catch(() => { /* черновика нет — обычное дело */ });
    return () => { live = false; };
  }, [blockId]);

  async function build() {
    setBusy('build'); setErr(null);
    try {
      const r = await post<Built>(`/ai/blocks/${blockId}/attestation`, { count });
      setBuilt(r); setDraft(r.draft);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось собрать аттестацию');
    } finally { setBusy(null); }
  }

  async function apply() {
    if (!draft) return;
    setBusy('apply'); setErr(null);
    try {
      const r = await post<{ questions: number }>(
        `/ai/blocks/${blockId}/attestation/apply`, { draft },
      );
      toast(`Аттестация обновлена: ${r.questions} вопросов`);
      onApplied();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось применить');
      setBusy(null);
    }
  }

  async function discard() {
    await del(`/ai/blocks/${blockId}/attestation`).catch(() => {});
    setBuilt(null); setDraft(null);
  }

  const editQ = (fn: (d: Draft) => void) => {
    if (!draft) return;
    const copy: Draft = JSON.parse(JSON.stringify(draft));
    fn(copy);
    setDraft(copy);
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal ai-modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between" style={{ marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>Собрать финальную аттестацию</h3>
          <button className="btn ghost sm" onClick={onClose}>Закрыть</button>
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          Должность «{positionName}» · вопросы будут <b>свои</b>, не повторяющие уроки
        </p>

        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span className="muted">Вопросов</span>
              <input type="number" min={5} max={20} value={count}
                onChange={(e) => setCount(Math.min(20, Math.max(5, Number(e.target.value) || 10)))}
                style={{ width: 70 }} />
            </label>
            <button className="btn sm" disabled={busy !== null} onClick={build}>
              {busy === 'build' ? 'Собираем…' : draft ? 'Собрать заново' : 'Собрать'}
            </button>
          </div>
          {built && (
            <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              Собрано по {built.based_on} урокам с материалом
              {built.empty > 0 && <> · {built.empty} ещё не заполнены</>}
              {built.per_location > 0 && (
                <> · {built.per_location} точечных не вошли: аттестация одна на сеть,
                  а их содержимое на точках разное</>
              )}
              {built.avoided > 0 && <> · не повторяем {built.avoided} вопросов из уроков</>}
            </p>
          )}
        </div>

        {hasTest && draft && (
          <div className="banner info" style={{ marginBottom: 12, fontSize: 13 }}>
            В аттестации уже есть вопросы — они будут заменены целиком.
          </div>
        )}

        {!draft && (
          <div className="panel muted" style={{ fontSize: 13.5 }}>
            Здесь появятся вопросы. Каждый можно поправить или выбросить
            до того, как они попадут в аттестацию.
          </div>
        )}

        {draft && (
          <>
            {draft.questions.map((q, qi) => (
              <div key={qi} className="panel" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <textarea
                    value={q.text} rows={2}
                    onChange={(e) => editQ((d) => { d.questions[qi].text = e.target.value; })}
                    style={{ flex: 1, fontFamily: 'inherit', fontSize: 13.5 }}
                  />
                  <button className="btn ghost sm" title="Убрать вопрос"
                    onClick={() => editQ((d) => { d.questions.splice(qi, 1); })}>✕</button>
                </div>
                {q.options.map((o, oi) => (
                  <label key={oi} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                    <input type="radio" checked={q.correct_index === oi}
                      onChange={() => editQ((d) => { d.questions[qi].correct_index = oi; })} />
                    <input value={o} style={{ flex: 1, fontSize: 13 }}
                      onChange={(e) => editQ((d) => { d.questions[qi].options[oi] = e.target.value; })} />
                  </label>
                ))}
              </div>
            ))}

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn ghost" onClick={discard}>Выбросить</button>
              <button className="btn" disabled={busy !== null || draft.questions.length < 3}
                onClick={apply}>
                {busy === 'apply' ? 'Ставим…' : 'Поставить в аттестацию'}
              </button>
            </div>
          </>
        )}

        {err && <p style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{err}</p>}
      </div>
    </div>
  );
}
