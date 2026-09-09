import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './styles.css';
import { AuthProvider } from './auth';
import { BumpProvider, OfflineBar, ToastProvider } from './lib';
import { DevBar } from './components/DevBar';
import { App } from './App';

// Вход по токену в адресной строке был удобством для скриншотов, но в бою это
// дыра: адрес попадает в историю браузера, в логи прокси и в пересланную ссылку.
// Осталась только обычная форма входа.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <BumpProvider>
        <AuthProvider>
          <ToastProvider>
            <OfflineBar />
            <App />
            <DevBar />
          </ToastProvider>
        </AuthProvider>
      </BumpProvider>
    </HashRouter>
  </StrictMode>,
);
