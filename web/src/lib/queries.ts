import { QueryClient, keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, del, get, post, put } from './api';
import { stream } from './stream';
import type {
  ActionRecord,
  ActionResponse,
  AppStatus,
  Character,
  CharacterDetail,
  CollectionResponse,
  FeedEntry,
  HubEvent,
  KyaraSiteConfig,
  Listing,
  ListingPage,
  LogLine,
  MeResponse,
  Monitor,
  MonitorInput,
  OpenSummary,
  PacksResponse,
  PriceHistory,
  Progress,
  RarityRate,
  Settings,
  SettingsView,
  TradesResponse,
} from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
    },
  },
});

export const qk = {
  status: ['status'] as const,
  me: ['me'] as const,
  characters: ['characters'] as const,
  character: (id: number) => ['character', id] as const,
  collection: ['collection'] as const,
  packs: ['packs'] as const,
  rates: (id: string) => ['rates', id] as const,
  packHistory: ['packs', 'history'] as const,
  listings: (q: Record<string, string>) => ['listings', q] as const,
  listing: (id: string) => ['listing', id] as const,
  prices: (cid: number) => ['prices', cid] as const,
  progress: ['progress'] as const,
  actions: ['actions'] as const,
  events: ['events'] as const,
  logs: ['logs'] as const,
  monitors: ['monitors'] as const,
  trades: ['trades'] as const,
  settings: ['settings'] as const,
  feed: ['feed'] as const,
  config: ['config'] as const,
};

const isAuthError = (e: unknown) => e instanceof ApiError && e.code === 'auth_required';

// ------------------------------------------------------------------ reads

export const useStatus = () => useQuery({ queryKey: qk.status, queryFn: ({ signal }) => get<AppStatus>('/status', signal), refetchInterval: 15_000 });

export function useMe(enabled = true) {
  return useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => get<MeResponse>('/me', signal),
    enabled,
    refetchInterval: 60_000,
    retry: (n, e) => !isAuthError(e) && n < 2,
  });
}

export const useCharacters = () =>
  useQuery({ queryKey: qk.characters, queryFn: ({ signal }) => get<Character[]>('/characters', signal), staleTime: 30 * 60_000, gcTime: Infinity });

export const useCharacter = (id: number | null) =>
  useQuery({ queryKey: qk.character(id ?? 0), queryFn: ({ signal }) => get<CharacterDetail>(`/characters/${id}`, signal), enabled: id !== null, staleTime: 5 * 60_000 });

export const useCollection = (enabled = true) =>
  useQuery({ queryKey: qk.collection, queryFn: ({ signal }) => get<CollectionResponse>('/collection', signal), enabled, staleTime: 60_000, retry: (n, e) => !isAuthError(e) && n < 2 });

export const usePacks = () => useQuery({ queryKey: qk.packs, queryFn: ({ signal }) => get<PacksResponse>('/packs', signal), refetchInterval: 60_000 });

export const useRates = (id: string | null) =>
  useQuery({ queryKey: qk.rates(id ?? ''), queryFn: ({ signal }) => get<RarityRate[]>(`/packs/${encodeURIComponent(id!)}/rates`, signal), enabled: !!id, staleTime: 10 * 60_000 });

export const usePackHistory = () => useQuery({ queryKey: qk.packHistory, queryFn: ({ signal }) => get<ActionRecord[]>('/packs/history', signal) });

export function useListings(q: Record<string, string>, opts: { live?: boolean } = {}) {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  return useQuery({
    queryKey: qk.listings(q),
    queryFn: ({ signal }) => get<ListingPage>(`/market/listings?${qs}`, signal),
    placeholderData: keepPreviousData,
    // conservative: one refresh every 30 s while visible
    refetchInterval: opts.live ? 30_000 : false,
  });
}

export const useListing = (id: string | null) =>
  useQuery({ queryKey: qk.listing(id ?? ''), queryFn: ({ signal }) => get<Listing>(`/market/listings/${id}`, signal), enabled: !!id, refetchInterval: 20_000 });

export const usePrices = (cid: number | null) =>
  useQuery({ queryKey: qk.prices(cid ?? 0), queryFn: ({ signal }) => get<PriceHistory>(`/market/prices/${cid}`, signal), enabled: cid !== null, staleTime: 5 * 60_000 });

export const useProgress = (enabled = true) =>
  useQuery({ queryKey: qk.progress, queryFn: ({ signal }) => get<Progress>('/progress', signal), enabled, refetchInterval: 120_000, retry: (n, e) => !isAuthError(e) && n < 2 });

