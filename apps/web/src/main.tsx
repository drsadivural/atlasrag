import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { ToastProvider, TooltipProvider } from '@uxe/ui';
import '@uxe/ui/tokens.css';
import './styles.css';
import './styles/government.css';
import { router } from './router.js';
import { SessionProvider } from './lib/session.js';
import { ThemeProvider } from './lib/theme.js';
import { ApiError } from './lib/api.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // Never retry a 4xx: a permission error or a validation failure will not fix itself,
      // and retrying makes the UI feel broken rather than decisive.
      retry: (count, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return count < 2;
      },
      retryDelay: (attempt) => Math.min(4000, 400 * 2 ** attempt),
    },
    mutations: { retry: false },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SessionProvider>
          <TooltipProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </TooltipProvider>
        </SessionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
