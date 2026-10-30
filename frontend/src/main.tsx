import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { App } from './App';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
// Справочники меняются только администратором: между переходами по экранам
// они не перезапрашиваются и живут в кеше дольше обычных списков.
client.setQueryDefaults(['dictionaries'], { staleTime: 10 * 60_000 });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="user">
        <BrowserRouter><App /></BrowserRouter>
      </MotionConfig>
    </QueryClientProvider>
  </React.StrictMode>,
);
