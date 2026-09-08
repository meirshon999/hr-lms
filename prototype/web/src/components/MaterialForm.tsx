import { useState } from 'react';
import { put } from '../api';
import { FilePicker } from './FilePicker';

interface Material {
  content_type: 'text' | 'video' | 'pdf';
  text_body: string | null; file_url: string | null; min_watch_pct: number | null;
}

export function MaterialForm({
  lessonId, material, onSaved,
}: {
  lessonId: string; material: Material | null; onSaved: () => void;
}) {
  const [m, setM] = useState<Material>(material ?? {
    content_type: 'text', text_body: '', file_url: null, min_watch_pct: null,
  });
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await put(`/lessons/${lessonId}/material`, {
        content_type: m.content_type,
        text_body: m.content_type === 'text' ? (m.text_body || 'Текст материала…') : null,
        file_url: m.content_type !== 'text' ? m.file_url : null,
        min_watch_pct: m.content_type === 'video' ? (m.min_watch_pct ?? 80) : null,
      });
      setOk(true); setTimeout(() => setOk(false), 1500);
      onSaved();
    } finally { setBusy(false); }
  }

  return (
    <div style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
      <label className="field" style={{ marginBottom: 10 }}>
        <span>Тип материала</span>
        <select value={m.content_type} onChange={(e) => setM({ ...m, content_type: e.target.value as any })}>
          <option value="text">Текст</option>
          <option value="video">Видео</option>
          <option value="pdf">PDF</option>
        </select>
      </label>
      {m.content_type === 'text' ? (
        <label className="field" style={{ marginBottom: 10 }}>
          <span>Текст</span>
          <textarea rows={4} value={m.text_body ?? ''} onChange={(e) => setM({ ...m, text_body: e.target.value })} />
        </label>
      ) : (
        <>
          <div className="field" style={{ marginBottom: 10 }}>
            <span>Файл</span>
            <FilePicker
              kind={m.content_type as 'video' | 'pdf'}
              value={m.file_url}
              onChange={(url) => setM({ ...m, file_url: url })}
            />
          </div>
          {m.content_type === 'video' && (
            <label className="field" style={{ marginBottom: 10 }}>
              <span>Нужно посмотреть, %</span>
              <input type="number" min={0} max={100} value={m.min_watch_pct ?? 80}
                onChange={(e) => setM({ ...m, min_watch_pct: Number(e.target.value) })} />
            </label>
          )}
        </>
      )}
      {m.content_type !== 'text' && !m.file_url && (
        <div className="banner warn mt8" style={{ fontSize: 12.5 }}>
          Выберите файл — без него материал не сохранится.
        </div>
      )}
      <button className="btn sm" disabled={busy || (m.content_type !== 'text' && !m.file_url)} onClick={save}>
        {busy ? 'Сохраняем…' : ok ? 'Сохранено ✓' : 'Сохранить материал'}
      </button>
    </div>
  );
}
