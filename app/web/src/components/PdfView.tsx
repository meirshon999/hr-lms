import { useEffect, useState } from 'react';

const isReal = (u: string | null) => !!u && u.startsWith('/api/v1/files/');

/**
 * Просмотр PDF. Загруженный файл показываем прямо в странице; на телефоне
 * встроенный просмотрщик капризен, поэтому рядом всегда есть «Открыть».
 * Пока файла нет (демо-данные) — честно говорим об этом, а не рисуем документ.
 */
export function PdfView({ src, onOpened }: { src: string | null; onOpened?: () => void }) {
  const real = isReal(src);
  const [opened, setOpened] = useState(false);

  // без файла материал нечем «дочитывать» — сразу разрешаем закрыть
  useEffect(() => { if (!real) onOpened?.(); }, [real]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!real) {
    return (
      <div className="video-stub" style={{ padding: 26 }}>
        <div className="play">⬇</div>
        <div>Документ не загружен</div>
        <div style={{ fontSize: 12, opacity: .7, marginTop: 4 }}>
          В демо-данных файла нет. Загрузите PDF в конструкторе.
        </div>
      </div>
    );
  }

  return (
    <div className="pdfview">
      <object data={src!} type="application/pdf" className="frame">
        <div className="fallback">
          Ваш браузер не показывает PDF внутри страницы.
        </div>
      </object>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <a className="btn ghost sm" href={src!} target="_blank" rel="noreferrer"
          onClick={() => { setOpened(true); onOpened?.(); }}>
          Открыть в новой вкладке
        </a>
        {!opened && (
          <button className="btn ghost sm" onClick={() => { setOpened(true); onOpened?.(); }}>
            Я прочитал документ
          </button>
        )}
      </div>
    </div>
  );
}
