import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../../api';
import { useAuth } from '../../auth';
import { useAsync, useBump, SkeletonLesson, ErrorBox } from '../../lib';
import { Phone } from '../../components/Phone';
import { TestRunner } from '../../components/TestRunner';

interface Att {
  test_id: string; pass_mark_pct: number;
  questions: { id: string; text: string; options: string[] }[];
  last_attempt: { score_pct: number; passed: boolean } | null;
  completed: boolean;
}

export function Attestation() {
  const nav = useNavigate();
  const { bump } = useBump();
  const { refresh } = useAuth();
  const { data, loading, error, reload } = useAsync(() => get<Att>('/me/attestation'), []);
  const [started, setStarted] = useState(false);

  const action = data && !data.completed && !started
    ? <button className="btn block" onClick={() => setStarted(true)}>Начать аттестацию</button>
    : undefined;

  return (
    <Phone hello="Финальная аттестация" back sub="Тест по всем блокам онбординга" action={action}>
      {loading && <SkeletonLesson />}
      {error && <ErrorBox error={error} onRetry={reload} />}

      {data?.completed && (
        <div className="banner ok">Аттестация пройдена. Онбординг завершён!</div>
      )}

      {data && !data.completed && !started && (
        <div className="q-card">
          <p style={{ marginBottom: 10 }}>
            {data.questions.length} вопросов по всем темам онбординга.
            Проходной балл — {data.pass_mark_pct}%. Попыток не ограничено.
          </p>
          {data.last_attempt && !data.last_attempt.passed && (
            <div className="banner warn" style={{ fontSize: 13 }}>
              Прошлая попытка — {data.last_attempt.score_pct}%. Попробуйте ещё раз.
            </div>
          )}
        </div>
      )}

      {data && !data.completed && started && (
        <TestRunner
          sticky
          title="Аттестация"
          questions={data.questions}
          onSubmit={async (answers) => {
            const r = await post('/me/attestation', { answers });
            bump();
            if (r.passed) await refresh();
            return r;
          }}
          onPassedContinue={() => nav('/')}
          continueLabel="На главную"
        />
      )}
    </Phone>
  );
}
