import { z, type ZodType } from 'zod';
import { aiSettings, PROVIDER_INFO, type AiSettings } from './settings.ts';
import { recordUsage } from './usage.ts';

/**
 * СЛОЙ ПРОВАЙДЕРА ИИ.
 *
 * Наружу торчит одна функция: «вот текст и вот форма ответа — верни объект этой
 * формы». Кто именно его вернул, Groq, OpenAI или Claude, вызывающий код не знает.
 * Поэтому смена провайдера — правка настройки, а не кода.
 *
 * Почему разные способы обращения. У Groq и OpenAI формат запроса одинаковый —
 * их обслуживает один и тот же код, различаются только адрес, ключ и модель.
 * К Claude идём через официальный SDK: у него структурированный ответ — часть
 * протокола, модель физически не может вернуть поле не той формы.
 */

export class AiError extends Error {
  constructor(message: string, readonly code: string = 'ai_failed') {
    super(message);
  }
}

export const aiEnabled = () => aiSettings().provider !== 'off' && !!aiSettings().apiKey;

/** Что показать HR, если функция не работает. Причина всегда в настройке. */
export function aiUnavailableReason(): string | null {
  const s = aiSettings();
  // Отдельный случай: ключ в базе есть, но он не наш — база приехала с другого
  // сервера. Молчать нельзя, иначе ИИ «просто не работает» без объяснений.
  if (s.keyUnreadable) {
    return 'Сохранённый ключ задан на другом сервере и здесь не читается — вставьте свой в разделе «Настройки»';
  }
  if (s.provider === 'off') {
    return s.source === 'settings'
      ? 'ИИ выключен в настройках'
      : 'ИИ не настроен: вставьте ключ в разделе «Настройки»';
  }
  if (!s.apiKey) return 'ИИ не настроен: нет ключа';
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
   * Та же форма как JSON Schema. У Claude схему навязывает SDK, у остальных —
   * response_format. Без неё модель придумывает свои имена полей: на этом
   * регламенте она вернула «content» вместо «material» и лишнее поле сверху.
   */
  jsonSchema: Record<string, unknown>;
  /** Пояснения, которые схемой не выразить: сколько вопросов, сколько вариантов. */
  shape: string;
  maxTokens?: number;
  /** Вид работы и кто её заказал — только для счётчика расхода. */
  action?: string;
  actor?: string;
}

export interface AiResult<T> {
  data: T;
  provider: string;
  model: string;
  /** Сколько токенов стоило обращение. Провайдер может их не прислать — тогда ноль. */
  tokensIn: number;
  tokensOut: number;
}

export async function generateJson<T>(req: AiRequest<T>): Promise<AiResult<T>> {
  const reason = aiUnavailableReason();
  if (reason) throw new AiError(reason, 'ai_disabled');

  const s = aiSettings();
  const note = (r: AiResult<T> | null, ok: boolean) => recordUsage({
    actor: req.actor ?? 'system',
    action: req.action ?? 'lesson',
    provider: s.provider,
    model: s.model,
    tokensIn: r?.tokensIn ?? 0,
    tokensOut: r?.tokensOut ?? 0,
    ok,
  });

  try {
    if (s.provider === 'anthropic') {
      const r = await viaAnthropic(req, s);
      note(r, true);
      return r;
    }
    // Имена полей платформа гарантирует, а «не меньше трёх вопросов» — нет: это
    // ограничение проверяет наша схема. Разовый недобор лечится повтором дешевле,
    // чем показом ошибки человеку, который ни в чём не виноват.
    let r: AiResult<T>;
    try {
      r = await viaOpenAiFormat(req, s);
    } catch (e) {
      if (!(e instanceof AiError) || e.code !== 'ai_bad_shape') throw e;
      // Неудачная попытка провайдеру тоже оплачена — считаем и её.
      note(null, false);
      r = await viaOpenAiFormat(req, s);
    }
    note(r, true);
    return r;
  } catch (e) {
    note(null, false);
    throw e;
  }
}

// ---------------------------------------------------------------- Claude

