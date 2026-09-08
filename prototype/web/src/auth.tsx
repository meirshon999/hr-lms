import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, setToken } from './api';

export type Role = 'employee' | 'hr' | 'admin';
interface Me {
  user: { id: string; login: string; role: Role };
  employee: { id: string; full_name: string; stage: string; position_id: string } | null;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<Role>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      setMe(await get<Me>('/me'));
    } catch {
      setMe(null);
      setToken(null);
    }
  }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (localStorage.getItem('lms_token')) await refresh();
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, []);

  async function login(login: string, password: string): Promise<Role> {
    const r = await post<{ token: string; role: Role }>('/auth/login', { login, password });
    setToken(r.token);
    await refresh();
    return r.role;
  }

  function logout() {
    setToken(null);
    setMe(null);
    location.hash = '#/login';
  }

  // сеанс кончился (401 от любого запроса) — возвращаем на вход, а не
  // оставляем полупустые экраны
  useEffect(() => {
    const onExpired = () => { setMe(null); location.hash = '#/login'; };
    window.addEventListener('lms:unauthorized', onExpired);
    return () => window.removeEventListener('lms:unauthorized', onExpired);
  }, []);

  return (
    <Ctx.Provider value={{ me, loading, login, logout, refresh }}>
      {children}
    </Ctx.Provider>
  );
}
