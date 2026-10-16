import { AnimatePresence, motion } from 'motion/react';
import type { ComponentType, ReactNode } from 'react';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, UNSAFE_LocationContext, useLocation, useNavigate, useOutlet } from 'react-router';
import {
  Activity,
  ArrowLeftRight,
  Bot,
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  Gavel,
  Layers,
  LibraryBig,
  Menu,
  PackageOpen,
  Search,
  SlidersHorizontal,
  Sparkles,
  Unplug,
} from 'lucide-react';
import { useLiveInvalidation, useMe, useStatus, useStreamState } from '../lib/queries';
import { num } from '../lib/format';
import { IconButton, StatusDot, cx } from './ui';

type Icon = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

export const NAV: Array<{ group: string; items: Array<{ to: string; label: string; icon: Icon; end?: boolean }> }> = [
  { group: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: Gauge, end: true }, { to: '/missions', label: 'Missions', icon: Sparkles }] },
  { group: 'Collection', items: [{ to: '/characters', label: 'Characters', icon: LibraryBig }, { to: '/collection', label: 'My collection', icon: Layers }] },
  { group: 'Market', items: [{ to: '/market', label: 'Listings', icon: Gavel }, { to: '/trades', label: 'Trades', icon: ArrowLeftRight }] },
  { group: 'Packs', items: [{ to: '/packs', label: 'Packs', icon: PackageOpen }] },
  { group: 'Automation', items: [{ to: '/automation', label: 'Monitors', icon: Bot }] },
  { group: 'System', items: [{ to: '/session', label: 'Session & bridge', icon: Unplug }, { to: '/settings', label: 'Settings', icon: SlidersHorizontal }, { to: '/activity', label: 'Activity', icon: Activity }] },
];

const TITLES: Record<string, string> = { ...Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.to, i.label]))), '/setup': 'Setup' };

/** The scroll container of the main area, for virtualised lists. */
const ScrollCtx = createContext<React.RefObject<HTMLElement | null>>({ current: null });
export const useMainScroll = () => useContext(ScrollCtx);

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('kyara.rail') === 'collapsed';
  } catch {
    return false;
  }
}

/**
 * Keeps each visited page mounted (state, filters, scroll survive navigation).
 * The active page always renders the fresh outlet; others keep the element they had.
 * Pages read the location through hooks, so a kept element stays correct.
 */
function useKeptOutlets(section: string): Array<{ key: string; el: ReactNode }> {
  const outlet = useOutlet();
  const [kept, setKept] = useState<Record<string, ReactNode>>({});
  // "adjusting state while rendering": React re-renders immediately, no effect needed
  if (outlet && !(section in kept)) setKept((k) => ({ ...k, [section]: outlet }));
  const all = outlet ? { ...kept, [section]: outlet } : kept;
  return Object.entries(all).map(([key, el]) => ({ key, el }));
}

/** The query string to remember for a section (open-detail params are transient). */
function keptSearch(search: string): string {
  const p = new URLSearchParams(search);
  p.delete('c');
  p.delete('l');
  return p.toString();
}

export function Shell() {
  useLiveInvalidation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const { pathname, search } = useLocation();
  const section = '/' + (pathname.split('/')[1] ?? '');
  const pages = useKeptOutlets(section);

  // Each section remembers its last query string, so coming back restores its filters.
  const [lastSearch, setLastSearch] = useState<Record<string, string>>({});
  const currentKept = keptSearch(search);
  if (lastSearch[section] !== currentKept) setLastSearch((m) => ({ ...m, [section]: currentKept }));

  useEffect(() => {
    try {
      localStorage.setItem('kyara.rail', collapsed ? 'collapsed' : 'open');
    } catch {
      /* private mode */
    }
  }, [collapsed]);

  // One scroll container, many kept pages: remember each section's scroll position.
  const scrolls = useRef(new Map<string, number>());
  const current = useRef(section);
  useLayoutEffect(() => {
    current.current = section;
    if (mainRef.current) mainRef.current.scrollTop = scrolls.current.get(section) ?? 0;
  }, [section]);

  return (
    <ScrollCtx.Provider value={mainRef}>
      <a href="#main" className="sr-only-focusable fixed left-3 top-3 z-[70] rounded bg-washi px-3 py-2 text-ink-0">
        Skip to content
      </a>
      <div className="flex h-full">
        <Rail collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} lastSearch={lastSearch} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar title={TITLES[section] ?? 'Kyara'} onMenu={() => setMobileOpen(true)} />
          <main
            id="main"
            ref={mainRef}
            tabIndex={-1}
            onScroll={(e) => scrolls.current.set(current.current, e.currentTarget.scrollTop)} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden focus:outline-none" style={{ scrollbarGutter: 'stable' }}>
            {pages.map((p) => (
              <KeptPage key={p.key} active={p.key === section}>
                <FrozenLocation active={p.key === section}>{p.el}</FrozenLocation>
              </KeptPage>
            ))}
          </main>
        </div>
      </div>
    </ScrollCtx.Provider>
  );
}

/**
 * A hidden page keeps seeing the location it had when it was last active. Without this,
 * every kept page would read the CURRENT URL (and e.g. open its own drawer for ?c=).
 */
function FrozenLocation({ active, children }: { active: boolean; children: ReactNode }) {
  const live = useContext(UNSAFE_LocationContext);
  const [frozen, setFrozen] = useState(live);
  if (active && frozen !== live) setFrozen(live);
  return <UNSAFE_LocationContext.Provider value={active ? live : frozen}>{children}</UNSAFE_LocationContext.Provider>;
}

