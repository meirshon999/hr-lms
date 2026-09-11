/*
 * ПЕРЕДАЧА СИСТЕМЫ ДРУГОМУ ВЛАДЕЛЬЦУ.
 *
 *     npm run handover        — показать, что осталось от прежнего владельца
 *     npm run handover -- --yes  — стереть его ключ ИИ из базы
 *
 * Зачем отдельная команда. Продукт переезжает копированием файла базы, а в базе
 * лежит ключ ИИ — то есть чужие деньги. Ключ зашифрован и на другом сервере
 * не заработает, но оставлять его там всё равно незачем. Кнопка «Убрать мой
 * ключ» в интерфейсе делает то же самое; команда нужна тому, кто передаёт
 * систему уже выключенной, и тому, кто хочет проверить, а не понадеяться.
 *
 * Данные сотрудников команда не трогает: их судьбу решает человек, а не скрипт.
 */
import { migrate } from '../src/db.ts';
import { aiSettings, clearAiSettings, keyHint } from '../src/ai/settings.ts';
import { DB_PATH } from '../src/config.ts';

migrate();

const apply = process.argv.includes('--yes');
const s = aiSettings();

console.log(`База: ${DB_PATH}`);

if (s.source !== 'settings') {
  console.log('Ключа ИИ в базе нет — стирать нечего.');
  if (s.source === 'env') {
    console.log(`Действует ключ с сервера (${s.provider}). Он в переменных окружения, не в базе.`);
  }
} else if (apply) {
  clearAiSettings();
  console.log(`Ключ ИИ (${s.provider}, ${keyHint(s.apiKey)}) стёрт из базы.`);
} else {
  console.log(`В базе лежит ключ ИИ: ${s.provider}, ${keyHint(s.apiKey)}.`);
  console.log('Стереть: npm run handover -- --yes');
}

console.log(`
Что ещё сделать руками — скрипт этого не видит:

  1. Переменные сервера: GROQ_API_KEY, ANTHROPIC_API_KEY, TOKEN_SECRET,
     LMS_ADMIN_PASSWORD, LMS_HR_PASSWORD. Новый владелец задаёт свои.
     TOKEN_SECRET обязательно новый: на нём шифруются ключи и подписываются входы.
  2. Пароли admin и hr — сменить, старые вы знаете.
  3. Ключ в кабинете провайдера — отозвать, если он больше не нужен.
     Стёртый из базы ключ остаётся действующим у провайдера.
`);
