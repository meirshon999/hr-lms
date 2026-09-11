import { getState, setState } from '../db.ts';
import { isSealed, open, seal } from '../secretbox.ts';
import {
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL, GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL,
  AI_PROVIDER_ENV,
} from '../config.ts';

/**
 * НАСТРОЙКИ ИИ: ключ можно задать и в переменных сервера, и в интерфейсе.
 *
 * Зачем два пути. Переменная окружения — это решение того, кто ставил систему.
 * Но добраться до неё может только человек с доступом к серверу, а платить за
 * ИИ будет тот, кто системой пользуется. Поэтому ключ можно вписать прямо в
 * настройках, и тогда серверный не нужен вовсе.
 *
 * Что победит, если заданы оба: **ключ из настроек**. Иначе владелец системы
 * не смог бы перейти на свой ключ, не позвав разработчика, — а ради этого всё
 * и затевалось. Откуда взят действующий ключ, на экране написано.
 *
 * Ключ наружу не отдаётся никогда: в ответах API от него остаются последние
 * четыре знака — ровно чтобы человек узнал свой ключ и не более того.
 *
 * В базе ключ лежит зашифрованным на `TOKEN_SECRET` (см. `secretbox.ts`).
 * Причина простая: продукт переезжает копированием файла базы, и незашифрованный
 * ключ уехал бы вместе с копией — в резервную копию, к разработчику, куда
 * угодно. Копия базы без серверной переменной ключа не отдаст.
 */

export type AiProvider = 'off' | 'groq' | 'openai' | 'anthropic';

const PROVIDERS: AiProvider[] = ['off', 'groq', 'openai', 'anthropic'];

/** Что известно про каждого провайдера. Модели меняются — держим здесь, не в коде. */
export const PROVIDER_INFO: Record<Exclude<AiProvider, 'off'>, {
  title: string;
  /** Совместим с форматом OpenAI: один и тот же код запроса. */
  openaiCompatible: boolean;
  baseUrl: string;
  defaultModel: string;
  free: boolean;
  /** Читает ли PDF и картинки как есть, без пересохранения в .docx. */
  readsPdf: boolean;
  note: string;
  /** Где человек заводит свой ключ — без этого «вставьте ключ» бесполезный совет. */
  consoleUrl: string;
  /** Как ключ начинается: чтобы не вставили не то, что скопировали. */
  keyPrefix: string;
  /** Чего ждать по деньгам. Без цифр: тарифы меняются, а зашитая цифра врёт. */
  price: string;
}> = {
  groq: {
    title: 'Groq',
    openaiCompatible: true,
    baseUrl: GROQ_BASE_URL,
    defaultModel: GROQ_MODEL,
    free: true,
    readsPdf: false,
    note: 'Бесплатный тариф с дневными лимитами. PDF не читает — документ нужно сохранить как .docx.',
    consoleUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
    price: 'Бесплатно. Карту привязывать не нужно.',
  },
  openai: {
    title: 'OpenAI (ChatGPT)',
    openaiCompatible: true,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    free: false,
    readsPdf: false,
    note: 'Платно по расходу. PDF не читает — документ нужно сохранить как .docx.',
    consoleUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
    price: 'Платно по расходу. Нужна карта и пополненный баланс в кабинете.',
  },
  anthropic: {
    title: 'Claude',
    openaiCompatible: false,
    baseUrl: '',
    defaultModel: ANTHROPIC_MODEL,
    free: false,
    readsPdf: true,
    note: 'Платно по расходу. Читает PDF как есть — даже скан, где текста в файле нет.',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
    price: 'Платно по расходу. Нужна карта и пополненный баланс в кабинете.',
  },
};

export interface AiSettings {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  openaiCompatible: boolean;
  /** Откуда взят действующий ключ. */
  source: 'settings' | 'env' | 'none';
  /**
   * Ключ в базе есть, но расшифровать его не вышло: база приехала с другого
   * сервера или сменили `TOKEN_SECRET`. Не поломка — так и задумано, но
   * человеку надо сказать, почему ИИ вдруг молчит.
   */
  keyUnreadable: boolean;
}

const OFF: AiSettings = {
  provider: 'off', apiKey: '', model: '', baseUrl: '', openaiCompatible: false,
  source: 'none', keyUnreadable: false,
};

const isProvider = (v: string): v is AiProvider => (PROVIDERS as string[]).includes(v);

/** Настройки из базы, если их задали в интерфейсе. */
function fromDb(): AiSettings | null {
  const provider = (getState('ai.provider') ?? '').trim();
  if (!provider || !isProvider(provider)) return null;
  if (provider === 'off') return { ...OFF, source: 'settings' };

  const stored = getState('ai.api_key');
  if (!stored) return null; // выбран провайдер, но ключа нет — считаем, что не настроено

  // Старые базы могли хранить ключ открытым — принимаем и их, но при первой же
  // записи он ляжет зашифрованным.
  const apiKey = (isSealed(stored) ? open(stored) : stored)?.trim() ?? '';
  if (!apiKey) {
    return { ...OFF, provider, source: 'settings', keyUnreadable: true };
  }

  const info = PROVIDER_INFO[provider];
  return {
    provider,
    apiKey,
    model: (getState('ai.model') ?? '').trim() || info.defaultModel,
    baseUrl: info.baseUrl,
    openaiCompatible: info.openaiCompatible,
    source: 'settings',
    keyUnreadable: false,
  };
}

/** Настройки с сервера: то, что задано переменными окружения. */
function fromEnv(): AiSettings {
  const named = AI_PROVIDER_ENV;
  if (named === 'off') return { ...OFF, source: 'env' };

  const pick: Exclude<AiProvider, 'off'> | null =
    named === 'anthropic' || named === 'groq' || named === 'openai' ? named
      : ANTHROPIC_API_KEY ? 'anthropic'
        : GROQ_API_KEY ? 'groq'
          : null;
  if (!pick) return OFF;

  const key = pick === 'anthropic' ? ANTHROPIC_API_KEY : GROQ_API_KEY;
  if (!key) return OFF;

  const info = PROVIDER_INFO[pick];
  return {
    provider: pick,
    apiKey: key,
    model: pick === 'anthropic' ? ANTHROPIC_MODEL : GROQ_MODEL,
    baseUrl: info.baseUrl,
    openaiCompatible: info.openaiCompatible,
    source: 'env',
    keyUnreadable: false,
  };
}

/**
 * Действующие настройки. Читаются на каждый запрос, а не один раз при старте:
 * ключ меняют в интерфейсе, и перезапускать ради этого сервер было бы
 * издевательством.
 */
export function aiSettings(): AiSettings {
  return fromDb() ?? fromEnv();
}

export interface SavePatch {
  provider: AiProvider;
  /** Пусто — прежний ключ остаётся; так меняют модель, не трогая ключ. */
  api_key?: string;
  model?: string;
}

export function saveAiSettings(p: SavePatch) {
  setState('ai.provider', p.provider);
  if (p.api_key !== undefined && p.api_key.trim()) setState('ai.api_key', seal(p.api_key.trim()));
  if (p.provider === 'off') setState('ai.api_key', '');
  if (p.model !== undefined) setState('ai.model', p.model.trim());
}

/** Убрать настройку целиком — вернуться к тому, что задано на сервере. */
export function clearAiSettings() {
  setState('ai.provider', '');
  setState('ai.api_key', '');
  setState('ai.model', '');
}

/** Последние четыре знака — чтобы человек узнал свой ключ, и только. */
export const keyHint = (key: string) => (key.length > 8 ? `…${key.slice(-4)}` : key ? '…' : '');
