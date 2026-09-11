import { getState, setState } from '../db.ts';
import {
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL, GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL,
  GROQ_STT_MODEL, STT_LANGUAGE, STT_PROVIDER_ENV, AI_PROVIDER_ENV,
} from '../config.ts';

/**
 * НАСТРОЙКИ ИИ: ключ можно задать и в переменных сервера, и в интерфейсе.
 *
 * Зачем два пути. Переменная окружения — это решение того, кто ставил систему;
 * она безопаснее, потому что ключ не попадает ни в базу, ни в резервные копии.
 * Но добраться до неё может только человек с доступом к серверу, а платить за
 * ИИ будет тот, кто системой пользуется. Поэтому админ может вписать свой ключ
 * прямо в настройках, и тогда серверный не нужен вовсе.
 *
 * Что победит, если заданы оба: **ключ из настроек**. Иначе владелец системы
 * не смог бы перейти на свой ключ, не позвав разработчика, — а ради этого всё
 * и затевалось. Откуда взят действующий ключ, на экране написано.
 *
 * Ключ наружу не отдаётся никогда. В базе он лежит целиком (иначе им нечем
 * пользоваться), но в ответах API от него остаются последние четыре знака —
 * ровно чтобы человек узнал свой ключ и не более того.
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
  /** Модель расшифровки речи; пусто — провайдер звук не принимает. */
  sttModel: string;
  free: boolean;
  note: string;
}> = {
  groq: {
    title: 'Groq',
    openaiCompatible: true,
    baseUrl: GROQ_BASE_URL,
    defaultModel: GROQ_MODEL,
    sttModel: GROQ_STT_MODEL,
    free: true,
    note: 'Бесплатный тариф с лимитами. Умеет расшифровывать речь. Документы не читает.',
  },
  openai: {
    title: 'OpenAI (ChatGPT)',
    openaiCompatible: true,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    sttModel: 'whisper-1',
    free: false,
    note: 'Платно по расходу. Умеет расшифровывать речь. Названия моделей меняются — если эта не подойдёт, впишите свою.',
  },
  anthropic: {
    title: 'Claude',
    openaiCompatible: false,
    baseUrl: '',
    defaultModel: ANTHROPIC_MODEL,
    sttModel: '',
    free: false,
    note: 'Платно по расходу. Читает PDF и картинки. Звук не принимает — для диктовки нужен ключ Groq или OpenAI.',
  },
};

export interface AiSettings {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  openaiCompatible: boolean;
  sttModel: string;
  sttLanguage: string;
  /** Откуда взят действующий ключ. */
  source: 'settings' | 'env' | 'none';
}

const OFF: AiSettings = {
  provider: 'off', apiKey: '', model: '', baseUrl: '', openaiCompatible: false,
  sttModel: '', sttLanguage: STT_LANGUAGE, source: 'none',
};

const isProvider = (v: string): v is AiProvider => (PROVIDERS as string[]).includes(v);

/** Настройки из базы, если админ их задал. */
function fromDb(): AiSettings | null {
  const provider = (getState('ai.provider') ?? '').trim();
  if (!provider || !isProvider(provider)) return null;
  if (provider === 'off') return { ...OFF, source: 'settings' };

  const apiKey = (getState('ai.api_key') ?? '').trim();
  if (!apiKey) return null; // выбран провайдер, но ключа нет — считаем, что не настроено

  const info = PROVIDER_INFO[provider];
  return {
    provider,
    apiKey,
    model: (getState('ai.model') ?? '').trim() || info.defaultModel,
    baseUrl: info.baseUrl,
    openaiCompatible: info.openaiCompatible,
    sttModel: info.sttModel,
    sttLanguage: STT_LANGUAGE,
    source: 'settings',
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
    sttModel: info.sttModel,
    sttLanguage: STT_LANGUAGE,
    source: 'env',
  };
}

/**
 * Действующие настройки. Читаются на каждый запрос, а не один раз при старте:
 * админ меняет ключ в интерфейсе, и перезапускать ради этого сервер было бы
 * издевательством.
 */
export function aiSettings(): AiSettings {
  return fromDb() ?? fromEnv();
}

/** Настройки расшифровки речи. Отдельно, потому что звук принимают не все. */
export function sttSettings(): { enabled: boolean; provider: string; model: string; language: string } {
  const s = aiSettings();
  // Явное «выключено» переменной сервера уважаем при любом провайдере.
  if (STT_PROVIDER_ENV === 'off') {
    return { enabled: false, provider: 'off', model: '', language: s.sttLanguage };
  }
  if (!s.apiKey || !s.sttModel) {
    return { enabled: false, provider: 'off', model: '', language: s.sttLanguage };
  }
  return { enabled: true, provider: s.provider, model: s.sttModel, language: s.sttLanguage };
}

export interface SavePatch {
  provider: AiProvider;
  /** Пусто — прежний ключ остаётся; так админ может сменить модель, не трогая ключ. */
  api_key?: string;
  model?: string;
}

export function saveAiSettings(p: SavePatch) {
  setState('ai.provider', p.provider);
  if (p.api_key !== undefined && p.api_key.trim()) setState('ai.api_key', p.api_key.trim());
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
