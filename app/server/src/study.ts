import { one, run } from './db.ts';
import type { SnapMaterial } from './snapshot.ts';

/**
 * ДОКАЗАТЕЛЬСТВО ПРОСМОТРА И ПРОЧТЕНИЯ.
 *
 * Скажем честно с самого начала: доказать, что человек **прочитал**, нельзя.
 * Можно сделать так, чтобы пролистать стоило столько же времени, сколько
 * прочитать, — и записать, сколько он на самом деле потратил. Этого хватает:
 * смысл не в том, чтобы поймать хитреца, а в том, чтобы кнопка «Засчитать»
 * перестала быть способом проскочить обучение за минуту.
 *
 * Как считаем время. Клиент шлёт удары сердца: «прошло ещё N секунд, я на
 * этой странице». Доверять этому числу нельзя, поэтому **сервер режет каждый
 * удар по настоящему времени** — сколько прошло с прошлого удара по его
 * собственным часам. Тысяча ударов подряд не дадут ничего: между ними не
 * прошло ни секунды. Чтобы накопить десять минут, нужно потратить десять
 * настоящих минут.
 *
 * Сколько нужно. Для текста считаем по числу слов, для PDF берём общую меру,
 * для видео — долю от длительности, прочитанной из самого файла (`mp4.ts`).
 * Нормы намеренно щадящие: цель — отсечь «открыл и нажал», а не загнать
 * человека в норматив.
 */

/** Слов в минуту. Взрослый читает 200–250; берём ниже, чтобы не подгонять. */
const WORDS_PER_MIN = 160;
/** Документ PDF листают, а не читают построчно: минута — разумная нижняя мера. */
const PDF_SEC = 60;
/** Меньше этого не требуем ни с кого: короткую памятку читают за десять секунд. */
const MIN_SEC = 10;
/** И больше этого тоже: человек читает по частям, а не сидит десять минут подряд. */
const MAX_SEC = 8 * 60;
/** Запас на неровность ударов сердца: сеть моргнула — не наказываем. */
const BEAT_SLACK_SEC = 3;

export interface StudyNeed {
  /** Сколько секунд на материале нужно провести. */
  seconds: number;
  /** Нужно ли доскроллить до конца. Для видео бессмысленно. */
  scroll: boolean;
  /** Откуда взялась норма — это же объяснение показываем человеку. */
  why: string;
}

/**
 * Норма для материала. Длительность видео приходит отдельно: она хранится
 * у файла, а снимок урока файлов не знает.
 */
export function needFor(m: SnapMaterial | null, videoSec: number | null): StudyNeed {
  if (!m) return { seconds: 0, scroll: false, why: '' };

  if (m.content_type === 'video') {
    const pct = m.min_watch_pct ?? 90;
    if (!videoSec) {
      // Длительность неизвестна (webm или битый файл). Требовать наугад нельзя:
      // придумаешь мало — проверка бессмысленна, много — накажешь ни за что.
      return { seconds: MIN_SEC, scroll: false, why: 'длительность ролика неизвестна' };
    }
    const need = Math.round((videoSec * pct) / 100);
    return {
      seconds: Math.max(MIN_SEC, need),
      scroll: false,
      why: `${pct}% от ${Math.round(videoSec / 60)} мин ролика`,
    };
  }

  if (m.content_type === 'pdf') {
    // Числа страниц снимок не знает, а лезть в файл ради нормы чтения — перебор.
    return { seconds: PDF_SEC, scroll: false, why: 'документ' };
  }

  const words = (m.text_body ?? '').trim().split(/\s+/).filter(Boolean).length;
  const need = Math.round((words / WORDS_PER_MIN) * 60);
  return {
    seconds: clamp(need),
    scroll: true,
    why: `${words} слов — примерно ${Math.max(1, Math.round(need / 60))} мин чтения`,
  };
}

const clamp = (s: number) => Math.min(MAX_SEC, Math.max(MIN_SEC, s));

export interface BeatResult {
  seconds_spent: number;
  scroll_pct: number;
  /** Сколько секунд из присланных приняли — для отладки и для честности. */
  counted: number;
}

/**
 * Удар сердца: принять время, но не больше, чем его прошло на самом деле.
 *
 * `last_beat_at` — часы сервера, а не клиента. Между двумя ударами не может
 * быть засчитано больше секунд, чем реально прошло; первый удар после паузы
 * засчитывается как один интервал, а не как вся пауза, — иначе можно было бы
 * открыть урок, уйти на час и вернуться «прочитавшим».
 */
export function beat(
  employeeId: string, lessonId: string,
  claimedSec: number, scrollPct: number, maxStepSec: number,
): BeatResult {
  const lp = one<any>(
    'SELECT * FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', employeeId, lessonId);
  const now = Date.now();
  const last = lp?.last_beat_at ? new Date(lp.last_beat_at).getTime() : 0;
  const realSec = last ? Math.floor((now - last) / 1000) : 0;

  // Сколько принять: не больше присланного, не больше прошедшего по нашим
  // часам и не больше одного шага — пауза не превращается в зачтённое время.
  const counted = last
    ? Math.max(0, Math.min(claimedSec, realSec + BEAT_SLACK_SEC, maxStepSec))
    : 0;

  const seconds = (lp?.seconds_spent ?? 0) + counted;
  const scroll = Math.max(lp?.scroll_pct ?? 0, Math.min(100, Math.max(0, Math.round(scrollPct))));

  run(
    `UPDATE lesson_progress
        SET seconds_spent = ?, scroll_pct = ?, last_beat_at = ?,
            opened_at = COALESCE(opened_at, ?)
      WHERE employee_id = ? AND lesson_id = ?`,
    seconds, scroll, new Date(now).toISOString(), new Date(now).toISOString(),
    employeeId, lessonId,
  );

  return { seconds_spent: seconds, scroll_pct: scroll, counted };
}
