import { useState } from 'react';

/**
 * Знак сети.
 *
 * Настоящий логотип — файл `web/public/logo.svg`. Как только он там появляется,
 * он подхватывается сам: подменять код не нужно, и человеку, который принесёт
 * новую версию знака, не придётся звать разработчика.
 *
 * Пока файла нет, рисуется запасной пингвин — чтобы экран входа не выглядел
 * недоделанным и на пустом проекте.
 */
export function Logo({ size = 30, wordmark = false, light = false }: { size?: number; wordmark?: boolean; light?: boolean }) {
  const [noFile, setNoFile] = useState(false);
  const ink = light ? '#FFFFFF' : '#4A0F1E';
  const sub = light ? '#E6CFA0' : '#9B8E8E';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      {noFile ? <Fallback size={size} /> : (
        <img
          src="/logo.svg"
          alt="Pingwin Premium"
          width={size}
          height={size}
          onError={() => setNoFile(true)}
          style={{
            width: size, height: size, objectFit: 'contain',
            // Знак одноцветный, а на тёмной боковой панели чёрное не видно.
            // Пересветка в белое — единственное, что нужно, чтобы один и тот же
            // файл работал и на светлом фоне, и на тёмном.
            filter: light ? 'brightness(0) invert(1)' : undefined,
          }}
        />
      )}
      {wordmark && (
        <span style={{ lineHeight: 1.1 }}>
          <span style={{ fontFamily: '"Playfair Display", serif', fontWeight: 700, fontSize: size * 0.62, color: ink, display: 'block' }}>
            Pingwin
          </span>
          <span style={{ fontFamily: '"PT Sans", sans-serif', fontSize: size * 0.3, letterSpacing: '.22em', color: sub, textTransform: 'uppercase' }}>
            Premium
          </span>
        </span>
      )}
    </span>
  );
}

/** Запасной знак: стилизованный пингвин в круге (бордо + золото). */
function Fallback({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-label="Pingwin Premium">
      <circle cx="20" cy="20" r="20" fill="#4A0F1E" />
      <circle cx="20" cy="20" r="17.5" fill="none" stroke="#C6A15B" strokeWidth="1.4" />
      <path d="M20 8c-5 0-8.5 4-8.5 10.5 0 6 2.2 11 8.5 13.5 6.3-2.5 8.5-7.5 8.5-13.5C28.5 12 25 8 20 8z" fill="#20323b" />
      <ellipse cx="20" cy="21.5" rx="4.6" ry="8.2" fill="#FAF6F2" />
      <circle cx="17.6" cy="15.5" r="1.15" fill="#FAF6F2" />
      <circle cx="22.4" cy="15.5" r="1.15" fill="#FAF6F2" />
      <circle cx="17.7" cy="15.6" r="0.5" fill="#20323b" />
      <circle cx="22.3" cy="15.6" r="0.5" fill="#20323b" />
      <path d="M20 16.6l-2 2.3h4z" fill="#C6A15B" />
    </svg>
  );
}
