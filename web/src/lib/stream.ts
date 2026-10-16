import { getToken } from './api';
import type { HubEvent } from './types';

export type StreamState = 'connecting' | 'open' | 'offline';
type Listener = (e: HubEvent) => void;

/**
 * Live server events over fetch (so the app token stays in a header, not the URL).
 * Reconnects with backoff; exposes its state so the UI can show "bot offline".
 */
class EventStream {
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: StreamState) => void>();
  private state: StreamState = 'connecting';
  private started = false;
  private backoff = 1000;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    this.start();
    return () => this.listeners.delete(fn);
  }

  onState(fn: (s: StreamState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }

  getState(): StreamState {
    return this.state;
  }

  private set(s: StreamState): void {
    if (s === this.state) return;
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    for (;;) {
      try {
        const token = await getToken();
        const res = await fetch('/app-api/stream', { headers: { 'x-kyara-app-token': token }, cache: 'no-store' });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        this.set('open');
        this.backoff = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n');
            if (!data) continue;
            try {
              const ev = JSON.parse(data) as HubEvent;
              for (const fn of this.listeners) fn(ev);
            } catch {
              /* ignore malformed block */
            }
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      this.set('offline');
      await new Promise((r) => setTimeout(r, this.backoff));
      this.backoff = Math.min(this.backoff * 2, 15_000);
      this.set('connecting');
    }
  }
}

export const stream = new EventStream();
