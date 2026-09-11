import { z } from 'zod';
import { AI_MAX_SOURCE_CHARS } from '../config.ts';
import { AiError, generateJson } from './provider.ts';

/**
 * МАТЕРИАЛЫ «О КОМПАНИИ» — ПРЕ-ОНБОРДИНГ.
 *
 * Это то, что человек читает между «меня взяли» и «я вышел на смену»: чем
 * занимается сеть, как устроены площадки, что от него ждут. Тестов здесь нет
 * намеренно — проверять человека до выхода на работу не за что.
 *
 * Отличие от уроков не в объёме, а в тоне. Урок учит делать, пре-онбординг
 * знакомит: он должен быть коротким, дружелюбным и без регламентных оборотов.
 * Поэтому отдельный запрос со своими правилами, а не «те же уроки, но без теста».
 */

export const PreSchema = z.object({
  items: z.array(z.object({
    title: z.string().min(3).max(120),
    text: z.string().min(80).max(4000),
  })).min(2).max(8),
});

export type PreOnboarding = z.infer<typeof PreSchema>;

const PRE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'text'],
        properties: { title: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
};

const SHAPE = `Материалов от 2 до 6. У каждого заголовок и текст.
Текст — от 80 до 1500 знаков, обычными абзацами, без списков из одного слова.`;

const SYSTEM = `Ты готовишь материалы знакомства с компанией для человека, которого
только что приняли на работу в сеть развлечений Pingwin Premium (рестораны,
боулинг, караоке). Он прочитает это дома, до первой смены.

Правила:

1. Пиши ТОЛЬКО по присланному документу. Ничего не выдумывай: ни цифр, ни
   названий, ни обещаний. Нет в документе — нет в тексте.
2. Тон — человеческий, на «вы», без канцелярита и без «настоящим уведомляем».
   Это знакомство, а не приказ.
3. Каждый материал — одна мысль: чем занимается сеть, как устроены площадки,
   чего ждут от новичка в первый день.
4. Не пиши про обязанности конкретной должности и про порядок работы: это
   уроки, они будут потом.
5. Вопросов и тестов не добавляй — их здесь не бывает.
6. Заголовок называет содержание: «Три формата под одной крышей», а не
   «Материал 2».`;

export interface PreContext {
  /** Кто нажал кнопку — нужно только счётчику расхода. */
  actor?: string;
}

export async function buildPreOnboarding(source: string, ctx: PreContext = {}) {
  const text = source.trim();
  if (text.length < 300) {
    throw new AiError(
      'Для материалов о компании нужен документ побольше — хотя бы страница',
      'source_too_short',
    );
  }
  if (text.length > AI_MAX_SOURCE_CHARS) {
    throw new AiError(
      `Документ длиннее ${AI_MAX_SOURCE_CHARS} символов — разбейте его на части`,
      'source_too_long',
    );
  }

  return generateJson({
    system: SYSTEM,
    user: `Документ о компании:\n\n${text}`,
    schema: PreSchema,
    jsonSchema: PRE_JSON_SCHEMA,
    shape: SHAPE,
    maxTokens: 8000,
    action: 'pre',
    actor: ctx.actor,
  });
}
