import { useEffect, useRef, useState } from 'react';
import { post } from '../api';

/**
 * Демо-плеер: реального файла нет, но прогресс просмотра ведётся честно —
 * отправляется на сервер, и именно сервер решает, можно ли закрыть материал.
 * В боевой версии заменяется на <video> + те же отчёты о прогрессе.
 */
export function VideoPlayer({
  lessonId, minWatchPct, initialPct, onProgress,
}: {
  lessonId: string; minWatchPct: number | null; initialPct: number; onProgress: (pct: number) => void;
}) {
  const [pct, setPct] = useState(initialPct);
  const [playing, setPlaying] = useState(false);
  const sent = useRef(initialPct);

  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      setPct((p) => {
        const next = Math.min(100, p + 4);
        if (next >= 100) setPlaying(false);
        return next;
      });
    }, 220);
    return () => clearInterval(iv);
  }, [playing]);

  // отправляем прогресс на сервер каждые ~10%
  useEffect(() => {
    if (pct - sent.current < 10 && pct < 100) return;
    sent.current = pct;
    post(`/me/lessons/${lessonId}/video-progress`, { pct })
      .then((r: any) => onProgress(r.video_pct))
      .catch(() => {});
  }, [pct, lessonId, onProgress]);

  const need = minWatchPct ?? 90;
  const secs = Math.round((pct / 100) * 180);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="player">
      <div className="stage">
        {pct >= 100 ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 34 }}>✓</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Просмотрено полностью</div>
          </div>
        ) : (
          <button className="big-play" onClick={() => setPlaying((p) => !p)} aria-label="Воспроизвести">
            {playing ? '❚❚' : '▶'}
          </button>
        )}
        <span className="label">демо-видео · прогресс считается на сервере</span>
      </div>
      <div className="track"><i style={{ width: `${pct}%` }} /></div>
      <div className="meta">
        <span>{fmt(secs)} / 3:00</span>
        <span style={{ color: pct >= need ? 'var(--success)' : undefined }}>
          {pct}% {pct >= need ? '· зачтено' : `· нужно ${need}%`}
        </span>
      </div>
    </div>
  );
}
