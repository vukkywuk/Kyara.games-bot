import type { BotEvent, Notifier } from '../services/Notifier.js';
import { redact, redactString } from '../utils/redact.js';

export type EventLevel = 'info' | 'success' | 'warn' | 'error';

export interface HubEvent {
  id: number;
  at: string;
  type: string;
  level: EventLevel;
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface LogLine {
  id: number;
  at: string;
  line: string;
}

/** In-memory event and log buffers with live subscribers (server-sent events). */
export class EventHub {
  private seq = 0;
  private events: HubEvent[] = [];
  private logs: LogLine[] = [];
  private subscribers = new Set<(e: HubEvent) => void>();

  constructor(
    private readonly maxEvents = 300,
    private readonly maxLogs = 600,
  ) {}

  publish(e: Omit<HubEvent, 'id' | 'at'> & { at?: string }): HubEvent {
    const ev: HubEvent = {
      ...e,
      title: redactString(e.title),
      detail: e.detail ? redactString(e.detail) : undefined,
      data: e.data ? redact(e.data) : undefined,
      id: ++this.seq,
      at: e.at ?? new Date().toISOString(),
    };
    this.events.push(ev);
    if (this.events.length > this.maxEvents) this.events.shift();
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch {
        /* a broken subscriber is dropped by its owner */
      }
    }
    return ev;
  }

  /** Log lines arrive already redacted by the logger; redacted again as defence in depth. */
  log(line: string): void {
    this.logs.push({ id: ++this.seq, at: new Date().toISOString(), line: redactString(line) });
    if (this.logs.length > this.maxLogs) this.logs.shift();
  }

  recentEvents(limit = 100, type?: string): HubEvent[] {
    const list = type ? this.events.filter((e) => e.type.startsWith(type)) : this.events;
    return list.slice(-limit).reverse();
  }

  recentLogs(limit = 300): LogLine[] {
    return this.logs.slice(-limit).reverse();
  }

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

const LEVELS: Record<string, EventLevel> = {
  'auction.outbid': 'warn',
  'auction.autobid.unknown': 'error',
  'auction.autobid': 'success',
  'auction.won': 'success',
  'auction.lost': 'warn',
  'auction.target': 'success',
  'packs.autoopen.blocked': 'warn',
  'trade.sent': 'success',
  'trade.accepted': 'success',
  'trade.declined': 'warn',
  'trade.needs-pass': 'warn',
  'auction.needs-pass': 'warn',
  'trade.unknown': 'error',
  'rewards.claimed': 'success',
  'packs.opened': 'success',
  'packs.free.full': 'warn',
};

/** Adapts the existing monitors' Notifier interface to the hub. */
export class HubNotifier implements Notifier {
  constructor(
    private readonly hub: EventHub,
    private readonly source: Record<string, unknown> = {},
  ) {}

  notify(e: BotEvent): void {
    this.hub.publish({
      type: e.type,
      level: LEVELS[e.type] ?? 'info',
      title: e.title,
      detail: e.detail,
      data: { ...this.source, ...e.data },
    });
  }
}
