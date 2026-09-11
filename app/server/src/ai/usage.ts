import { all, one, run, uuid } from '../db.ts';
import { stamp } from '../clock.ts';

/**
 * РАСХОД ИИ.
 *
 * Ключ вставляет тот, кто за него платит, а счёт приходит в конце месяца и
 * только в кабинете провайдера. Между «нажал кнопку» и «увидел сумму» — месяц,
 * и за этот месяц можно случайно сжечь заметные деньги, ни разу этого не
 * заметив. Поэтому считаем сами и показываем прямо в настройках.
 *
 * Денег намеренно не считаем. Цены у провайдеров меняются, а зашитая в код
 * цифра тихо врёт — врущая сумма хуже отсутствующей. Показываем обращения и
 * токены, а перевод в деньги — в кабинете провайдера, по актуальному тарифу.
 */

export interface UsageRow {
  actor: string;
  action: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  ok: boolean;
}

/** Записываем и удачные обращения, и неудачные: неудачные тоже часто платные. */
export function recordUsage(u: UsageRow) {
  run(
    `INSERT INTO ai_usage (id, ts, actor, action, provider, model, tokens_in, tokens_out, ok)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    uuid(), stamp(), u.actor, u.action, u.provider, u.model,
    u.tokensIn | 0, u.tokensOut | 0, u.ok ? 1 : 0,
  );
}

export interface UsageSummary {
  /** Обращений за последние 30 дней. */
  calls: number;
  tokens_in: number;
  tokens_out: number;
  failed: number;
  /** Всего за всё время — чтобы понять, давно ли ключом пользуются. */
  calls_total: number;
  since: string | null;
  /** По видам работы: сборка урока, разбор документа, аттестация. */
  by_action: { action: string; calls: number; tokens: number }[];
}

const DAY = 24 * 60 * 60 * 1000;

export function usageSummary(): UsageSummary {
  const from = new Date(Date.now() - 30 * DAY).toISOString();
  const m = one<any>(
    `SELECT COUNT(*) c, COALESCE(SUM(tokens_in),0) ti, COALESCE(SUM(tokens_out),0) to_,
            COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) bad
       FROM ai_usage WHERE ts >= ?`, from);
  const total = one<any>('SELECT COUNT(*) c, MIN(ts) first FROM ai_usage');
  const by = all<any>(
    `SELECT action, COUNT(*) calls, COALESCE(SUM(tokens_in + tokens_out),0) tokens
       FROM ai_usage WHERE ts >= ? GROUP BY action ORDER BY calls DESC`, from);

  return {
    calls: m?.c ?? 0,
    tokens_in: m?.ti ?? 0,
    tokens_out: m?.to_ ?? 0,
    failed: m?.bad ?? 0,
    calls_total: total?.c ?? 0,
    since: total?.first ?? null,
    by_action: by.map((r) => ({ action: r.action, calls: r.calls, tokens: r.tokens })),
  };
}

/** Понятные названия видов работы — те же слова, что и на кнопках. */
export const ACTION_TITLE: Record<string, string> = {
  lesson: 'Сборка урока',
  plan: 'Разбор регламента в траекторию',
  attestation: 'Финальная аттестация',
  pdf: 'Чтение PDF',
  test: 'Проверка ключа',
};