export const useActions = () => useQuery({ queryKey: qk.actions, queryFn: ({ signal }) => get<ActionRecord[]>('/actions?limit=200', signal) });
export const useEvents = () => useQuery({ queryKey: qk.events, queryFn: ({ signal }) => get<HubEvent[]>('/events?limit=200', signal) });
export const useLogs = () => useQuery({ queryKey: qk.logs, queryFn: ({ signal }) => get<LogLine[]>('/logs?limit=400', signal), refetchInterval: 10_000 });
export const useTrades = (enabled = true) =>
  useQuery({ queryKey: qk.trades, queryFn: ({ signal }) => get<TradesResponse>('/trades', signal), refetchInterval: 30_000, enabled, retry: (n, e) => !isAuthError(e) && n < 2 });
export const useSettings = () => useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => get<SettingsView>('/settings', signal) });
export const useMonitors = () => useQuery({ queryKey: qk.monitors, queryFn: ({ signal }) => get<{ pausedAll: boolean; monitors: Monitor[] }>('/monitors', signal), refetchInterval: 10_000 });
export const useFeed = () => useQuery({ queryKey: qk.feed, queryFn: ({ signal }) => get<FeedEntry[]>('/feed', signal), refetchInterval: 60_000 });
export const useSiteConfig = () => useQuery({ queryKey: qk.config, queryFn: ({ signal }) => get<KyaraSiteConfig>('/config', signal), staleTime: 10 * 60_000 });

// ------------------------------------------------------------------ writes

/** After an action, refresh what it may have changed. */
function invalidateAccount(qc: QueryClient): void {
  for (const k of [qk.me, qk.collection, qk.packs, qk.progress, qk.actions, qk.packHistory, qk.status]) void qc.invalidateQueries({ queryKey: k });
}

export function useOpenPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { packId: string; count: number; mode: 'dryRun' | 'confirm' }) =>
      post<ActionResponse<OpenSummary>>(`/packs/${encodeURIComponent(v.packId)}/open`, { count: v.count, [v.mode]: true }),
    onSettled: (_d, _e, v) => v.mode === 'confirm' && invalidateAccount(qc),
  });
}

export function useBid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; maxAmount: number; mode: 'dryRun' | 'confirm' }) =>
      post<ActionResponse<{ leading: boolean; currentBid: number | null; chakra: number }>>(`/market/listings/${v.id}/bid`, { maxAmount: v.maxAmount, [v.mode]: true }),
    onSettled: (_d, _e, v) => {
      if (v.mode !== 'confirm') return;
      invalidateAccount(qc);
      void qc.invalidateQueries({ queryKey: qk.listing(v.id) });
      void qc.invalidateQueries({ queryKey: ['listings'] });
    },
  });
}

export function useBuy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; maxPrice?: number; mode: 'dryRun' | 'confirm' }) =>
      post<ActionResponse<{ chakra: number }>>(`/market/listings/${v.id}/buy`, { maxPrice: v.maxPrice, [v.mode]: true }),
    onSettled: (_d, _e, v) => {
      if (v.mode !== 'confirm') return;
      invalidateAccount(qc);
      void qc.invalidateQueries({ queryKey: ['listings'] });
    },
  });
}

export function useCancelTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<ActionResponse<{ cancelled: boolean }>>(`/trades/${encodeURIComponent(id)}/cancel`, { confirm: true }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.trades });
      void qc.invalidateQueries({ queryKey: qk.collection });
    },
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { settings: Settings; confirm: boolean }) => put<SettingsView>('/settings', v),
    onSuccess: (view) => qc.setQueryData(qk.settings, view),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.status });
      void qc.invalidateQueries({ queryKey: qk.monitors });
    },
  });
}

export function useClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: string; id?: string }) =>
      post<ActionResponse<{ gained: { chakra?: number; bonusPacks?: number; grants: Record<string, number> }; chakra: number; claimable: number }>>('/progress/claim', { ...v, confirm: true }),
    onSettled: () => invalidateAccount(qc),
  });
}

export function useResolveAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; as: 'succeeded' | 'failed' }) => post<ActionRecord>(`/actions/${v.id}/resolve`, { as: v.as }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.actions }),
  });
}

