import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authRequired, err } from '../auth.ts';
import { audit } from '../audit.ts';
import { AiError, aiInfo, testConnection } from '../ai/provider.ts';
import {
  aiSettings, clearAiSettings, keyHint, PROVIDER_INFO, saveAiSettings,
} from '../ai/settings.ts';
import { ACTION_TITLE, usageSummary } from '../ai/usage.ts';

/**
 * НАСТРОЙКИ ИИ — кадровику и администратору.
 *
 * Почему обоим, хотя ключ это деньги: платит за ИИ тот, кто им пользуется, и
 * в сети из трёх точек это один и тот же человек. Требовать администратора
 * ради вставки ключа значит гарантировать, что ИИ не включат вовсе.
 * Кто именно менял настройку, видно в журнале действий — он у администратора.
 *
 * Ключ наружу не отдаётся никогда: в ответах от него остаются последние
 * четыре знака, чтобы человек узнал свой и не более того. В базе он лежит
 * зашифрованным (`secretbox.ts`) — копия базы чужой ключ не выдаст.
 */

const actor = (req: any) => req?.user?.login ?? 'system';

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('hr', 'admin'));

  app.get('/settings/ai', async () => {
    const s = aiSettings();
    return {
      provider: s.provider,
      model: s.provider === 'off' ? '' : s.model,
      has_key: !!s.apiKey,
      key_hint: keyHint(s.apiKey),
      /** `env` — ключ задан на сервере переменной окружения. */
      source: s.source,
      /** Ключ в базе есть, но он с другого сервера — расшифровать нечем. */
      key_unreadable: s.keyUnreadable,
      ai: aiInfo(),
      /** Сколько ИИ уже потратил: тому, кто платит своим ключом, это важно. */
      usage: { ...usageSummary(), titles: ACTION_TITLE },
      /** Что можно выбрать, чем отличаются и где взять ключ — чтобы не гадать. */
      providers: Object.entries(PROVIDER_INFO).map(([key, v]) => ({
        key,
        title: v.title,
        default_model: v.defaultModel,
        free: v.free,
        reads_documents: v.readsPdf,
        note: v.note,
        console_url: v.consoleUrl,
        key_prefix: v.keyPrefix,
        price: v.price,
      })),
    };
  });

  app.put('/settings/ai', async (req, reply) => {
    const p = z.object({
      provider: z.enum(['off', 'groq', 'openai', 'anthropic']),
      /** Пусто — прежний ключ остаётся: так меняют модель, не трогая ключ. */
      api_key: z.string().max(400).optional(),
      model: z.string().max(120).optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Проверьте поля'));

    const had = aiSettings();
    const key = (p.data.api_key ?? '').trim();
    if (p.data.provider !== 'off') {
      // Ключа нет ни нового, ни прежнего — включать нечего.
      const keepsOld = had.source === 'settings' && had.provider === p.data.provider && had.apiKey;
      if (!key && !keepsOld) {
        return reply.code(422).send(err('no_key', 'Нужен ключ провайдера'));
      }
      // Ключ уходит в заголовок HTTP, а туда нельзя ничего, кроме латиницы:
      // случайная кириллица или невидимый символ из буфера обмена дают
      // невнятную ошибку глубоко внутри библиотеки вместо понятной фразы.
      if (key && !/^[\x21-\x7e]+$/.test(key)) {
        return reply.code(422).send(err(
          'wrong_key',
          'В ключе есть посторонние символы — скопируйте его из кабинета провайдера заново',
        ));
      }
      // Вставили не тот ключ — типичная ошибка, и провайдер сообщит о ней
      // невнятным 401 через минуту. Дешевле сказать сразу.
      const prefix = PROVIDER_INFO[p.data.provider].keyPrefix;
      if (key && !key.startsWith(prefix)) {
        return reply.code(422).send(err(
          'wrong_key',
          `Это не похоже на ключ ${PROVIDER_INFO[p.data.provider].title}: он начинается с «${prefix}»`,
        ));
      }
    }

    saveAiSettings(p.data);
    // В журнал пишем что угодно, кроме ключа.
    audit(actor(req), 'ai_settings', null,
      p.data.provider === 'off' ? 'выключен' : `${p.data.provider} / ${p.data.model || 'модель по умолчанию'}`);

    const s = aiSettings();
    return { provider: s.provider, model: s.model, has_key: !!s.apiKey, source: s.source };
  });

  /**
   * Убрать свой ключ. Отдельная кнопка, а не «сохранить пустое поле»: это
   * то, что делают перед передачей системы другому владельцу, и оно должно
   * называться своим именем. После неё действует то, что задано на сервере.
   */
  app.delete('/settings/ai', async (req) => {
    clearAiSettings();
    audit(actor(req), 'ai_settings', null, 'ключ удалён, вернулись к серверным');
    const s = aiSettings();
    return { provider: s.provider, model: s.model, has_key: !!s.apiKey, source: s.source };
  });

  /**
   * Живая проверка. Без неё человек вставляет ключ, закрывает настройки
   * и узнаёт о неверном ключе через неделю, когда впервые нажмёт «Собрать».
   */
  app.post('/settings/ai/test', async (req, reply) => {
    try {
      return await testConnection(actor(req));
    } catch (e) {
      if (e instanceof AiError) {
        const status = e.code === 'ai_disabled' ? 503
          : e.code === 'ai_bad_key' ? 422
            : e.code === 'ai_bad_model' ? 422
              : e.code === 'ai_rate_limited' ? 429 : 502;
        return reply.code(status).send(err(e.code, e.message));
      }
      app.log.error(e);
      return reply.code(502).send(err('ai_failed', 'Проверка не удалась'));
    }
  });
}
