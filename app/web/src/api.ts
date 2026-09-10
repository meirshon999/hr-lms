const BASE = '/api/v1';

export class ApiError extends Error {
  code: string;
  details?: unknown;
  status: number;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function token(): string | null {
  try { return localStorage.getItem('lms_token'); } catch { return null; }
}
export function setToken(t: string | null) {
  // Хранилище может быть недоступно: приватное окно, запрет на данные сайта.
  // Тогда вход просто не переживёт перезагрузку страницы — это не повод падать.
  try {
    if (t) localStorage.setItem('lms_token', t);
    else localStorage.removeItem('lms_token');
  } catch { /* хранилище недоступно — работаем без него */ }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(token() ? { authorization: `Bearer ${token()}` } : {}),
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // Токен живёт 12 часов. Без этой ветки протухший токен давал 401 на каждый
    // запрос, а экраны молча оставались пустыми — например список должностей
    // в форме найма. Теперь сеанс честно завершается.
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      setToken(null);
      window.dispatchEvent(new CustomEvent('lms:unauthorized'));
    }
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Ошибка', e.details);
  }
  return data as T;
}

export interface Uploaded {
  id: string; url: string; kind: 'video' | 'pdf' | 'image';
  orig_name: string; mime: string; size_bytes: number;
}

/**
 * Загрузка файла. content-type не ставим — браузер сам проставит multipart
 * с boundary; если задать вручную, сервер не разберёт тело.
 * onProgress работает через XHR: у fetch прогресса отправки нет.
 */
/**
 * Надиктованное — в текст. Запись никуда не сохраняется: она живёт ровно столько,
 * сколько идёт расшифровка.
 */
export async function transcribeAudio(blob: Blob, filename = 'speech.webm'): Promise<string> {
  const fd = new FormData();
  fd.append('file', blob, filename);
  const t = token();
  const res = await fetch(BASE + '/ai/transcribe', {
    method: 'POST',
    headers: t ? { authorization: `Bearer ${t}` } : {},
    body: fd,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data as any)?.error;
    throw new ApiError(res.status, e?.code ?? 'stt_failed', e?.message ?? 'Не удалось расшифровать');
  }
  return (data as any).text as string;
}

/**
 * Документ Word или текстовый файл — в текст. Файл на сервере не остаётся:
 * человек увидит разобранный текст в поле и сможет поправить его до того,
 * как что-то уйдёт модели.
 */
export async function extractDocument(file: File): Promise<{ text: string; chars: number }> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const t = token();
  const res = await fetch(BASE + '/ai/extract', {
    method: 'POST',
    headers: t ? { authorization: `Bearer ${t}` } : {},
    body: fd,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data as any)?.error;
    throw new ApiError(res.status, e?.code ?? 'doc_failed', e?.message ?? 'Не удалось прочитать документ');
  }
  return data as { text: string; chars: number };
}

export function upload(file: File, onProgress?: (pct: number) => void): Promise<Uploaded> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', BASE + '/files');
    const t = token();
    if (t) xhr.setRequestHeader('authorization', `Bearer ${t}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: any = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as Uploaded);
      if (xhr.status === 401) { setToken(null); window.dispatchEvent(new CustomEvent('lms:unauthorized')); }
      const e = data?.error ?? {};
      reject(new ApiError(xhr.status, e.code ?? 'error', e.message ?? 'Не удалось загрузить файл'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Сеть недоступна'));
    xhr.send(fd);
  });
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body });
export const patch = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });
