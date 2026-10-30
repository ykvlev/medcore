import { createContext, useContext, useEffect } from 'react';
import type { PropsWithChildren } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import type { CurrentUser } from './types';
import { Button, ErrorState, Loading } from './components/ui';

interface AuthContextValue { user: CurrentUser | null; isPending: boolean; login: (input: { login: string; password: string }) => Promise<CurrentUser>; logout: () => Promise<void>; loggingOut: boolean }
const AuthContext = createContext<AuthContextValue | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is required');
  return value;
}
export function AuthProvider({ children }: PropsWithChildren) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['auth', 'me'], queryFn: async () => {
    try { return await api<CurrentUser>('/auth/me'); }
    catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
  }, retry: false, staleTime: Infinity });
  useEffect(() => {
    function expired() { client.clear(); client.setQueryData(['auth', 'me'], null); }
    window.addEventListener('medcore:session-expired', expired);
    return () => window.removeEventListener('medcore:session-expired', expired);
  }, [client]);
  const logoutMutation = useMutation({ mutationFn: () => api<void>('/auth/logout', { method: 'POST' }), onSuccess: () => { client.clear(); client.setQueryData(['auth', 'me'], null); } });
  async function login(input: { login: string; password: string }) {
    const user = await api<CurrentUser>('/auth/login', { method: 'POST', body: JSON.stringify(input) });
    // Сбрасываем данные предыдущей сессии, но не сам запрос пользователя:
    // иначе наблюдатель теряет уведомление и вход не переключает экран.
    client.removeQueries({ predicate: query => query.queryKey[0] !== 'auth' });
    client.setQueryData(['auth', 'me'], user);
    return user;
  }
  if (query.isError) return <div className="connection-screen"><div className="glass-panel"><ErrorState error={query.error} retry={() => void query.refetch()} /><Button variant="ghost" onClick={() => window.location.reload()}>Перезагрузить страницу</Button></div></div>;
  return <AuthContext.Provider value={{ user: query.data ?? null, isPending: query.isPending, login, logout: () => logoutMutation.mutateAsync(), loggingOut: logoutMutation.isPending }}>{children}</AuthContext.Provider>;
}
export function RequireAuth({ children }: PropsWithChildren) {
  const { user, isPending } = useAuth();
  const location = useLocation();
  if (isPending) return <div className="connection-screen"><Loading label="Проверяем сессию" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
