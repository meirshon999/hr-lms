import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT ?? 3001);
export const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'lms.db');

/** Боевой режим. Включается NODE_ENV=production — так же, как его ставит Dockerfile. */
export const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Демо-инструменты: подмена даты, полный сброс базы, список аккаунтов с паролями.
 * На боевом сервере выключены и физически недоступны, на тестовом включаются
 * переменной LMS_DEV_TOOLS=1. Один и тот же код на обеих машинах.
 */
export const DEV_TOOLS = process.env.LMS_DEV_TOOLS === '1';

/** Куда кладём загруженные HR файлы. */
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(__dirname, '..', 'uploads');
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 60);

/** Часовой пояс компании — все «сегодня» и дедлайны считаются в нём, не в UTC. */
export const TZ = process.env.TZ_LMS ?? 'Asia/Almaty';

/** Дедлайн онбординга: дата открытия + столько дней (SPEC §8 onboarding_days). */
export const ONBOARDING_DAYS = 14;

/**
 * Секрет для подписи токенов. В бою обязателен: без него сервер не поднимется.
 * Молча взять значение по умолчанию нельзя — известный секрет означает, что
 * токен любого пользователя может подделать кто угодно.
 */
export const TOKEN_SECRET = (() => {
  const s = process.env.TOKEN_SECRET;
  if (s && s.length >= 16) return s;
  if (IS_PROD) {
    throw new Error(
      'TOKEN_SECRET не задан или короче 16 символов. Задайте его в окружении: ' +
      'openssl rand -hex 32',
    );
  }
  return 'lms-local-dev-secret';
})();

export const TOKEN_TTL_HOURS = 12;

/**
 * Кто может обращаться к API из браузера. В бою — только свой домен.
 * Список через запятую: LMS_ORIGINS=https://lms.pingwin.kz,https://pingwin.kz
 * Пусто в бою означает «только тот же домен, откуда отдан фронт».
 */
export const CORS_ORIGINS = (process.env.LMS_ORIGINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * ИИ-конструктор. Провайдер переключается одной переменной, потому что смена
 * «бесплатно → платно» не должна означать правку кода.
 *
 *   off       — функции нет: кнопки не появляются, адреса отвечают 503
 *   groq      — бесплатный тариф, формат OpenAI, модели Llama
 *   anthropic — Claude: платно, но читает PDF и картинки без сторонних библиотек
 */
export type AiProvider = 'off' | 'groq' | 'anthropic';

// trim: ключ почти всегда попадает сюда вставкой из буфера, и лишний перевод
// строки на конце превращает рабочий ключ в 401 без единой подсказки почему.
export const GROQ_API_KEY = (process.env.GROQ_API_KEY ?? '').trim();
/** Названия моделей у Groq меняются — держим в переменной, а не в коде. */
export const GROQ_MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
export const GROQ_BASE_URL = process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1';

export const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY ?? '').trim();
export const ANTHROPIC_MODEL = process.env.LMS_AI_MODEL ?? 'claude-opus-5';

/**
 * Провайдер можно назвать явно, но если не назвали — выводим из того, какой ключ
 * задан. Иначе выходит ловушка: человек добавил ключ, всё выглядит настроенным,
 * а кнопок нет, потому что не хватает второй переменной, о которой он не знал.
 * Явный `off` выключает всегда.
 */
export const AI_PROVIDER = ((): AiProvider => {
  const v = (process.env.LMS_AI_PROVIDER ?? '').toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'groq' || v === 'anthropic') return v;
  if (ANTHROPIC_API_KEY) return 'anthropic';
  if (GROQ_API_KEY) return 'groq';
  return 'off';
})();

/**
 * РАСШИФРОВКА РЕЧИ — отдельный переключатель, и намеренно.
 *
 * У Claude нет входа для звука вообще. Если бы диктовка ходила через тот же
 * `LMS_AI_PROVIDER`, то переход на платный Claude ради качества уроков молча
 * ломал бы микрофон. Поэтому речь и текст разведены: уроки может собирать Claude,
 * а речь расшифровывать Groq — на том же бесплатном ключе.
 *
 * По умолчанию включается сам, если ключ Groq задан.
 */
export const STT_PROVIDER = ((): 'off' | 'groq' => {
  const v = (process.env.LMS_STT_PROVIDER ?? '').toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'groq') return 'groq';
  return GROQ_API_KEY ? 'groq' : 'off';
})();
export const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL ?? 'whisper-large-v3';
/** Язык материалов сети. Указанный язык заметно поднимает точность расшифровки. */
export const STT_LANGUAGE = process.env.LMS_STT_LANGUAGE ?? 'ru';
export const MAX_AUDIO_MB = Number(process.env.LMS_MAX_AUDIO_MB ?? 20);

/**
 * Предел исходника на один разбор. Ограничивает и счёт, и время ответа:
 * стостраничный документ модель будет жевать минуту, а HR будет смотреть в экран.
 */
export const AI_MAX_SOURCE_CHARS = Number(process.env.LMS_AI_MAX_CHARS ?? 40000);

/** Насколько в прошлом допустима дата выхода (SPEC §8 max_backdate_days). */
export const MAX_BACKDATE_DAYS = 30;

/** Защита входа от перебора пароля: сколько неудач с одного адреса за окно. */
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_MIN = 15;