/** Pages stay mounted (state, scroll and filters survive); only the active one is shown, with a short cross-fade. */
function KeptPage({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <motion.div
      hidden={!active}
      aria-hidden={!active}
      initial={false}
      animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
      transition={{ duration: active ? 0.2 : 0, ease: [0.2, 0.8, 0.2, 1] }}
      className="mx-auto w-full max-w-[1680px] px-4 pb-16 pt-6 sm:px-6"
    >
      {children}
    </motion.div>
  );
}

function Rail({
  collapsed,
  onToggle,
  mobileOpen,
  onCloseMobile,
  lastSearch,
}: {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  lastSearch: Record<string, string>;
}) {
  const content = (isMobile: boolean) => (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className={cx('flex h-[var(--topbar-h)] items-center gap-3 px-4', collapsed && !isMobile && 'justify-center px-0')}>
        <span aria-hidden className="grid h-8 w-8 shrink-0 rotate-[-4deg] place-items-center rounded-[3px] border-2 border-seal text-[15px] font-bold text-seal">
          キ
        </span>
        {(!collapsed || isMobile) && <span className="font-display text-md font-bold tracking-tight">Kyara</span>}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV.map((g) => (
          <div key={g.group} className="mt-4 first:mt-2">
            {(!collapsed || isMobile) && <p className="px-3 pb-1 text-xs text-faint">{g.group}</p>}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={{ pathname: it.to, search: lastSearch[it.to] ? `?${lastSearch[it.to]}` : '' }}
                    onClick={isMobile ? onCloseMobile : undefined}
                    end={it.end}
                    title={collapsed && !isMobile ? it.label : undefined}
                    className={({ isActive }) =>
                      cx(
                        'relative flex h-9 items-center gap-3 rounded-[var(--radius-ctl)] px-3 text-sm transition-colors duration-150',
                        collapsed && !isMobile && 'justify-center px-0',
                        isActive ? 'text-washi' : 'text-washi-dim hover:bg-ink-2 hover:text-washi',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <motion.span
                            layoutId={isMobile ? 'nav-active-m' : 'nav-active'}
                            className="absolute inset-0 rounded-[var(--radius-ctl)] bg-ink-3"
                            transition={{ type: 'spring', stiffness: 500, damping: 42 }}
                          />
                        )}
                        <it.icon size={17} className="relative shrink-0" aria-hidden />
                        {(!collapsed || isMobile) && <span className="relative truncate">{it.label}</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {!isMobile && (
        <div className={cx('border-t border-line p-2', collapsed && 'flex justify-center')}>
          <IconButton icon={collapsed ? ChevronsRight : ChevronsLeft} label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggle} aria-expanded={!collapsed} />
        </div>
      )}
    </nav>
  );

  return (
    <>
      <motion.aside
        className="hidden shrink-0 overflow-hidden border-r border-line bg-ink-1 md:block"
        initial={false}
        animate={{ width: collapsed ? 64 : 232 }}
        transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
      >
        {content(false)}
      </motion.aside>
      <AnimatePresence>
        {mobileOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <motion.div className="absolute inset-0 bg-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCloseMobile} />
            <motion.aside
              className="absolute inset-y-0 left-0 w-[260px] bg-ink-1 shadow-[var(--shadow-pop)]"
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
            >
              {content(true)}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

function TopBar({ title, onMenu }: { title: string; onMenu: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-line bg-ink-0 px-3 sm:px-5">
      <IconButton icon={Menu} label="Open navigation" onClick={onMenu} className="md:hidden" />
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={title}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16 }}
          className="hidden min-w-0 truncate text-md font-bold sm:block"
          aria-live="polite"
        >
          {title}
        </motion.p>
      </AnimatePresence>
      <form
        role="search"
        className="ml-auto flex w-full max-w-[340px] items-center"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) navigate(`/characters?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label htmlFor="global-search" className="sr-only">
          Search characters
        </label>
        <div className="relative w-full">
          <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            id="global-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a character"
            className="h-9 w-full rounded-[var(--radius-ctl)] border border-line bg-ink-1 pl-9 pr-3 text-sm text-washi placeholder:text-faint hover:border-line-strong focus:border-focus focus:outline-none"
          />
        </div>
      </form>
      <SessionPill />
    </header>
  );
}

function SessionPill() {
  const status = useStatus();
  const streamState = useStreamState();
  const loggedIn = !!status.data?.session.hasToken;
  const me = useMe(loggedIn);
  const navigate = useNavigate();
  const offline = status.isError || streamState === 'offline';
  const bridged = (status.data?.bridge.clients.length ?? 0) > 0;
  let tone: 'ok' | 'warn' | 'bad' | 'idle' = 'idle';
  let label = 'Connecting…';
  if (offline) {
    tone = 'bad';
    label = 'Bot offline';
  } else if (status.data) {
    if (!loggedIn) {
      tone = 'warn';
      label = 'No session';
    } else {
      tone = bridged ? 'ok' : 'warn';
      label = status.data.session.user?.pseudo ?? 'Logged in';
    }
  }
  return (
    <button
      type="button"
      onClick={() => navigate('/session')}
      className="flex h-9 shrink-0 items-center gap-2.5 rounded-[var(--radius-ctl)] border border-line px-3 text-sm hover:border-line-strong hover:bg-ink-1"
      aria-label={`Session: ${label}${me.data ? `, ${me.data.wallet.chakra} chakra` : ''}. Open session settings`}
    >
      <StatusDot tone={tone} />
      <span className="max-w-[12ch] truncate">{label}</span>
      {me.data && (
        <span className="num hidden border-l border-line pl-2.5 text-washi-dim lg:inline">
          {num(me.data.wallet.chakra)} <span className="text-faint">chakra</span>
        </span>
      )}
    </button>
  );
}
