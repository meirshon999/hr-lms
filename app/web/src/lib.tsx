import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react';
import { ApiError } from './api';

/* ---------- global refresh signal (dev clock / mutations) ---------- */
const BumpCtx = createContext<{ n: number; bump: () => void }>({ n: 0, bump: () => {} });
export const useBump = () => useContext(BumpCtx);
export function BumpProvider({ children }: { children: ReactNode }) {
  const [n, setN] = useState(0);
  return <BumpCtx.Provider value={{ n, bump: () => setN((x) => x + 1) }}>{children}</BumpCtx.Provider>;
}

/* ---------- data hook ---------- */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const { n } = useBump();
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fnRef.current()
      .then((data) => setState({ data, loading: false }))
      .catch((error) => setState({ error, loading: false }));
  }, []);

  useEffect(reload, [reload, n, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload };
}

/* ---------- small ui ---------- */
export function Loader({ text = 'Загружаем…' }: { text?: string }) {
  return <div className="center"><div className="spinner" /><span>{text}</span></div>;
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Не удалось загрузить. Проверьте соединение.';
  return (
    <div className="center">
      <div className="banner warn" style={{ maxWidth: 360, textAlign: 'center' }}>{msg}</div>
      {onRetry && <button className="btn ghost sm" onClick={onRetry}>Повторить</button>}
    </div>
  );
}

/* ---------- скелетоны ---------- */
const bar = (h: number, w: string = '100%') =>
  <div className="skel" style={{ height: h, width: w }} />;

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div>
      {bar(78)}
      <div style={{ height: 14 }} />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0' }}>
          <div className="skel" style={{ height: 30, width: 30, borderRadius: 9, flex: 'none' }} />
          <div style={{ flex: 1 }}>{bar(13, `${55 + (i * 11) % 35}%`)}</div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonLesson() {
  return (
    <div>
      {bar(5)}
      <div style={{ height: 16 }} />
      {bar(170)}
      <div style={{ height: 14 }} />
      {bar(13)}{bar(13, '92%')}{bar(13, '78%')}
    </div>
  );
}

/* ---------- сеть ---------- */
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

export function OfflineBar() {
  const online = useOnline();
  if (online) return null;
  return <div className="offline-bar">Нет сети — изменения не сохранятся. Проверьте интернет.</div>;
}

/* ---------- toast ---------- */
const ToastCtx = createContext<(msg: string, kind?: 'ok' | 'warn') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: string } | null>(null);
  const show = useCallback((msg: string, kind: 'ok' | 'warn' = 'ok') => {
    setT({ msg, kind });
    setTimeout(() => setT(null), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div style={{
          position: 'fixed', bottom: 58, left: '50%', transform: 'translateX(-50%)', zIndex: 80,
        }}>
          <div className={`banner ${t.kind === 'ok' ? 'ok' : 'warn'}`} style={{ boxShadow: 'var(--shadow-lg)' }}>
            {t.msg}
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

export const STAGE_LABEL: Record<string, string> = {
  intern: 'Стажировка', onboarding: 'Онбординг', completed: 'Завершил', archived: 'Архив',
};

/**
 * Какие файлы принимает окно разбора документа. PDF читается своими силами
 * на любом ключе и вовсе без ключа — в списке он есть всегда. Скан, где
 * внутри картинка вместо букв, возьмёт только Claude, и об этом система
 * скажет при загрузке такого файла.
 */
export const DOC_ACCEPT = '.docx,.pdf,.txt,.md';
