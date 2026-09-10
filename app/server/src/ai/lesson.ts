import { z } from 'zod';
import { AI_MAX_SOURCE_CHARS } from '../config.ts';
import { AiError, generateJson } from './provider.ts';

/**
 * СБОРКА УРОКА ИЗ ИСХОДНИКА.
 *
 * На вход — регламент как есть, на выход — черновик урока: текст для сотрудника
 * и тест по нему. В каталог ничего не попадает: черновик уходит HR на проверку,
 * и только его нажатие превращает черновик в урок (правило C-13).
 *
 * Причина жёсткая: по тонкому исходнику модель напишет правдоподобный и неверный
 * тест, а заметить это может только человек, который знает, как на точке на самом
 * деле устроена смена.
 */

const QuestionSchema = z.object({
  text: z.string().min(5).max(400),
  options: z.array(z.string().min(1).max(200)).min(3).max(5),
  correct_index: z.number().int().min(0).max(4),
});

export const DraftSchema = z.object({
  title: z.string().min(3).max(120),
  material: z.string().min(50),
  questions: z.array(QuestionSchema).min(3).max(10),
});

export type LessonDraft = z.infer<typeof DraftSchema>;

const SYSTEM = `Ты методист сети ресторанов Pingwin Premium. Ты превращаешь внутренние
регламенты в уроки для новых сотрудников.

Правила, которые нарушать нельзя:

1. Пиши ТОЛЬКО о том, что есть в исходнике. Ничего не додумывай: ни цифр, ни
   названий, ни правил. Если в исходнике чего-то нет — этого нет и в уроке.
2. Язык — русский, простой и живой. Сотрудник читает это с телефона в подсобке,
   а не изучает за столом. Короткие абзацы, никаких канцеляризмов.
3. Материал — связный текст, а не пересказ пунктов. Начни с того, зачем это нужно
   на смене, потом суть по порядку.
4. Вопросы проверяют ПОНИМАНИЕ, а не память на формулировки. Плохой вопрос:
   «Как называется пункт 3.2 регламента». Хороший: «Гость просит заменить блюдо
   через двадцать минут после подачи — что делаешь».
5. Неверные варианты должны быть правдоподобными: так поступил бы человек,
   который регламент не читал. Нелепые варианты превращают тест в формальность.
6. Верный ответ ровно один, и он должен однозначно следовать из исходника.
7. Если исходник слишком беден для теста — сделай меньше вопросов, но не выдумывай.`;

/** Убирает позиционную подсказку: модели любят ставить верный ответ первым. */
function shuffleOptions(draft: LessonDraft): LessonDraft {
  return {
    ...draft,
    questions: draft.questions.map((q) => {
      const correct = q.options[q.correct_index];
      const shuffled = [...q.options];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return { ...q, options: shuffled, correct_index: shuffled.indexOf(correct) };
    }),
  };
}

export interface DraftContext {
  /** Название урока в каркасе — модель должна попасть в тему, а не пересказать всё. */
  lessonTitle: string;
  /** Должность, для которой урок: официанту и кассиру нужно разное. */
  positionName?: string | null;
  /** Точка, если урок точечный: тогда в тексте уместны её особенности. */
  locationName?: string | null;
}

export async function buildLessonDraft(source: string, ctx: DraftContext) {
  const text = source.trim();
  if (text.length < 200) {
    throw new AiError('Исходник слишком короткий — из него не выйдет урока', 'source_too_short');
  }
  if (text.length > AI_MAX_SOURCE_CHARS) {
    throw new AiError(
      `Исходник длиннее ${AI_MAX_SOURCE_CHARS} символов. Разбейте его на части — ` +
      'один урок про одно, так и учить легче',
      'source_too_long',
    );
  }

  const about = [
    `Урок называется «${ctx.lessonTitle}».`,
    ctx.positionName ? `Он для должности «${ctx.positionName}».` : '',
    ctx.locationName ? `Это урок точки «${ctx.locationName}» — пиши про неё.` : '',
  ].filter(Boolean).join(' ');

  const result = await generateJson({
    system: SYSTEM,
    user:
      `${about}\n\nСобери из регламента ниже материал урока и тест к нему. ` +
      'Заголовок оставь близким к названию урока.\n\n' +
      `--- РЕГЛАМЕНТ ---\n${text}\n--- КОНЕЦ ---`,
    schema: DraftSchema,
  });

  // Проверка формы уже прошла в слое провайдера, но верный ответ мог указать
  // на несуществующий вариант — это не форма, это смысл.
  for (const q of result.data.questions) {
    if (q.correct_index >= q.options.length) {
      throw new AiError('Модель отметила верным несуществующий вариант — попробуйте ещё раз');
    }
  }

  return { ...result, data: shuffleOptions(result.data) };
}
