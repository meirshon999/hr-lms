import { stamp } from './clock.ts';

/**
 * Кольцевой буфер последних доменных событий — для демо-панели «События».
 * В проде заменить на реальную шину/аудит-лог.
 */
export interface DomainEvent { ts: string; type: string; detail: string; }

const RING: DomainEvent[] = [];
const MAX = 60;

export function emit(type: string, detail: string) {
  RING.unshift({ ts: stamp(), type, detail });
  if (RING.length > MAX) RING.pop();
}

export function recentEvents(): DomainEvent[] {
  return RING;
}

export function clearEvents() {
  RING.length = 0;
}
