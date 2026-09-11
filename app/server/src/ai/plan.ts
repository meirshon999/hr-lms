import { z } from 'zod';
import { AI_MAX_SOURCE_CHARS } from '../config.ts';
import { AiError, generateJson } from './provider.ts';

/**
 * СБОРКА ЦЕЛОЙ ТРАЕКТОРИИ ИЗ ОДНОГО ДОКУМЕНТА.
 *
 * Кадровик приносит регламент целиком — модель предлагает, какие будут блоки,
 * какие в них уроки и из какого куска документа каждый урок вырастет.
 *
 * Почему в два прохода, а не «сделай всё сразу».
 *
 *   1. Сорокастраничный регламент в один запрос не влезает, а если влезет —
 *      качество разваливается: модель начинает пересказывать, а не учить.
 *   2. Одна ошибка в структуре рушит всё дерево, и человеку придётся разбирать
 *      сорок готовых уроков вместо десяти строк плана.
 *   3. План стоит копейки: модели уходит **оглавление**, а не текст.
 *
 * Поэтому здесь только структура. Содержимое уроков собирает `lesson.ts`,
 * по одному уроку из своего куска, и каждый проходит через глаза человека.
 *
 * Модель не переписывает текст, а **расставляет номера разделов по урокам**.
 * Это важно: придумать несуществующий раздел она не может, номер либо есть
 * в документе, либо запрос не проходит проверку.
 */

export interface Section {
  index: number;
  level: number;
  title: string;
  text: string;
  chars: number;
}

/** Куски без заголовков режем по этому размеру — примерно один урок. */
const CHUNK_CHARS = 2500;

/**
 * Документ — в пронумерованные разделы.
 *
 * Заголовки размечены при чтении docx (`# `, `## `). Если их нет вовсе —
 * документ режется по абзацам на куски сопоставимого размера: без этого
 * простая памятка из блокнота осталась бы одним разделом на весь текст.
 */
export function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const out: Section[] = [];
  let cur: { level: number; title: string; body: string[] } | null = null;

  const push = () => {
    if (!cur) return;
    const body = cur.body.join('\n').trim();
    if (body || cur.title) {
      out.push({
        index: out.length, level: cur.level, title: cur.title,
        text: body, chars: body.length,
      });
    }
    cur = null;
  };

  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      push();
      cur = { level: h[1].length, title: h[2].trim(), body: [] };
    } else {
      if (!cur) cur = { level: 0, title: '', body: [] };
      cur.body.push(line);
    }
  }
  push();

  const withHeadings = out.filter((s) => s.title);
  return withHeadings.length >= 2 ? out.filter((s) => s.text || s.title) : chunk(text);
}

/** Резка без заголовков: по абзацам, чтобы не рвать мысль на середине. */
function chunk(text: string): Section[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: Section[] = [];
  let buf: string[] = [];
  let size = 0;

  const flush = () => {
    if (!buf.length) return;
    const body = buf.join('\n\n');
    out.push({ index: out.length, level: 0, title: '', text: body, chars: body.length });
    buf = []; size = 0;
  };

  for (const p of paras) {
    if (size + p.length > CHUNK_CHARS && buf.length) flush();
    buf.push(p); size += p.length;
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ схема

const PlannedLesson = z.object({
  title: z.string().min(3).max(120),
  /** Номера разделов документа, из которых собирается этот урок. */
  sections: z.array(z.number().int().min(0)).min(1).max(20),
});

export const PlanSchema = z.object({
  blocks: z.array(z.object({
    title: z.string().min(2).max(120),
    lessons: z.array(PlannedLesson).min(1).max(20),
  })).min(1).max(12),
});

export type TrajectoryPlan = z.infer<typeof PlanSchema>;

const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'lessons'],
        properties: {
          title: { type: 'string' },
          lessons: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'sections'],
              properties: {
                title: { type: 'string' },
                sections: { type: 'array', items: { type: 'integer' } },
              },
            },
          },
        },
      },
    },
  },
};

const SHAPE = `Блоков от 2 до 8, уроков в блоке от 1 до 8.
sections — номера разделов из списка выше, целыми числами.
Каждый урок берёт от одного до нескольких соседних разделов.
Номера, которых нет в списке, использовать нельзя.`;

