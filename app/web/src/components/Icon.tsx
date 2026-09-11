import type { ReactNode } from 'react';

/**
 * ЗНАЧКИ ИНТЕРФЕЙСА.
 *
 * Раньше это были эмодзи — ✨, 📄, ★. Беда эмодзи не во вкусе: их рисует
 * операционная система, и один и тот же значок на Windows, Mac и Android
 * выглядит по-разному, в своей палитре и своей толщине. В интерфейсе, где
 * рядом стоят три кнопки, это читается как случайный набор наклеек.
 *
 * Здесь один набор в одном начертании: контур 1.6, скруглённые концы,
 * цвет наследуется от текста кнопки. Библиотеку не берём — правило 15, да и
 * пятнадцать значков не стоят зависимости.
 */

export type IconName =
  | 'wand' | 'doc' | 'upload' | 'award' | 'eye' | 'check' | 'x' | 'trash'
  | 'up' | 'down' | 'plus' | 'alert' | 'pin' | 'clock' | 'layers' | 'link';

const SHAPES: Record<IconName, ReactNode> = {
  // Сборка через ИИ: большая искра и две малых — «собралось само»
  wand: <><path d="M12 3.3l1.9 5.2 5.2 1.9-5.2 1.9L12 17.5l-1.9-5.2-5.2-1.9 5.2-1.9z" /><path d="M5 3.6v2.2M3.9 4.7h2.2M18.6 15.8V18M17.5 16.9h2.2" /></>,
  doc: <><path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z" /><path d="M14 3v5h5" /></>,
  upload: <><path d="M12 15.5V4M7.8 8.2 12 4l4.2 4.2" /><path d="M4.5 15.5v3A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-3" /></>,
  // Аттестация: розетка — итоговая проверка, а не «ещё один тест»
  award: <><circle cx="12" cy="9" r="5.5" /><path d="M8.3 13.4 7 21l5-2.7L17 21l-1.3-7.6" /></>,
  eye: <><path d="M2.5 12S6 6.2 12 6.2 21.5 12 21.5 12 18 17.8 12 17.8 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.6" /></>,
  check: <path d="m4.8 12.6 4.8 4.8L19.2 6.6" />,
  x: <path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />,
  trash: <><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7" /></>,
  up: <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />,
  down: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  alert: <><path d="M12 4.2 2.9 19.8h18.2z" /><path d="M12 10v4.2M12 17.3v.1" /></>,
  pin: <><path d="M12 21s6.8-6.4 6.8-11a6.8 6.8 0 1 0-13.6 0C5.2 14.6 12 21 12 21z" /><circle cx="12" cy="10" r="2.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.8" /><path d="M12 6.8V12l3.3 2" /></>,
  layers: <><path d="m12 3 9 4.8-9 4.8-9-4.8z" /><path d="m3 12.6 9 4.8 9-4.8" /></>,
  link: <><path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2.8-2.8a3.5 3.5 0 0 0-5-5l-1.2 1.2" /><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-2.8 2.8a3.5 3.5 0 0 0 5 5l1.2-1.2" /></>,
};

export function Icon({ name, size = 16, className }: {
  name: IconName; size?: number; className?: string;
}) {
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
      style={{ flex: 'none', display: 'block' }}
    >
      {SHAPES[name]}
    </svg>
  );
}
