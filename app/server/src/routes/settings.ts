import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authRequired, err } from '../auth.ts';
import { audit } from '../audit.ts';
import { AiError, aiInfo, testConnection } from '../ai/provider.ts';
import { sttInfo } from '../ai/transcribe.ts';
import {
  aiSettings, clearAiSettings, keyHint, PROVIDER_INFO, saveAiSettings,
} from '../ai/settings.ts';

/**
 * НАСТРОЙКИ ИИ — только для администратора.
 *
 * Почему не для кадровика, хотя пользуется ИИ именно он: ключ это деньги.
 * Кто его вставил, тот и платит по счёту провайдера, а на платном тарифе
 * чужой ключ — это чужой счёт. Кадровик работает с людьми и содержанием,
 * доступы и расходы — не его зона.
 *
 * Ключ наружу не отдаётся никогда: в ответах от него остаются последние
 * четыре знака, чтобы человек узнал свой и не более того.
 */

const actor = (req: any) => req?.user?.login ?? 'system';

export default async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('admin'));

  app.get('/settings/ai', async () => {
    const s = aiSettings();
    return {
      provider: s.provider,
      model: s.provider === 'off' ? '' : s.model,
      has_key: !!s.apiKey,
      key_hint: keyHint(s.apiKey),
      /** `env` — ключ задан на сервере, менять его отсюда бессмысленно. */
      source: s.source,
      ai: aiInfo(),
      stt: sttInfo(),
      /** Что можно выбрать и чем провайдеры отличаются — чтобы не гадать. */
      providers: Object.entries(PROVIDER_INFO).map(([key, v]) => ({
        key,
        title: v.title,
        default_model: v.defaultModel,
        free: v.free,
        speech: !!v.sttModel,
        reads_documents: key === 'anthropic',
        note: v.note,
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
    if (p.data.provider !== 'off') {
      const key = (p.data.api_key ?? '').trim();
      // Ключа нет ни нового, ни прежнего — включать нечего.
      const keepsOld = had.source === 'settings' && had.provider === p.data.provider && had.apiKey;
      if (!key && !keepsOld) {
        return reply.code(422).send(err('no_key', 'Нужен ключ провайдера'));
      }
    }

    saveAiSettings(p.data);
    // В журнал пишем что угодно, кроме ключа.
    audit(actor(req), 'ai_settings', null,
      p.data.provider === 'off' ? 'выключен' : `${p.data.provider} / ${p.data.model || 'модель по умолчанию'}`);

    const s = aiSettings();
    return { provider: s.provider, model: s.model, has_key: !!s.apiKey, source: s.source };
  });

  /** Вернуться к тому, что задано на сервере переменными окружения. */
  app.delete('/settings/ai', async (req) => {
    clearAiSettings();
    audit(actor(req), 'ai_settings', null, 'сброшены к серверным');
    const s = aiSettings();
    return { provider: s.provider, model: s.model, has_key: !!s.apiKey, source: s.source };
  });

  /**
   * Живая проверка. Без неё человек вставляет ключ, закрывает настройки
   * и узнаёт о неверном ключе через неделю, когда впервые нажмёт «Собрать».
   */
  app.post('/settings/ai/test', async (_req, reply) => {
    try {
      return await testConnection();
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
