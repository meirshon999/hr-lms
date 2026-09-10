import { z, type ZodType } from 'zod';
import {
  AI_PROVIDER, ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
  GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL,
} from '../config.ts';

/**
 * СЛОЙ ПРОВАЙДЕРА ИИ.
 *
 * Наружу торчит одна функция: «вот текст и вот форма ответа — верни объект этой
 * формы». Кто именно его вернул, Groq или Claude, вызывающий код не знает.
 * Поэтому переход «бесплатно → платно» это правка переменной окружения, а не кода.
 *
 * Почему разные способы обращения. К Claude идём через официальный SDK: у него
 * структурированный ответ — часть протокола, модель физически не может вернуть
 * поле не той формы. У Groq формат OpenAI, там достаточно одного POST, и тащить
 * ради него целую библиотеку в проект с семью зависимостями незачем.
 */

export class AiError extends Error {
  constructor(message: string, readonly code: string = 'ai_failed') {
    super(message);
  }
}

export const aiEnabled = () => AI_PROVIDER !== 'off';

/** Что показать HR, если функция не работает: причина всегда в настройке сервера. */
export function aiUnavailableReason(): string | null {
  if (AI_PROVIDER === 'off') return 'ИИ-конструктор выключен: не задан LMS_AI_PROVIDER';
  if (AI_PROVIDER === 'groq' && !GROQ_API_KEY) return 'Не задан GROQ_API_KEY';
  if (AI_PROVIDER === 'anthropic' && !ANTHROPIC_API_KEY) return 'Не задан ANTHROPIC_API_KEY';
  return null;
}

export interface AiRequest<T> {
  /** Роль и правила — то, что не меняется от запроса к запросу. */
  system: string;
  /** Сам исходник и задача. */
  user: string;
  /** Форма ответа. Она же проверка: не подошло — считаем, что модель не справилась. */
  schema: ZodType<T>;
  /**
   * Та же форма как JSON Schema. У Claude схему навязывает SDK, у Groq —
   * response_format. Без неё модель придумывает свои имена полей: на этом
   * регламенте она вернула «content» вместо «material» и лишнее поле сверху.
   */
  jsonSchema: Record<string, unknown>;
  /** Пояснения, которые схемой не выразить: сколько вопросов, сколько вариантов. */
  shape: string;
  maxTokens?: number;
}

export interface AiResult<T> {
  data: T;
  provider: string;
  model: string;
}

export async function generateJson<T>(req: AiRequest<T>): Promise<AiResult<T>> {
  const reason = aiUnavailableReason();
  if (reason) throw new AiError(reason, 'ai_disabled');
  if (AI_PROVIDER === 'anthropic') return viaAnthropic(req);

  // Имена полей платформа гарантирует, а «не меньше трёх вопросов» — нет: это
  // ограничение проверяет наша схема. Разовый недобор лечится повтором дешевле,
  // чем показом ошибки человеку, который ни в чём не виноват.
  try {
    return await viaGroq(req);
  } catch (e) {
    if (e instanceof AiError && e.code === 'ai_bad_shape') return viaGroq(req);
    throw e;
  }
}

// ---------------------------------------------------------------- Claude

async function viaAnthropic<T>(req: AiRequest<T>): Promise<AiResult<T>> {
  // Импорт внутри функции: на бесплатном режиме библиотека не нужна и не грузится.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const response = await client.messages.parse({
    model: ANTHROPIC_MODEL,
    max_tokens: req.maxTokens ?? 16000,
    system: req.system,
    messages: [{ role: 'user', content: `${req.user}

Форма ответа:
${req.shape}` }],
    output_config: { format: zodOutputFormat(req.schema as any) },
  });

  // parsed_output пустой, если разобрать не удалось — молча продолжать нельзя.
  if (!response.parsed_output) throw new AiError('Модель вернула ответ не той формы');
  return { data: response.parsed_output as T, provider: 'anthropic', model: ANTHROPIC_MODEL };
}

// ------------------------------------------------------------------ Groq

async function viaGroq<T>(req: AiRequest<T>): Promise<AiResult<T>> {
  // Схему навязываем самой платформе. Без этого модель придумывает свои имена
  // полей: на настоящем регламенте она вернула «content» вместо «material»
  // и добавила поле, которого в форме нет.
  const body = {
    model: GROQ_MODEL,
    max_tokens: req.maxTokens ?? 8000,
    temperature: 0.3,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema: req.jsonSchema },
    },
    messages: [
      { role: 'system', content: `${req.system}\n\n${req.shape}` },
      { role: 'user', content: req.user },
    ],
  };

  let res: Response;
  try {
    res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e: any) {
    throw new AiError(
      e?.name === 'TimeoutError' ? 'Модель не ответила за две минуты' : 'Не удалось связаться с Groq',
      'ai_unreachable',
    );
  }

  if (res.status === 429) {
    throw new AiError('Бесплатный лимит Groq исчерпан — попробуйте позже', 'ai_rate_limited');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AiError(`Groq ответил ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new AiError('Пустой ответ модели');

  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch {
    throw new AiError('Модель вернула не JSON');
  }

  const parsed = req.schema.safeParse(raw);
  if (!parsed.success) {
    // HR это чинить не может, а тому, кто настраивает сервер, нужна причина:
    // «не та форма» без подробностей отлаживается вслепую.
    console.error('[ai] ответ не прошёл схему:',
      JSON.stringify(parsed.error.issues.slice(0, 5)));
    console.error('[ai] начало ответа:', JSON.stringify(raw).slice(0, 500));
    throw new AiError('Модель вернула ответ не той формы — попробуйте ещё раз', 'ai_bad_shape');
  }
  return { data: parsed.data, provider: 'groq', model: GROQ_MODEL };
}

/** Модели поменьше любят обернуть JSON в ```json — снимаем обёртку. */
function stripCodeFence(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s);
  return m ? m[1] : s;
}

export const aiInfo = () => ({
  enabled: aiEnabled(),
  provider: AI_PROVIDER,
  model: AI_PROVIDER === 'anthropic' ? ANTHROPIC_MODEL : AI_PROVIDER === 'groq' ? GROQ_MODEL : null,
  reason: aiUnavailableReason(),
  /** Читает ли провайдер PDF и картинки сам, без сторонних библиотек. */
  reads_documents: AI_PROVIDER === 'anthropic',
});

export { z };