const SYSTEM = `Ты методист сети ресторанов Pingwin Premium. Тебе дают оглавление
внутреннего регламента, а ты предлагаешь, как разбить его на обучение для
нового сотрудника.

Правила:

1. Ты работаешь ТОЛЬКО со списком разделов, который дан. Не придумывай тем,
   которых в документе нет.
2. Блок — это смысловая часть пути: «Знакомство», «Работа с гостем», «Смена».
   Урок внутри блока — одна тема, которую можно пройти за десять минут.
3. Порядок должен быть учебным: сначала то, без чего не понять остальное.
4. Мелкие соседние разделы объединяй в один урок. Большой раздел можно
   разделить на два урока, если в нём явно две темы.
5. Названия — человеческие и по делу: «Открытие смены», а не «Раздел 3.2».
6. Не оставляй разделы без дела: у каждого должен найтись свой урок, кроме
   вводных и оглавлений.
7. Аттестацию отдельным блоком НЕ добавляй: она в траектории уже есть.`;

export interface PlanContext {
  positionName: string;
  /** Кто нажал кнопку — нужно только счётчику расхода. */
  actor?: string;
}

export async function buildTrajectoryPlan(source: string, ctx: PlanContext) {
  const text = source.trim();
  if (text.length < 500) {
    throw new AiError(
      'Для целой траектории нужен документ побольше — из пары абзацев '
      + 'выйдет один урок, соберите его кнопкой в самом уроке',
      'source_too_short',
    );
  }
  if (text.length > AI_MAX_SOURCE_CHARS) {
    throw new AiError(
      `Документ длиннее ${AI_MAX_SOURCE_CHARS} символов. Разбейте его на части — `
      + 'по одной должности или по одному направлению',
      'source_too_long',
    );
  }

  const sections = splitSections(text);
  if (sections.length < 2) {
    throw new AiError(
      'Документ не делится на разделы — в нём одна сплошная тема. '
      + 'Из такого выйдет один урок: соберите его кнопкой «Собрать ИИ» внутри урока. '
      + 'Если разделы в документе есть, пронумеруйте их («1. Приём смены») '
      + 'или оформите заголовками — тогда система их увидит.',
      'source_flat',
    );
  }

  // Раздел без текста — это просто заголовок, под которым сразу идёт следующий
  // заголовок. Содержания в нём нет, и предлагать его модели незачем: урок из
  // такого раздела вышел бы из одной строки названия.
  const usable = sections.filter((s) => s.chars > 0);
  if (usable.length < 2) {
    throw new AiError('В документе нет разделов с текстом — только заголовки', 'source_flat');
  }

  // Модели уходит оглавление, а не текст: этого хватает, чтобы разложить темы,
  // и запрос остаётся дешёвым даже на большом регламенте.
  const outline = usable
    .map((s) => `${s.index}. ${s.title || '(без заголовка)'} — ${s.chars} символов`)
    .join('\n');

  const result = await generateJson({
    system: SYSTEM,
    user:
      `Должность: «${ctx.positionName}».\n\n`
      + `Разделы документа:\n${outline}\n\n`
      + 'Предложи блоки и уроки для этой должности.',
    schema: PlanSchema,
    shape: SHAPE,
    jsonSchema: PLAN_JSON_SCHEMA,
    maxTokens: 8000,
    action: 'plan',
    actor: ctx.actor,
  });

  // Номер несуществующего или пустого раздела схемой не поймать — это уже
  // смысл, а не форма.
  const plan = clampSections(result.data, new Set(usable.map((s) => s.index)));
  return { ...result, data: plan, sections };
}

/**
 * Выбрасывает номера разделов, которых модели не давали, и уроки, у которых
 * после этого не осталось ни одного. Молча оставить такой номер нельзя:
 * дальше он превратился бы в урок из пустоты, а кадровик увидел бы пустое
 * поле там, где обещан кусок регламента.
 */
function clampSections(plan: TrajectoryPlan, allowed: Set<number>): TrajectoryPlan {
  const blocks = plan.blocks.map((b) => ({
    title: b.title,
    lessons: b.lessons
      .map((l) => ({
        ...l,
        sections: [...new Set(l.sections)].filter((i) => allowed.has(i)).sort((a, x) => a - x),
      }))
      .filter((l) => l.sections.length > 0),
  })).filter((b) => b.lessons.length > 0);

  if (blocks.length === 0) {
    throw new AiError('Модель предложила план из несуществующих разделов — попробуйте ещё раз');
  }
  return { blocks };
}

/** Текст урока по номерам разделов — то, из чего потом соберётся сам урок. */
export function sourceFor(sections: Section[], indices: number[]): string {
  return indices
    .map((i) => sections[i])
    .filter(Boolean)
    .map((s) => (s.title ? `${s.title}\n${s.text}` : s.text))
    .join('\n\n')
    .trim();
}
