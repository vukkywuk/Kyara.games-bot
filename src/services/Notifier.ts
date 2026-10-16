export interface BotEvent {
  type: string;
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
  at?: string;
}

export interface Notifier {
  notify(event: BotEvent): void;
}

/** Writes events to stdout, one line each (or JSON lines with `json: true`). */
export class ConsoleNotifier implements Notifier {
  constructor(
    private readonly json = false,
    private readonly write: (s: string) => void = (s) => process.stdout.write(s + '\n'),
  ) {}

  notify(e: BotEvent): void {
    const at = e.at ?? new Date().toISOString();
    if (this.json) return this.write(JSON.stringify({ ...e, at }));
    const time = new Date(at).toLocaleTimeString();
    this.write(`${time}  ${e.type.padEnd(18)} ${e.title}${e.detail ? ` — ${e.detail}` : ''}`);
  }
}

export class MemoryNotifier implements Notifier {
  readonly events: BotEvent[] = [];
  notify(e: BotEvent): void {
    this.events.push(e);
  }
}
