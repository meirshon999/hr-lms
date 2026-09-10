import {
  GROQ_API_KEY, GROQ_BASE_URL, GROQ_STT_MODEL, STT_LANGUAGE, STT_PROVIDER,
} from '../config.ts';
import { AiError } from './provider.ts';

/**
 * РАСШИФРОВКА РЕЧИ.
 *
 * Зачем это в системе про обучение: половина уроков на точках — «своё на каждой»,
 * и писать их некому. Управляющий готов рассказать про свою кухню за две минуты,
 * но не готов сесть и набрать текст. Расшифровка убирает именно этот тормоз.
 *
 * Провайдер отдельный от того, что собирает уроки: у Claude входа для звука нет
 * вовсе, и переход на него не должен ломать микрофон.
 */

export const sttEnabled = () => STT_PROVIDER !== 'off';

export const sttInfo = () => ({
  enabled: sttEnabled(),
  provider: STT_PROVIDER,
  model: STT_PROVIDER === 'groq' ? GROQ_STT_MODEL : null,
  language: STT_LANGUAGE,
});

export async function transcribe(audio: Buffer, filename: string): Promise<string> {
  if (STT_PROVIDER === 'off') {
    throw new AiError('Расшифровка речи выключена: не задан ключ Groq', 'stt_disabled');
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)]), filename);
  form.append('model', GROQ_STT_MODEL);
  form.append('language', STT_LANGUAGE);
  // Простой текст, а не JSON с таймкодами: для урока нужны слова, не тайминги.
  form.append('response_format', 'text');

  let res: Response;
  try {
    res = await fetch(`${GROQ_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e: any) {
    throw new AiError(
      e?.name === 'TimeoutError' ? 'Расшифровка заняла больше трёх минут' : 'Не удалось связаться с сервисом расшифровки',
      'stt_unreachable',
    );
  }

  if (res.status === 429) throw new AiError('Бесплатный лимит исчерпан — попробуйте позже', 'stt_rate_limited');
  if (res.status === 413) throw new AiError('Запись слишком длинная — говорите короче', 'stt_too_large');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AiError(`Сервис расшифровки ответил ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, 'stt_failed');
  }

  const text = (await res.text()).trim();
  if (!text) throw new AiError('В записи не разобрано ни слова — проверьте микрофон', 'stt_empty');
  return text;
}
