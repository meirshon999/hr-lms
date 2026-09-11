import { useState } from 'react';
import { del, patch, post } from '../api';
import { Icon } from './Icon';

interface Q { id: string; text: string; options: string[]; correct_index: number; }
interface Test { id: string; pass_mark_pct: number; questions: Q[]; }

/** onUpsert(passMark) вызывает PUT .../test — создаёт тест или меняет проходной балл. */
export function TestEditor({
  test, onCreate, onChange,
}: {
  test: Test | null;
  onCreate: (passMark: number) => Promise<unknown> | void;
  onChange: () => void;
}) {
  const [pass, setPass] = useState(test?.pass_mark_pct ?? 70);

  if (!test) {
    return (
      <div className="pane">
        <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>Тест ещё не создан.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 13 }}>Проходной балл, %:
            <input type="number" min={1} max={100} value={pass}
              onChange={(e) => setPass(Number(e.target.value))}
              style={{ width: 68, marginLeft: 6, padding: '5px 8px' }} />
          </label>
          <button className="btn sm" onClick={() => onCreate(pass)}>Создать тест</button>
        </div>
      </div>
    );
  }
  return (
    <div className="pane">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontSize: 13 }}>Проходной балл, %:
          <input type="number" min={1} max={100} value={pass}
            onChange={(e) => setPass(Number(e.target.value))}
            onBlur={() => pass !== test.pass_mark_pct && onCreate(pass)}
            style={{ width: 68, marginLeft: 6, padding: '5px 8px' }} />
        </label>
        <span className="muted" style={{ fontSize: 12 }}>({test.questions.length} вопросов)</span>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {test.questions.map((q, i) => (
          <QuestionRow key={q.id} n={i + 1} q={q} onChange={onChange} />
        ))}
      </div>

      <AddQuestion testId={test.id} onAdded={onChange} />
    </div>
  );
}

function QuestionRow({ n, q, onChange }: { n: number; q: Q; onChange: () => void }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(q.text);
  const [opts, setOpts] = useState<string[]>(q.options);
  const [correct, setCorrect] = useState(q.correct_index);

  async function save() {
    await patch(`/questions/${q.id}`, { text, options: opts.filter((o) => o.trim()), correct_index: correct });
    setEdit(false); onChange();
  }

  if (!edit) {
    return (
      <div className="b-lesson" style={{ background: 'var(--surface-2)' }}>
        <div className="lh">
          <b style={{ flex: 1 }}>{n}. {q.text}</b>
          <button className="btn ghost sm" onClick={() => setEdit(true)}>Изменить</button>
          <button className="btn icon danger" title="Удалить вопрос"
            onClick={() => del(`/questions/${q.id}`).then(onChange)}><Icon name="trash" /></button>
        </div>
        <ul style={{ margin: '6px 0 0 18px', fontSize: 13 }}>
          {q.options.map((o, i) => (
            <li key={i} style={i === q.correct_index ? { color: 'var(--success)', fontWeight: 700 } : {}}>
              {o}{i === q.correct_index ? '  ✓' : ''}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="b-lesson" style={{ background: 'var(--surface-2)' }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Текст вопроса"
        style={{ width: '100%', marginBottom: 8 }} />
      {opts.map((o, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5, alignItems: 'center' }}>
          <input type="radio" checked={correct === i} onChange={() => setCorrect(i)} title="верный" />
          <input value={o} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))}
            style={{ flex: 1 }} />
          {opts.length > 2 && <button className="btn icon danger" title="Убрать вариант" onClick={() => {
            setOpts(opts.filter((_, j) => j !== i));
            if (correct >= opts.length - 1) setCorrect(0);
          }}><Icon name="x" /></button>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {opts.length < 6 && <button className="btn ghost sm" onClick={() => setOpts([...opts, ''])}>+ вариант</button>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setEdit(false)}>Отмена</button>
        <button className="btn sm" onClick={save}>Сохранить</button>
      </div>
    </div>
  );
}

function AddQuestion({ testId, onAdded }: { testId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [opts, setOpts] = useState(['', '']);
  const [correct, setCorrect] = useState(0);

  if (!open) return <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>+ вопрос</button>;

  async function add() {
    const clean = opts.filter((o) => o.trim());
    if (!text.trim() || clean.length < 2) return;
    await post(`/tests/${testId}/questions`, {
      text: text.trim(), options: clean, correct_index: Math.min(correct, clean.length - 1),
    });
    setText(''); setOpts(['', '']); setCorrect(0); setOpen(false);
    onAdded();
  }

  return (
    <div className="b-lesson" style={{ background: 'var(--accent-soft)', marginTop: 8 }}>
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Текст нового вопроса"
        style={{ width: '100%', marginBottom: 8 }} />
      {opts.map((o, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5, alignItems: 'center' }}>
          <input type="radio" checked={correct === i} onChange={() => setCorrect(i)} title="верный" />
          <input value={o} placeholder={`Вариант ${i + 1}`}
            onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))}
            style={{ flex: 1 }} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {opts.length < 6 && <button className="btn ghost sm" onClick={() => setOpts([...opts, ''])}>+ вариант</button>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => setOpen(false)}>Отмена</button>
        <button className="btn sm" onClick={add}>Добавить вопрос</button>
      </div>
    </div>
  );
}
