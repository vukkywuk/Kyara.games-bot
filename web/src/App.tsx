import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy } from 'react';
import type { ComponentType } from 'react';
import { MotionConfig } from 'motion/react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ToastProvider } from './components/overlay';
import { Shell } from './components/Shell';
import { queryClient } from './lib/queries';
import { Dashboard } from './pages/Dashboard';
import { NotFound } from './pages/NotFound';
import { LiveToasts } from './components/LiveToasts';
import { Skeleton } from './components/ui';

function PageFallback() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="mb-6 h-9 w-64" />
      <Skeleton className="h-64" />
    </div>
  );
}

/** Pages load on demand, then everything is prefetched while idle so navigation never waits. */
const loaders = {
  Explorer: () => import('./pages/Explorer').then((m) => ({ default: m.Explorer as ComponentType })),
  CollectionPage: () => import('./pages/Collection').then((m) => ({ default: m.CollectionPage as ComponentType })),
  MarketPage: () => import('./pages/Market').then((m) => ({ default: m.MarketPage as ComponentType })),
  PacksPage: () => import('./pages/Packs').then((m) => ({ default: m.PacksPage as ComponentType })),
  AutomationPage: () => import('./pages/Automation').then((m) => ({ default: m.AutomationPage as ComponentType })),
  SessionPage: () => import('./pages/Session').then((m) => ({ default: m.SessionPage as ComponentType })),
  ActivityPage: () => import('./pages/Activity').then((m) => ({ default: m.ActivityPage as ComponentType })),
  MissionsPage: () => import('./pages/Missions').then((m) => ({ default: m.MissionsPage as ComponentType })),
  TradesPage: () => import('./pages/Trades').then((m) => ({ default: m.TradesPage as ComponentType })),
  SettingsPage: () => import('./pages/Settings').then((m) => ({ default: m.SettingsPage as ComponentType })),
  SetupPage: () => import('./pages/Setup').then((m) => ({ default: m.SetupPage as ComponentType })),
};
const Explorer = lazy(loaders.Explorer);
const CollectionPage = lazy(loaders.CollectionPage);
const MarketPage = lazy(loaders.MarketPage);
const PacksPage = lazy(loaders.PacksPage);
const AutomationPage = lazy(loaders.AutomationPage);
const SessionPage = lazy(loaders.SessionPage);
const ActivityPage = lazy(loaders.ActivityPage);
const MissionsPage = lazy(loaders.MissionsPage);
const TradesPage = lazy(loaders.TradesPage);
const SettingsPage = lazy(loaders.SettingsPage);
const SetupPage = lazy(loaders.SetupPage);
const idle = (cb: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(cb) : setTimeout(cb, 800));
idle(() => Object.values(loaders).forEach((l) => void l()));

const page = (el: React.ReactNode) => <Suspense fallback={<PageFallback />}>{el}</Suspense>;

const router = createBrowserRouter([
  {
    element: (
      <>
        <Shell />
        <LiveToasts />
      </>
    ),
    children: [
      { path: '/', element: <Dashboard /> },
      { path: '/missions', element: page(<MissionsPage />) },
      { path: '/characters', element: page(<Explorer />) },
      { path: '/collection', element: page(<CollectionPage />) },
      { path: '/market', element: page(<MarketPage />) },
      { path: '/trades', element: page(<TradesPage />) },
      { path: '/settings', element: page(<SettingsPage />) },
      { path: '/setup', element: page(<SetupPage />) },
      { path: '/packs', element: page(<PacksPage />) },
      { path: '/automation', element: page(<AutomationPage />) },
      { path: '/session', element: page(<SessionPage />) },
      { path: '/activity', element: page(<ActivityPage />) },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* "user": every animation honours prefers-reduced-motion */}
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
