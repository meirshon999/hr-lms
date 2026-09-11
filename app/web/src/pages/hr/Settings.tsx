import { useEffect, useState } from 'react';
import { ApiError, del, get, post, put } from '../../api';
import { useAsync, Loader, ErrorBox, useToast } from '../../lib';

/**
 * НАСТРОЙКИ ИИ.
 *
 * Ключ вставляется прямо сюда — доступ к серверу не нужен, и платит за ИИ тот,
 * кто системой пользуется. Ключ, заданный на сервере переменной, при этом
 * никуда не девается: настройка просто оказывается главнее, и на экране
 * написано, какой из двух сейчас действует.
 *
 * Три вещи, которые экран обязан говорить вслух, иначе он вредный:
 * сколько ИИ уже потратил, где взять ключ и как убрать свой перед передачей
 * системы другому владельцу.
 */

interface ProviderInfo {
  key: string; title: string; default_model: string;
  free: boolean; reads_documents: boolean; note: string;
  console_url: string; key_prefix: string; price: string;
}
interface Usage {
  calls: number; tokens_in: number; tokens_out: number; failed: number;
  calls_total: number; since: string | null;
  by_action: { action: string; calls: number; tokens: number }[];
  titles: Record<string, string>;
}
interface AiSettingsDto {
  provider: string; model: string; has_key: boolean; key_hint: string;
  source: 'settings' | 'env' | 'none';
  key_unreadable: boolean;
  ai: { enabled: boolean; provider: string; model: string | null; reason: string | null };
  usage: Usage;
  providers: ProviderInfo[];
}

const thousands = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} млн`
    : n >= 1000 ? `${Math.round(n / 1000)} тыс.` : String(n);

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
  const u = data.usage;

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

  async function removeKey() {
    setBusy('reset'); setErr(null); setTested(null);
    try {
      await del('/settings/ai');
      setKey('');
      toast('Ключ удалён');
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось убрать ключ');
    } finally { setBusy(null); }
  }

  return (
    <>
      <h1>Настройки</h1>
      <p className="subtitle">Ключ ИИ, провайдер и расход</p>

      {/* Ключ с чужого сервера — не поломка, а защита. Но молчать про неё нельзя. */}
      {data.key_unreadable && (
        <div className="panel" style={{ marginBottom: 16, borderLeft: '3px solid var(--warning, #d08700)' }}>
          <b>Сохранённый ключ здесь не читается</b>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            Он был задан на другом сервере: ключи шифруются, и копия базы чужой
            ключ не выдаёт. Это сделано намеренно. Вставьте свой ключ ниже.
          </p>
        </div>
      )}

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

      {/* Расход. Счёт приходит через месяц и только в кабинете провайдера —
          между «нажал» и «увидел сумму» слишком долго, чтобы молчать.
          Сворачиваем в одну строку: ради этих цифр не должен уезжать вниз
          блок с ключом, за которым сюда и приходят. */}
      {u.calls_total > 0 && (
        <details className="panel" style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'baseline' }}>
            <b style={{ fontSize: 13.5 }}>Расход за 30 дней</b>
            <span className="muted" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
              {u.calls} обращений · {thousands(u.tokens_in + u.tokens_out)} токенов
              {u.failed > 0 && ` · ${u.failed} неудачных`}
            </span>
          </summary>

          <div style={{
            display: 'grid', gap: 10, marginTop: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          }}>
            {[
              ['Обращений', String(u.calls)],
              ['Токенов на вход', thousands(u.tokens_in)],
              ['Токенов на ответ', thousands(u.tokens_out)],
              ['Всего за всё время', String(u.calls_total)],
            ].map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                <div className="muted" style={{ fontSize: 12 }}>{label}</div>
              </div>
            ))}
          </div>

          {u.by_action.length > 0 && (
            <table className="mini" style={{ width: '100%', fontSize: 13, marginTop: 12 }}>
              <tbody>
                {u.by_action.map((r) => (
                  <tr key={r.action}>
                    <td>{u.titles[r.action] ?? r.action}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.calls}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} className="muted">
                      {thousands(r.tokens)} токенов
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            Сумму в деньгах смотрите в кабинете провайдера: тарифы меняются,
            и считать их здесь значило бы врать.
          </p>
        </details>
      )}

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
            Кнопок сборки уроков и разбора документов не будет вовсе.
            Уроки заполняются руками — система от этого работает так же.
          </p>
        )}

        {chosen && (
          <>
            {/* «Вставьте ключ» без ответа на «где его взять» — бесполезный совет. */}
            <div className="panel" style={{ background: 'var(--bg-soft, rgba(0,0,0,.03))', marginBottom: 12 }}>
              <b style={{ fontSize: 13 }}>Где взять ключ</b>
              <ol className="muted" style={{ fontSize: 13, marginBottom: 0, paddingLeft: 18 }}>
                <li>
                  Откройте <a href={chosen.console_url} target="_blank" rel="noreferrer">
                    кабинет {chosen.title}
                  </a> и войдите или заведите учётную запись.
                </li>
                <li>Создайте ключ (Create key) и скопируйте его — показывают его один раз.</li>
                <li>Вставьте сюда. Ключ начинается с «{chosen.key_prefix}».</li>
              </ol>
              <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
                {chosen.price}
              </p>
            </div>

            <label className="field" style={{ marginBottom: 10 }}>
              <span>Ключ провайдера</span>
              <input
                type="password" value={key} autoComplete="off"
                placeholder={data.has_key ? `сохранён ${data.key_hint} — впишите новый, чтобы заменить` : `${chosen.key_prefix}…`}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
              Ключ обратно не показывается — ни вам, ни кому-либо ещё. В базе он
              лежит зашифрованным: копия базы, увезённая на другой сервер, ключ
              не выдаст.
            </p>

            <label className="field" style={{ marginTop: 10, marginBottom: 10 }}>
              <span>Модель</span>
              <input value={model} onChange={(e) => setModel(e.target.value)}
                placeholder={chosen.default_model} />
            </label>
            <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
              Названия моделей у провайдеров меняются. Если эта перестанет
              работать, впишите другую — трогать код не нужно.
            </p>
          </>
        )}

        {err && <p style={{ color: 'var(--error)', fontSize: 13, marginTop: 10 }}>{err}</p>}

        <div className="row" style={{ marginTop: 14 }}>
          {data.source === 'settings' && data.has_key && (
            <button className="btn ghost" disabled={busy !== null} onClick={removeKey}
              title="Стереть ключ из базы — например, перед передачей системы">
              {busy === 'reset' ? 'Убираем…' : 'Убрать мой ключ'}
            </button>
          )}
          <button className="btn" disabled={busy !== null || !provider} onClick={save}>
            {busy === 'save' ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>

        {data.source === 'settings' && data.has_key && (
          <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            Передаёте систему другому владельцу — нажмите «Убрать мой ключ».
            Дальше он вставит свой, и платить будет он.
          </p>
        )}
      </div>
    </>
  );
}