async function viaAnthropic<T>(req: AiRequest<T>, s: AiSettings): Promise<AiResult<T>> {
  // Импорт внутри функции: на бесплатном режиме библиотека не нужна и не грузится.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');

  const client = new Anthropic({ apiKey: s.apiKey });
  const response = await client.messages.parse({
    model: s.model,
    max_tokens: req.maxTokens ?? 16000,
    system: req.system,
    messages: [{ role: 'user', content: `${req.user}\n\nФорма ответа:\n${req.shape}` }],
    output_config: { format: zodOutputFormat(req.schema as any) },
  });

  // parsed_output пустой, если разобрать не удалось — молча продолжать нельзя.
  if (!response.parsed_output) throw new AiError('Модель вернула ответ не той формы');
  return {
    data: response.parsed_output as T,
    provider: 'anthropic',
    model: s.model,
    tokensIn: response.usage?.input_tokens ?? 0,
    tokensOut: response.usage?.output_tokens ?? 0,
  };
}

/**
 * ЧТЕНИЕ PDF ГЛАЗАМИ МОДЕЛИ.
 *
 * Свой разбор PDF мы не пишем: текстовый слой там сжат, разбит на куски по
 * координатам и у сканов отсутствует вовсе — а регламент, распечатанный и
 * отсканированный, это ровно тот случай, ради которого всё и нужно. Claude
 * принимает PDF как есть, вместе с картинками и таблицами, и отдаёт текст.
 *
 * Работает только на ключе Claude. У Groq и OpenAI такого приёма нет, и врать
 * про это нельзя — им мы честно говорим «сохраните как .docx».
 */
export async function readPdf(file: Buffer, actor: string): Promise<{ text: string }> {
  const s = aiSettings();
  if (s.provider !== 'anthropic') {
    throw new AiError(
      'PDF читает только Claude. Сейчас подключён другой провайдер — '
      + 'откройте документ в Word и сохраните как .docx, либо вставьте текст.',
      'doc_pdf',
    );
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: s.apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: s.model,
      max_tokens: 16000,
      system:
        'Ты переносишь документ в текст. Верни только текст документа, без своих '
        + 'пояснений и без разметки. Заголовки разделов оставляй отдельными строками. '
        + 'Таблицы переноси строками, значения через « | ». Ничего не придумывай и '
        + 'ничего не пропускай.',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: file.toString('base64') },
          },
          { type: 'text', text: 'Перенеси этот документ в текст целиком.' },
        ],
      }],
    });
  } catch (e: any) {
    recordUsage({ actor, action: 'pdf', provider: s.provider, model: s.model, tokensIn: 0, tokensOut: 0, ok: false });
    const status = e?.status;
    if (status === 401 || status === 403) {
      throw new AiError('Ключ не принят провайдером — проверьте его в настройках', 'ai_bad_key');
    }
    if (status === 429) throw new AiError('Лимит провайдера исчерпан — попробуйте позже', 'ai_rate_limited');
    console.error('[ai] чтение PDF:', e?.message ?? e);
    throw new AiError('Не удалось прочитать PDF — попробуйте ещё раз или сохраните как .docx', 'doc_failed');
  }

  recordUsage({
    actor, action: 'pdf', provider: s.provider, model: s.model,
    tokensIn: response.usage?.input_tokens ?? 0,
    tokensOut: response.usage?.output_tokens ?? 0,
    ok: true,
  });

  const text = response.content
    .filter((c): c is { type: 'text'; text: string } & typeof c => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  return { text };
}

// ------------------------------------------------- Groq, OpenAI и им подобные

