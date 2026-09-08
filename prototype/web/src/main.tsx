import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './styles.css';
import { AuthProvider } from './auth';
import { BumpProvider, OfflineBar, ToastProvider } from './lib';
import { DevBar } from './components/DevBar';
import { App } from './App';
import { setToken } from './api';

// демо-удобство: ?t=<token> в URL сразу авторизует (используется для скриншотов/тестов)
const _t = new URLSearchParams(location.search).get('t');
if (_t) {
  setToken(_t);
  history.replaceState(null, '', location.pathname + location.hash);
}

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
