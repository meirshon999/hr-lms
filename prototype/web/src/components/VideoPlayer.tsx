import { useEffect, useRef, useState } from 'react';
import { post } from '../api';

const isReal = (u: string | null) => !!u && u.startsWith('/api/v1/files/');
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Плеер урока. Если файл загружен — обычный <video>. Если нет (демо-данные) —
 * имитация, чтобы сценарий показа работал без медиа.
 *
 * В обоих случаях прогресс уходит на сервер, и именно сервер решает, можно ли
 * закрыть материал: клиент не может соврать, что досмотрел.
 * Считаем максимально досмотренную точку, а не текущую позицию, — перемотка
 * назад не должна сбрасывать прогресс, перемотка вперёд не должна его дарить.
 */
export function VideoPlayer({
  lessonId, src, minWatchPct, initialPct, onProgress,
}: {
  lessonId: string; src: string | null; minWatchPct: number | null;
  initialPct: number; onProgress: (pct: number) => void;
}) {
  const [pct, setPct] = useState(initialPct);
  const sent = useRef(initialPct);
  const need = minWatchPct ?? 90;
  const real = isReal(src);

  // отправляем прогресс на сервер каждые ~10% и обязательно в конце
  useEffect(() => {
    if (pct - sent.current < 10 && pct < 100) return;
    sent.current = pct;
    post(`/me/lessons/${lessonId}/video-progress`, { pct })
      .then((r: any) => onProgress(r.video_pct))
      .catch(() => {});
  }, [pct, lessonId, onProgress]);

  return real
    ? <RealVideo src={src!} pct={pct} need={need} onPct={setPct} />
    : <FakeVideo pct={pct} need={need} onPct={setPct} />;
}

function RealVideo({ src, pct, need, onPct }: {
  src: string; pct: number; need: number; onPct: (p: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [dur, setDur] = useState(0);
  const [pos, setPos] = useState(0);
  const maxSeen = useRef(0);

  function onTime() {
    const v = ref.current;
    if (!v || !v.duration || !isFinite(v.duration)) return;
    setPos(v.currentTime);
    maxSeen.current = Math.max(maxSeen.current, v.currentTime);
    const next = Math.min(100, Math.round((maxSeen.current / v.duration) * 100));
    if (next > pct) onPct(next);
  }

  return (
    <div className="player">
      <video
        ref={ref}
        className="stage vid"
        src={src}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={() => setDur(ref.current?.duration ?? 0)}
        onTimeUpdate={onTime}
        onEnded={() => onPct(100)}
      />
      <div className="track"><i style={{ width: `${pct}%` }} /></div>
      <div className="meta">
        <span>{fmt(pos)} / {dur ? fmt(dur) : '—'}</span>
        <span style={{ color: pct >= need ? 'var(--success)' : undefined }}>
          {pct}% {pct >= need ? '· зачтено' : `· нужно ${need}%`}
        </span>
      </div>
    </div>
  );
}

function FakeVideo({ pct, need, onPct }: { pct: number; need: number; onPct: (p: number) => void }) {
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      const next = Math.min(100, pct + 4);
      if (next >= 100) setPlaying(false);
      onPct(next);
    }, 220);
    return () => clearInterval(iv);
  }, [playing, pct, onPct]);

  const secs = Math.round((pct / 100) * 180);
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
        <span className="label">видео не загружено · показываем имитацию</span>
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
