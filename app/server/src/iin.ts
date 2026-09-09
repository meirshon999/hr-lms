/**
 * ИИН — двенадцатизначный номер, ключ человека в сети.
 *
 * Проверяем не только длину: у ИИН есть контрольная сумма, поэтому опечатка в
 * одной цифре и выдуманный номер отсеиваются сразу, а не всплывают через полгода
 * дублем сотрудника.
 *
 * Устройство номера: ГГММДД — дата рождения, 7-я цифра — век и пол (1–6),
 * 8–11 — порядковый номер, 12-я — контрольная.
 */

const W1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const W2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];

const weighted = (d: number[], w: number[]) =>
  w.reduce((sum, k, i) => sum + d[i] * k, 0) % 11;

/** Приводит к 12 цифрам: пробелы и дефисы из копипаста не должны мешать. */
export const normalizeIin = (raw: string) => raw.replace(/\D/g, '');

export function iinProblem(raw: string): string | null {
  const s = normalizeIin(raw);
  if (s.length !== 12) return 'ИИН должен состоять из 12 цифр';

  const d = [...s].map(Number);

  const mm = d[2] * 10 + d[3];
  const dd = d[4] * 10 + d[5];
  if (mm < 1 || mm > 12) return 'В ИИН неверный месяц рождения';
  if (dd < 1 || dd > 31) return 'В ИИН неверный день рождения';
  if (d[6] < 1 || d[6] > 6) return 'В ИИН неверная седьмая цифра (век и пол)';

  let check = weighted(d, W1);
  if (check === 10) check = weighted(d, W2);
  if (check === 10 || check !== d[11]) return 'ИИН не проходит проверку контрольной суммы';

  return null;
}

export const isValidIin = (raw: string) => iinProblem(raw) === null;