export function useMonitorMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: qk.monitors });
  return {
    create: useMutation({ mutationFn: (m: MonitorInput) => post<Monitor>('/monitors', m), onSettled: done }),
    update: useMutation({ mutationFn: (v: { id: string; m: MonitorInput }) => put<Monitor>(`/monitors/${v.id}`, v.m), onSettled: done }),
    remove: useMutation({ mutationFn: (id: string) => del(`/monitors/${id}`), onSettled: done }),
    toggle: useMutation({ mutationFn: (v: { id: string; enabled: boolean }) => post<Monitor>(`/monitors/${v.id}/${v.enabled ? 'enable' : 'disable'}`), onSettled: done }),
    pauseAll: useMutation({ mutationFn: () => post('/automation/pause'), onSettled: () => (done(), void qc.invalidateQueries({ queryKey: qk.status })) }),
    resumeAll: useMutation({ mutationFn: () => post('/automation/resume'), onSettled: () => (done(), void qc.invalidateQueries({ queryKey: qk.status })) }),
  };
}

export function useBridgeMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: qk.status });
  return {
    createCode: useMutation({ mutationFn: () => post<{ code: string; expiresAt: number }>('/bridge/pairing-code'), onSettled: done }),
    cancelCode: useMutation({ mutationFn: () => del('/bridge/pairing-code'), onSettled: done }),
    revoke: useMutation({ mutationFn: (id: string) => del(`/bridge/clients/${id}`), onSettled: done }),
    forget: useMutation({
      mutationFn: () => post<{ ok: true; pausedAll: boolean }>('/session/forget'),
      onSettled: () => {
        for (const k of [qk.status, qk.me, qk.collection, qk.packs, qk.progress, qk.monitors]) void qc.invalidateQueries({ queryKey: k });
      },
    }),
    verify: useMutation({ mutationFn: () => post<{ valid: boolean | null; problem: string | null; user: { pseudo: string | null; chakra: number } | null }>('/session/verify'), onSettled: () => (done(), void qc.invalidateQueries({ queryKey: qk.me })) }),
  };
}

// ------------------------------------------------------------------ live updates

/** Invalidates exactly what a server event changed. Mounted once by the shell. */
export function useLiveInvalidation(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      stream.subscribe((e) => {
        qc.setQueryData<HubEvent[]>(qk.events, (old) => (old ? [e, ...old].slice(0, 200) : old));
        if (e.type.startsWith('session') || e.type.startsWith('bridge')) {
          void qc.invalidateQueries({ queryKey: qk.status });
          if (e.type === 'session.changed' || e.type === 'bridge.sync') {
            void qc.invalidateQueries({ queryKey: qk.me });
            void qc.invalidateQueries({ queryKey: qk.packs });
          }
        }
        if (e.type.startsWith('monitor') || e.type.startsWith('automation')) void qc.invalidateQueries({ queryKey: qk.monitors });
        if (e.type === 'packs.opened' || e.type === 'rewards.claimed') invalidateAccount(qc);
        if (e.type.startsWith('auction')) void qc.invalidateQueries({ queryKey: ['listings'] });
        if (e.type.startsWith('trade.')) {
          void qc.invalidateQueries({ queryKey: qk.trades });
          void qc.invalidateQueries({ queryKey: qk.monitors });
          if (e.type === 'trade.accepted') invalidateAccount(qc);
        }
      }),
    [qc],
  );
}

// ------------------------------------------------------------------ time

interface Ticker {
  subscribe: (cb: () => void) => () => void;
  read: () => number;
}
const tickers = new Map<number, Ticker>();

/** One shared clock per resolution, with stable subscribe/read functions. */
function tickerFor(resolutionMs: number): Ticker {
  let t = tickers.get(resolutionMs);
  if (t) return t;
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const subs = new Set<() => void>();
  t = {
    subscribe(cb) {
      if (!subs.size) now = Date.now(); // first subscriber after idle: never show a stale time
      subs.add(cb);
      timer ??= setInterval(() => {
        now = Date.now();
        for (const s of subs) s();
      }, resolutionMs);
      return () => {
        subs.delete(cb);
        if (!subs.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    read: () => now,
  };
  tickers.set(resolutionMs, t);
  return t;
}

/** Shared clock: one interval per resolution for the whole app (countdowns, "x ago"). */
export function useNow(resolutionMs = 1000): number {
  const t = tickerFor(resolutionMs);
  return useSyncExternalStore(t.subscribe, t.read);
}

export function useStreamState() {
  return useSyncExternalStore(
    (cb) => stream.onState(cb),
    () => stream.getState(),
  );
}
