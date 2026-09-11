import { z } from 'zod';
import { AI_MAX_SOURCE_CHARS } from '../config.ts';
import { AiError, generateJson } from './provider.ts';

/**
 * ФИНАЛЬНАЯ АТТЕСТАЦИЯ ОДНОЙ КНОПКОЙ.
 *
 * Собирается по материалам всех уроков траектории. Главное правило здесь одно
 * и оно не про экономию запросов:
 *
 *   **Вопросы аттестации должны отличаться от вопросов уроков.**
 *
 * Если повторить те же самые, аттестация проверит не понимание, а память
 * на уже виденные ответы: человек прошёл эти тесты час назад и знает, какой
 * вариант верный. Поэтому модели отдельно показывают, что уже спрашивалось,
 * и просят спросить о том же иначе — ситуацией, а не формулировкой.
 *
 * Второе отличие от урочного теста: аттестация имеет право связывать темы.
 * В уроке про рассадку спрашивают про рассадку; в аттестации — что делать,
 * когда стол занят, гость с ребёнком, а на кухне стоп-лист.
 */

const QuestionSchema = z.object({
  text: z.string().min(10).max(400),
  options: z.array(z.string().min(1).max(200)).min(3).max(5),
  correct_index: z.number().int().min(0).max(4),
});

/** Что просим у модели: меньше пяти вопросов — это не аттестация. */
export const AttestationSchema = z.object({
  questions: z.array(QuestionSchema).min(5).max(20),
});

/**
 * Что принимаем от человека. Ограничение снизу здесь другое, и намеренно:
 * кадровик имеет право выбросить лишние вопросы и оставить три. Требовать
 * от него пять, когда ручной редактор тестов не требует ничего, значило бы
 * запретить правку ровно там, ради чего черновик и показывают.
 */
export const AttestationApplySchema = z.object({
  questions: z.array(QuestionSchema).min(1).max(50),
});

export type AttestationDraft = z.infer<typeof AttestationSchema>;

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'options', 'correct_index'],
        properties: {
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct_index: { type: 'integer' },
        },
      },
    },
  },
};

const SYSTEM = `Ты методист сети ресторанов Pingwin Premium. Ты составляешь
финальную аттестацию для сотрудника, который прошёл всё обучение.

Правила, которые нарушать нельзя:

1. Спрашивай ТОЛЬКО о том, что есть в материалах. Ситуацию придумать можно —
   но правило, по которому она решается, обязано быть в тексте дословно.
   НЕ выдумывай названий блюд, сумм, времени и цифр, которых в материалах нет:
   сотрудник ответит по регламенту и окажется «неправ» по выдуманному правилу.
   Если в материале сказано «после восемнадцати часов», в вопросе не может
   стоять двадцать.
2. Вопросы аттестации НЕ ПОВТОРЯЮТ вопросы уроков. Тебе дадут список уже
   заданных — о том же самом спрашивай другими словами и с другой стороны.
   Повтор бессмысленен: сотрудник видел эти вопросы час назад и помнит ответы.
3. Аттестация проверяет, сложилось ли всё вместе. Лучший вопрос — рабочая
   ситуация, где надо связать две темы сразу: «Стол у окна занят, гость
   с ребёнком, на кухне стоп-лист по горячему — с чего начинаешь».
4. Неверные варианты — то, как поступил бы человек, который учился невнимательно.
   Нелепые варианты превращают аттестацию в формальность.
5. Верный ответ ровно один и однозначно следует из материалов.
6. Язык русский, простой. Никаких «согласно пункту регламента».
7. Охватывай разные блоки обучения, а не один.`;

export interface AttestationContext {
  positionName: string;
  /** Материалы уроков: заголовок и текст. */
  lessons: Array<{ title: string; material: string }>;
  /** Что уже спрашивалось в уроках — чтобы не повторяться. */
  askedInLessons: string[];
  /** Сколько вопросов нужно. */
  count: number;
  /** Кто нажал кнопку — нужно только счётчику расхода. */
  actor?: string;
}

export async function buildAttestationDraft(ctx: AttestationContext) {
  const withText = ctx.lessons.filter((l) => l.material.trim().length > 50);
  if (withText.length < 2) {
    throw new AiError(
      'Для аттестации нужны заполненные уроки — соберите хотя бы два, '
      + 'иначе спрашивать не о чем',
      'source_too_short',
    );
  }

  // Материалы режем по общему пределу: у большой траектории они не влезут
  // целиком, а первые абзацы каждого урока несут главное.
  const perLesson = Math.max(400, Math.floor(AI_MAX_SOURCE_CHARS / withText.length) - 100);
  const materials = withText
    .map((l) => `### ${l.title}\n${l.material.trim().slice(0, perLesson)}`)
    .join('\n\n');

  const asked = ctx.askedInLessons.length
    ? `\n\nУЖЕ СПРАШИВАЛОСЬ В УРОКАХ (повторять нельзя):\n`
      + ctx.askedInLessons.map((q) => `— ${q}`).join('\n')
    : '';

  const result = await generateJson({
    system: SYSTEM,
    user:
      `Должность: «${ctx.positionName}». Уроков пройдено: ${withText.length}.\n\n`
      + `МАТЕРИАЛЫ ОБУЧЕНИЯ:\n${materials}${asked}\n\n`
      + `Составь ${ctx.count} вопросов финальной аттестации.`,
    schema: AttestationSchema,
    shape: `Вопросов ровно ${ctx.count}.\n`
      + 'У каждого от 3 до 5 вариантов, correct_index — номер верного, считая с нуля.\n'
      + 'Вопросы не должны совпадать с уже заданными в уроках ни по формулировке, ни по сути.',
    jsonSchema: JSON_SCHEMA,
    maxTokens: 16000,
    action: 'attestation',
    actor: ctx.actor,
  });

  for (const q of result.data.questions) {
    if (q.correct_index >= q.options.length) {
      throw new AiError('Модель отметила верным несуществующий вариант — попробуйте ещё раз');
    }
  }

  // Отдаём число уроков, которые ДАЛИ материал, а не число общих уроков:
  // сказать «собрано по семи урокам», когда текст был у трёх, — обмануть
  // человека ровно в том месте, где он решает, доверять ли результату.
  return { ...result, data: shuffle(result.data), basedOn: withText.length };
}

/** Убирает позиционную подсказку: модели любят ставить верный ответ первым. */
function shuffle(draft: AttestationDraft): AttestationDraft {
  return {
    questions: draft.questions.map((q) => {
      const correct = q.options[q.correct_index];
      const opts = [...q.options];
      for (let i = opts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [opts[i], opts[j]] = [opts[j], opts[i]];
      }
      return { ...q, options: opts, correct_index: opts.indexOf(correct) };
    }),
  };
}

/**
 * Сколько вопросов просить. Пять уроков — десять вопросов, двадцать уроков —
 * не сорок: аттестация, которую проходят полчаса, превращается в мучение,
 * а лишние вопросы всё равно про то же самое.
 */
export function suggestedCount(lessonCount: number): number {
  return Math.min(20, Math.max(5, lessonCount * 2));
}
