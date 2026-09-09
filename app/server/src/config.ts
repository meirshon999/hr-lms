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

/** Насколько в прошлом допустима дата выхода (SPEC §8 max_backdate_days). */
export const MAX_BACKDATE_DAYS = 30;

/** Защита входа от перебора пароля: сколько неудач с одного адреса за окно. */
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_MIN = 15;
