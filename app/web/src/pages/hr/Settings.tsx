import { useEffect, useState } from 'react';
import { ApiError, del, get, post, put } from '../../api';
import { useAsync, Loader, ErrorBox, useToast } from '../../lib';

/**
 * НАСТРОЙКИ ИИ. Экран только для администратора.
 *
 * Ключ можно вставить прямо сюда — тогда доступ к серверу не нужен, и платит
 * за ИИ тот, кто системой пользуется. Ключ, заданный на сервере переменной,
 * при этом никуда не девается: настройка просто оказывается главнее, и на
 * экране написано, какой из двух сейчас действует.
 *
 * Ключ обратно не показывается никогда — только последние четыре знака.
 */

interface ProviderInfo {
  key: string; title: string; default_model: string;
  free: boolean; speech: boolean; reads_documents: boolean; note: string;
}
interface AiSettingsDto {
  provider: string; model: string; has_key: boolean; key_hint: string;
  source: 'settings' | 'env' | 'none';
  ai: { enabled: boolean; provider: string; model: string | null; reason: string | null };
  stt: { enabled: boolean; provider: string; model: string | null };
  providers: ProviderInfo[];
}

export function Settings() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get<AiSettingsDto>('/settings/ai'), []);

  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'reset' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setProvider(data.provider);
    setModel(data.model);
  }, [data]);

  if (loading && !data) return <Loader />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const chosen = data.providers.find((p) => p.key === provider);

  async function save() {
    setBusy('save'); setErr(null); setTested(null);
    try {
      await put('/settings/ai', {
        provider,
        api_key: key.trim() || undefined,
        model: model.trim() || undefined,
      });
      setKey('');
      toast('Настройки сохранены');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    } finally { setBusy(null); }
  }

  async function test() {
    setBusy('test'); setErr(null); setTested(null);
    try {
      const r = await post<{ provider: string; model: string }>('/settings/ai/test');
      setTested(`${r.provider} отвечает, модель «${r.model}»`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Проверка не удалась');
    } finally { setBusy(null); }
  }

  async function reset() {
    setBusy('reset'); setErr(null); setTested(null);
    try {
      await del('/settings/ai');
      setKey('');
      toast('Вернулись к настройкам сервера');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сбросить');
    } finally { setBusy(null); }
  }

  return (
    <>
      <h1>Настройки</h1>
      <p className="subtitle">Ключ ИИ и провайдер</p>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div>
            <b style={{ color: data.ai.enabled ? 'var(--success)' : 'var(--muted)' }}>
              {data.ai.enabled ? '● ИИ работает' : '○ ИИ выключен'}
            </b>
            <span className="muted" style={{ fontSize: 13 }}>
              {data.ai.enabled
                ? <> — {data.ai.provider} · {data.ai.model}
                    {data.source === 'env'
                      ? <> · ключ задан на сервере</>
                      : <> · ключ из настроек {data.key_hint}</>}
                  </>
                : <> — {data.ai.reason}</>}
            </span>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              Диктовка голосом: {data.stt.enabled
                ? <>работает ({data.stt.model})</>
                : <>недоступна у этого провайдера</>}
            </div>
          </div>
          {data.ai.enabled && (
            <button className="btn ghost sm" disabled={busy !== null} onClick={test}>
              {busy === 'test' ? 'Проверяем…' : 'Проверить ключ'}
            </button>
          )}
        </div>
        {tested && (
          <p style={{ color: 'var(--success)', fontSize: 13, marginTop: 10, marginBottom: 0 }}>
            ✓ {tested}
          </p>
        )}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Кто собирает уроки</h3>

        <label className="field" style={{ marginBottom: 10 }}>
          <span>Провайдер</span>
          <select value={provider} onChange={(e) => {
            setProvider(e.target.value);
            const p = data.providers.find((x) => x.key === e.target.value);
            setModel(p?.default_model ?? '');
          }}>
            <option value="off">Не использовать ИИ</option>
            {data.providers.map((p) => (
              <option key={p.key} value={p.key}>
                {p.title}{p.free ? ' — бесплатно' : ' — платно'}
              </option>
            ))}
          </select>
        </label>

        {chosen && (
          <p className="muted" style={{ fontSize: 13, marginTop: -2 }}>{chosen.note}</p>
        )}

        {provider === 'off' && (
          <p className="muted" style={{ fontSize: 13 }}>
            Кнопок сборки уроков, разбора документов и диктовки не будет вовсе.
            Уроки заполняются руками — система от этого работает так же.
          </p>
        )}

        {provider !== 'off' && provider !== '' && (
          <>
            <label className="field" style={{ marginBottom: 10 }}>
              <span>Ключ провайдера</span>
              <input
                type="password" value={key} autoComplete="off"
                placeholder={data.has_key ? `сохранён ${data.key_hint} — впишите новый, чтобы заменить` : 'вставьте ключ'}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
              Ключ обратно не показывается — ни вам, ни кому-либо ещё.
              Он попадает в базу и, значит, в резервные копии: на боевом сервере
              безопаснее задать его переменной окружения.
            </p>

            <label className="field" style={{ marginTop: 10, marginBottom: 10 }}>
              <span>Модель</span>
              <input value={model} onChange={(e) => setModel(e.target.value)}
                placeholder={chosen?.default_model} />
            </label>
            <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
              Названия моделей у провайдеров меняются. Если эта перестанет
              работать, впишите другую — трогать код не нужно.
            </p>
          </>
        )}

        {err && <p style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{err}</p>}

        <div className="row" style={{ marginTop: 14 }}>
          {data.source === 'settings' && (
            <button className="btn ghost" disabled={busy !== null} onClick={reset}>
              Вернуться к настройкам сервера
            </button>
          )}
          <button className="btn" disabled={busy !== null || !provider} onClick={save}>
            {busy === 'save' ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </>
  );
}
