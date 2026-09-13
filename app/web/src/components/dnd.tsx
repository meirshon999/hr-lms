import { useState } from 'react';
import type { DragEvent } from 'react';

/**
 * ПЕРЕТАСКИВАНИЕ СПИСКА МЫШЬЮ.
 *
 * Своими силами, без библиотеки (правило 15). Браузерное перетаскивание
 * (HTML5 drag-and-drop) умеет ровно то, что здесь нужно, и не тянет за собой
 * ни килобайта: элемент объявляется `draggable`, а мы слушаем четыре события.
 *
 * Списки вложенные — уроки внутри блоков, блоки внутри траектории, — поэтому
 * каждое событие гасится `stopPropagation`: иначе урок, который тащат мимо
 * заголовка блока, попадёт в список блоков и переставит не то.
 *
 * Стрелки ↑↓ остаются рядом и никуда не денутся: мышью удобно, но с клавиатуры
 * перетащить нельзя, а порядок уроков — не та вещь, которую можно оставить
 * только для мыши.
 */

/** Переставить элемент на новое место (именно перенести, а не поменять местами). */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const copy = [...list];
  const [x] = copy.splice(from, 1);
  copy.splice(to, 0, x);
  return copy;
}

export interface DragHandlers {
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: (e: DragEvent) => void;
  /** Классы состояния: что тащим и куда уронят. */
  className: string;
}

export function useDragList(onReorder: (from: number, to: number) => void) {
  const [from, setFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const handlers = (i: number): DragHandlers => ({
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation();
      setFrom(i);
      e.dataTransfer.effectAllowed = 'move';
      // Без данных Firefox вовсе не начинает перетаскивание.
      e.dataTransfer.setData('text/plain', String(i));
    },
    onDragOver: (e) => {
      if (from === null) return;   // тащат из другого списка — не наше дело
      e.preventDefault();
      e.stopPropagation();
      if (over !== i) setOver(i);
    },
    onDragLeave: () => setOver((o) => (o === i ? null : o)),
    onDrop: (e) => {
      if (from === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (from !== i) onReorder(from, i);
      setFrom(null);
      setOver(null);
    },
    onDragEnd: () => { setFrom(null); setOver(null); },
    className: from === null ? ''
      : i === from ? 'dragging'
        : over === i ? `drop ${i > from ? 'after' : 'before'}`
          : '',
  });

  return handlers;
}
