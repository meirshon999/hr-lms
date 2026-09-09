import { useRef, useState } from 'react';
import { ApiError, upload } from '../api';

const ACCEPT = {
  video: 'video/mp4,video/webm,video/quicktime',
  pdf: 'application/pdf',
  any: 'video/mp4,video/webm,video/quicktime,application/pdf,image/png,image/jpeg',
};

const human = (b: number) =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`;

/**
 * Выбор реального файла с компьютера и загрузка на сервер.
 * Наружу отдаёт url вида /api/v1/files/<id> — его и кладём в material.file_url.
 */
export function FilePicker({
  kind, value, onChange,
}: {
  kind: 'video' | 'pdf';
  value: string | null;
  onChange: (url: string | null, name?: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploaded = !!value && value.startsWith('/api/v1/files/');
  const legacy = !!value && !uploaded; // старые демо-заглушки вроде demo:file

  async function pick(file: File) {
    setError(null);
    setPct(0);
    try {
      const r = await upload(file, setPct);
      setName(r.orig_name);
      onChange(r.url, r.orig_name);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить');
    } finally {
      setPct(null);
    }
  }

  return (
    <div className="filepick">
      <input
        ref={inputRef} type="file" accept={ACCEPT[kind]} hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }}
      />

      {pct !== null ? (
        <div className="up">
          <div className="track"><i style={{ width: `${pct}%` }} /></div>
          <span className="muted">Загружаем… {pct}%</span>
        </div>
      ) : uploaded ? (
        <div className="have">
          <span className="ico">{kind === 'video' ? '▶' : '⬇'}</span>
          <div className="tx">
            <b>{name ?? (kind === 'video' ? 'Видео загружено' : 'PDF загружен')}</b>
            <a href={value!} target="_blank" rel="noreferrer" className="muted">открыть файл</a>
          </div>
          <button className="btn ghost sm" onClick={() => inputRef.current?.click()}>Заменить</button>
          <button className="btn ghost sm" onClick={() => { setName(null); onChange(null); }}>Убрать</button>
        </div>
      ) : (
        <>
          <button className="btn ghost sm" onClick={() => inputRef.current?.click()}>
            Выбрать {kind === 'video' ? 'видео' : 'PDF'} с компьютера
          </button>
          <span className="muted hint">
            {kind === 'video' ? 'mp4, webm, mov' : 'pdf'} · до 60 МБ
          </span>
          {legacy && (
            <div className="banner warn mt8" style={{ fontSize: 12.5 }}>
              Сейчас стоит демо-заглушка. Выберите настоящий файл.
            </div>
          )}
        </>
      )}

      {error && <div className="banner warn mt8" style={{ fontSize: 12.5 }}>{error}</div>}
    </div>
  );
}

export { human as humanSize };
