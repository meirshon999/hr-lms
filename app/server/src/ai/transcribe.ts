import { aiSettings, sttSettings } from './settings.ts';
import { AiError } from './provider.ts';

/**
 * РАСШИФРОВКА РЕЧИ.
 *
 * Зачем это в системе про обучение: половина уроков на точках — «своё на каждой»,
 * и писать их некому. Управляющий готов рассказать про свою кухню за две минуты,
 * но не готов сесть и набрать текст. Расшифровка убирает именно этот тормоз.
 *
 * Работает у тех провайдеров, кто принимает звук: Groq и OpenAI. У Claude входа
 * для звука нет вовсе — при нём микрофона просто не будет, и это не поломка,
 * а свойство провайдера. Отдельного ключа не нужно: берётся тот же, что и для
 * сборки уроков.
 */

export const sttEnabled = () => sttSettings().enabled;

export const sttInfo = () => {
  const s = sttSettings();
  return { enabled: s.enabled, provider: s.provider, model: s.model || null, language: s.language };
};

export async function transcribe(audio: Buffer, filename: string): Promise<string> {
  const stt = sttSettings();
  if (!stt.enabled) {
    throw new AiError(
      'Расшифровка речи недоступна: у выбранного провайдера нет модели для звука',
      'stt_disabled',
    );
  }
  const { apiKey, baseUrl } = aiSettings();

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)]), filename);
  form.append('model', stt.model);
  form.append('language', stt.language);
  // Простой текст, а не JSON с таймкодами: для урока нужны слова, не тайминги.
  form.append('response_format', 'text');

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e: any) {
    throw new AiError(
      e?.name === 'TimeoutError' ? 'Расшифровка заняла больше трёх минут' : 'Не удалось связаться с сервисом расшифровки',
      'stt_unreachable',
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new AiError('Ключ не принят провайдером — проверьте его в настройках', 'stt_bad_key');
  }
  if (res.status === 429) throw new AiError('Лимит провайдера исчерпан — попробуйте позже', 'stt_rate_limited');
  if (res.status === 413) throw new AiError('Запись слишком длинная — говорите короче', 'stt_too_large');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[stt] ${stt.provider} ${res.status}: ${detail.slice(0, 500)}`);
    throw new AiError(`Сервис расшифровки ответил ошибкой ${res.status}`, 'stt_failed');
  }

  const text = (await res.text()).trim();
  if (!text) throw new AiError('В записи не разобрано ни слова — проверьте микрофон', 'stt_empty');
  return text;
}
