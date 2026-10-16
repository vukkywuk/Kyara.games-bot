import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, vi } from 'vitest';
import { ToastProvider } from '../../web/src/components/overlay';

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => cleanup());

// jsdom has no ResizeObserver (every real browser does).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

export type Handler = (init: RequestInit & { url: string }) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/** Stubs fetch for /app-api/*: the token call plus per-route handlers. Records every call. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const path = url.replace(/^.*\/app-api/, '').split('?')[0]!;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (path === '/token') return Response.json({ token: 'test-token' });
      const h = routes[`${method} ${path}`];
      if (!h) return Response.json({ error: { code: 'not_found', message: `no mock for ${method} ${path}` } }, { status: 404 });
      const r = await h({ ...init, url });
      return Response.json(r.body, { status: r.status ?? 200 });
    }),
  );
  return calls;
}

export let lastLocation = '';
function LocationProbe() {
  const l = useLocation();
  lastLocation = l.pathname + l.search;
  return null;
}

export function renderWithApp(ui: ReactElement, { path = '/', route = '*' }: { path?: string; route?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <Routes>
            <Route path={route} element={ui} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
