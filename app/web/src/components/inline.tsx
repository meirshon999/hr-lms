import { useState } from 'react';

type Ctype = 'text' | 'video' | 'pdf';

export function InlineAdd({
  placeholder, label, onAdd, withType = false,
}: {
  placeholder: string; label: string; withType?: boolean;
  onAdd: (value: string, type: Ctype) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  const [type, setType] = useState<Ctype>('text');
  const [busy, setBusy] = useState(false);

  if (!open) return <button className="btn ghost sm" onClick={() => setOpen(true)}>{label}</button>;

  async function go() {
    if (!v.trim()) return;
    setBusy(true);
    try { await onAdd(v.trim(), type); setV(''); setOpen(false); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
      <input autoFocus placeholder={placeholder} value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        style={{ flex: 1, minWidth: 160, padding: '8px 10px', border: '1.5px solid var(--line)', borderRadius: 8 }} />
      {withType && (
        <select value={type} onChange={(e) => setType(e.target.value as Ctype)}
          style={{ padding: '8px', border: '1.5px solid var(--line)', borderRadius: 8 }}>
          <option value="text">Текст</option>
          <option value="video">Видео</option>
          <option value="pdf">PDF</option>
        </select>
      )}
      <button className="btn sm" disabled={busy} onClick={go}>Добавить</button>
      <button className="btn ghost sm" onClick={() => { setOpen(false); setV(''); }}>Отмена</button>
    </div>
  );
}

export function MoveBtns({ i, count, onMove }: { i: number; count: number; onMove: (dir: -1 | 1) => void }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      <button className="btn ghost sm" style={{ padding: '2px 7px' }} disabled={i === 0}
        title="Выше" onClick={() => onMove(-1)}>↑</button>
      <button className="btn ghost sm" style={{ padding: '2px 7px' }} disabled={i === count - 1}
        title="Ниже" onClick={() => onMove(1)}>↓</button>
    </span>
  );
}

/** [a,b,c], move index i by dir → new array */
export function reordered<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const copy = [...list];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}

export function EditableTitle({
  value, onSave, heading = false,
}: {
  value: string; onSave: (v: string) => Promise<unknown> | void; heading?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);

  if (editing) {
    return (
      <input
        autoFocus value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { setEditing(false); if (v.trim() && v !== value) onSave(v.trim()); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        style={{ flex: 1, padding: '6px 8px', border: '1.5px solid var(--accent)', borderRadius: 7,
          font: 'inherit', fontWeight: 700 }}
      />
    );
  }
  const Cmp = heading ? 'h4' : 'b';
  return (
    <Cmp style={{ flex: 1, cursor: 'text' }} title="Нажмите, чтобы переименовать"
      onClick={() => { setV(value); setEditing(true); }}>
      {value}
    </Cmp>
  );
}
