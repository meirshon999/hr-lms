import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.PORT ?? 3001);
export const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'lms.db');

/** Куда кладём загруженные HR файлы. В проде — хранилище платформы (S3 и т.п.). */
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(__dirname, '..', 'uploads');
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB ?? 60);

/** Часовой пояс компании — все «сегодня» и дедлайны считаются в нём, не в UTC. */
export const TZ = process.env.TZ_LMS ?? 'Asia/Almaty';

/** Дедлайн онбординга: дата открытия + столько дней (SPEC §8 onboarding_days). */
export const ONBOARDING_DAYS = 14;

/** Секрет для подписи демо-токенов. В проде — из окружения. */
export const TOKEN_SECRET = process.env.TOKEN_SECRET ?? 'peg-lms-prototype-dev-secret';
export const TOKEN_TTL_HOURS = 12;

/** Насколько в прошлом допустима дата выхода (SPEC §8 max_backdate_days). */
export const MAX_BACKDATE_DAYS = 30;
