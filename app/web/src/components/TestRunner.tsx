import { useMemo, useState } from 'react';

export interface Question { id: string; text: string; options: string[]; }
export interface TestResult {
  score_pct: number; passed: boolean; pass_mark_pct: number;
  total: number; correct: number; attempt_no?: number;
  /** по каждому вопросу — только «верно/неверно», без правильного варианта */
  results?: { question_id: string; text: string; correct: boolean }[];
}

export function TestRunner({
  title, questions, onSubmit, onPassedContinue, continueLabel = 'Дальше', sticky = false,
}: {
  title: string;
  questions: Question[];
  onSubmit: (answers: { question_id: string; option_index: number }[]) => Promise<TestResult>;
  onPassedContinue: () => void;
  continueLabel?: string;
  /** нижняя панель липнет к низу экрана — для мобильных экранов */
  sticky?: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const q = questions[idx];
  const answeredAll = useMemo(
    () => questions.every((x) => answers[x.id] !== undefined),
    [questions, answers],
  );

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const r = await onSubmit(
        questions.map((x) => ({ question_id: x.id, option_index: answers[x.id] })),
      );
      setResult(r);
    } catch {
      setErr('Не удалось отправить ответы. Нажмите «Повторить».');
    } finally {
      setSubmitting(false);
    }
  }

  function retake() {
    setResult(null);
    setAnswers({});
    setIdx(0);
  }

  if (result) {
    const wrong = (result.results ?? []).filter((r) => !r.correct);
    return (
      <div className={`q-card result ${result.passed ? 'ok' : 'fail'}`}>
        <div className="score">
          <b>{result.correct}</b><span> из {result.total}</span>
        </div>
        <div className="score-sub">
          {result.score_pct}% · для зачёта нужно {result.pass_mark_pct}%
        </div>

        <p style={{ fontWeight: 700, marginTop: 10 }}>
          {result.passed
            ? (title === 'Аттестация' ? 'Аттестация пройдена. Онбординг завершён!' : 'Тест сдан. Следующий шаг открыт.')
            : result.correct === 0
              ? 'Ни одного верного ответа. Вернитесь к материалу и попробуйте снова.'
              : 'Пока не сдано. Разберите ошибки и пройдите ещё раз.'}
        </p>

        {wrong.length > 0 && (
          <div className="wrong-list">
            <div className="h">Ошибки — {wrong.length} из {result.total}:</div>
            <ol>{wrong.map((w) => <li key={w.question_id}>{w.text}</li>)}</ol>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              Правильные ответы не показываем специально — вернитесь к материалу.
            </div>
          </div>
        )}

        {result.passed ? (
          <>
            <button className="btn lg block mt16" onClick={onPassedContinue}>{continueLabel}</button>
            <button className="btn ghost block mt8" onClick={retake}>Пройти ещё раз</button>
          </>
        ) : (
          <button className="btn lg block mt16" onClick={retake}>Пройти заново</button>
        )}
      </div>
    );
  }

  const nav = (
    <div className="row-between" style={{ gap: 10 }}>
      <button className="btn ghost" style={{ flex: '0 0 34%' }}
        disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>
        Назад
      </button>
      {idx < questions.length - 1 ? (
        <button className="btn" style={{ flex: 1 }}
          disabled={answers[q.id] === undefined} onClick={() => setIdx((i) => i + 1)}>
          Далее
        </button>
      ) : (
        <button className="btn" style={{ flex: 1 }}
          disabled={!answeredAll || submitting} onClick={submit}>
          {submitting ? 'Отправляем…' : 'Завершить тест'}
        </button>
      )}
    </div>
  );

  return (
    <>
      <div className="q-card">
        <div className="qn">Вопрос {idx + 1} из {questions.length}</div>
        <div className="qt">{q.text}</div>
        {q.options.map((o, i) => (
          <div
            key={i}
            className={`opt ${answers[q.id] === i ? 'sel' : ''}`}
            onClick={() => setAnswers((a) => ({ ...a, [q.id]: i }))}
          >
            <div className="dot" />
            <div>{o}</div>
          </div>
        ))}
        {err && <div className="banner warn mt8">{err}</div>}
        {!sticky && <div className="mt16">{nav}</div>}
      </div>
      {sticky && <div className="phone-action" style={{ marginTop: 4 }}>{nav}</div>}
    </>
  );
}