async function viaOpenAiFormat<T>(req: AiRequest<T>, s: AiSettings): Promise<AiResult<T>> {
  // Схему навязываем самой платформе. Без этого модель придумывает свои имена
  // полей: на настоящем регламенте она вернула «content» вместо «material»
  // и добавила поле, которого в форме нет.
  //
  // Рассуждающие модели тратят часть ответа на размышления вслух, и они идут
  // в тот же лимит, что и сам ответ. На длинном регламенте размышления съедали
  // весь запас, ответ приходил пустым, и провайдер отвечал 400 «не удалось
  // проверить JSON» с пустым текстом. Отсюда две меры: просим думать коротко —
  // замерено, размышления падают с 1600 символов до 120, а урок выходит полнее —
  // и держим запас вдвое больше прежнего.
  const body: Record<string, unknown> = {
    model: s.model,
    max_tokens: req.maxTokens ?? 16000,
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
  // Настройку понимают только модели gpt-oss; остальные на неё ругаются.
  if (s.model.includes('gpt-oss')) body.reasoning_effort = 'low';

  let res: Response;
  try {
    res = await fetch(`${s.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e: any) {
    throw new AiError(
      e?.name === 'TimeoutError' ? 'Модель не ответила за две минуты' : 'Не удалось связаться с провайдером',
      'ai_unreachable',
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new AiError('Ключ не принят провайдером — проверьте его в настройках', 'ai_bad_key');
  }
  if (res.status === 429) {
    throw new AiError('Лимит провайдера исчерпан — попробуйте позже', 'ai_rate_limited');
  }
  if (!res.ok) {
    // Ответ провайдера — английский JSON про схемы и токены. HR он ничего
    // не объясняет и только пугает, поэтому подробности уходят в журнал
    // сервера, а человеку достаётся понятная фраза.
    const detail = await res.text().catch(() => '');
    console.error(`[ai] ${s.provider} ${res.status}: ${detail.slice(0, 500)}`);
    // Модель не уложилась в форму — то же самое, что ответ, не прошедший схему,
    // и лечится тем же повтором.
    if (detail.includes('json_validate_failed')) {
      throw new AiError(
        'Модель не смогла собрать урок из этого текста — попробуйте ещё раз '
        + 'или дайте более подробный исходник',
        'ai_bad_shape',
      );
    }
    if (detail.includes('model_not_found') || detail.includes('does not exist')) {
      throw new AiError(`Модель «${s.model}» провайдеру неизвестна — впишите другую в настройках`, 'ai_bad_model');
    }
    throw new AiError(`Провайдер ответил ошибкой ${res.status} — подробности в журнале сервера`);
  }

  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  // Пустой ответ — не поломка связи, а неудачная попытка: даём ей второй шанс.
  if (typeof text !== 'string' || !text.trim()) {
    console.error('[ai] пустой ответ, finish_reason:', json?.choices?.[0]?.finish_reason);
    throw new AiError('Модель вернула пустой ответ — попробуйте ещё раз', 'ai_bad_shape');
  }

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
  return {
    data: parsed.data,
    provider: s.provider,
    model: s.model,
    tokensIn: json?.usage?.prompt_tokens ?? 0,
    tokensOut: json?.usage?.completion_tokens ?? 0,
  };
}

/** Модели поменьше любят обернуть JSON в ```json — снимаем обёртку. */
function stripCodeFence(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s);
  return m ? m[1] : s;
}

export const aiInfo = () => {
  const s = aiSettings();
  return {
    enabled: aiEnabled(),
    provider: s.provider,
    model: s.provider === 'off' ? null : s.model,
    reason: aiUnavailableReason(),
    /** Читает ли провайдер PDF и картинки сам, без сторонних библиотек. */
    reads_documents: s.provider === 'anthropic',
    /** Откуда взят ключ — чтобы админ понимал, что он меняет. */
    source: s.source,
  };
};

/**
 * Живая проверка ключа. Без неё человек вставляет ключ, закрывает настройки
 * и узнаёт о неверном ключе через неделю, когда впервые нажмёт «Собрать».
 */
export async function testConnection(actor = 'system'): Promise<{ ok: true; provider: string; model: string }> {
  const s = aiSettings();
  const reason = aiUnavailableReason();
  if (reason) throw new AiError(reason, 'ai_disabled');

  const Ping = z.object({ ok: z.boolean() });
  await generateJson({
    system: 'Ты отвечаешь строго в заданной форме.',
    user: 'Верни ok = true.',
    schema: Ping,
    shape: 'Поле ok должно быть true.',
    jsonSchema: {
      type: 'object', additionalProperties: false,
      required: ['ok'], properties: { ok: { type: 'boolean' } },
    },
    maxTokens: 2000,
    action: 'test',
    actor,
  });
  return { ok: true, provider: PROVIDER_INFO[s.provider as 'groq'].title, model: s.model };
}

export { z };
