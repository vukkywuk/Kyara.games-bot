import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BotOverrides } from '../src/bot.js';
import { createKyaraBot } from '../src/bot.js';
import { loadConfig } from '../src/config/config.js';
import type { Transport, TransportRequest, TransportResponse } from '../src/api/transport.js';
import { TransportFailure } from '../src/api/transport.js';
import { silentLogger } from '../src/utils/logger.js';

export const fixture = <T = unknown>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')) as T;

export type Reply =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | { fail: 'timeout' | 'network'; notSent?: boolean };

type Handler = Reply | ((req: TransportRequest, n: number) => Reply | Promise<Reply>);

/**
 * Scripted transport: routes are "METHOD /path" (query ignored). A route can hold one
 * reply, a list consumed in order (last one repeats), or a function.
 */
export class MockTransport implements Transport {
  readonly name = 'mock';
  readonly requests: TransportRequest[] = [];
  private routes = new Map<string, Handler[]>();
  private patterns: Array<{ re: RegExp; h: Handler }> = [];
  private counts = new Map<string, number>();

  on(route: string, ...replies: Handler[]): this {
    this.routes.set(route, replies);
    return this;
  }

  /** Route by regular expression on "METHOD /path" (checked after exact routes). */
  onMatch(re: RegExp, h: Handler): this {
    this.patterns.push({ re, h });
    return this;
  }

  calls(route: string): TransportRequest[] {
    return this.requests.filter((r) => key(r) === route);
  }

  async send(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    const k = key(req);
    let handlers = this.routes.get(k);
    if (!handlers) {
      const p = this.patterns.find((x) => x.re.test(k));
      if (p) handlers = [p.h];
    }
    if (!handlers) return respond({ status: 404, body: { error: 'not_found', message: `no mock for ${k}` } });
    const n = this.counts.get(k) ?? 0;
    this.counts.set(k, n + 1);
    const h = handlers[Math.min(n, handlers.length - 1)]!;
    const reply = await (typeof h === 'function' ? h(req, n) : h);
    if ('fail' in reply) throw new TransportFailure(`mock ${reply.fail}`, reply.fail, !!reply.notSent);
    return respond(reply);
  }
}

function key(r: TransportRequest): string {
  const u = new URL(r.url);
  return `${r.method} ${u.pathname.replace(/^\/api/, '')}`;
}

function respond(r: { status?: number; body?: unknown; headers?: Record<string, string> }): TransportResponse {
  const headers = new Map(Object.entries({ date: new Date().toUTCString(), ...r.headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: r.status ?? 200,
    headers: { get: (n) => headers.get(n.toLowerCase()) ?? null },
    text: r.body === undefined ? '' : JSON.stringify(r.body),
  };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyara-test-'));
}

export interface TestBotOptions {
  token?: string | null;
  env?: Record<string, string>;
  overrides?: BotOverrides;
}

export function makeBot(transport: MockTransport, opts: TestBotOptions = {}) {
  const dir = tempDir();
  const config = loadConfig(
    {
      KYARA_DATA_DIR: dir,
      KYARA_MIN_INTERVAL_MS: '50',
      KYARA_MAX_RETRIES: '3',
      ...(opts.token === null ? {} : { KYARA_TOKEN: opts.token ?? 'test-token-abcdef123456' }),
      ...opts.env,
    },
    dir,
  );
  const bot = createKyaraBot(config, {
    logger: silentLogger,
    transport,
    sleep: async () => undefined,
    verifier: { turnstileToken: async () => 'turnstile-token' },
    ...opts.overrides,
  });
  return { bot, dir };
}

export const ME = {
  id: '00000000-0000-4000-8000-00000000aaaa',
  pseudo: 'tester',
  chakra: 1000,
  freePacks: 0,
  freePacksMax: 10,
  bonusPacks: 0,
  grants: {},
  goldenIn: 7,
  discord: { avatar: null },
};

export const card = (id: number, rarity = 'C', extra: Record<string, unknown> = {}) => ({
  id,
  name: `Card ${id}`,
  native: null,
  image: null,
  favourites: 1,
  num: `#${id}/6736`,
  pow: 50,
  rank: id,
  rarity,
  series: 'Test Series',
  aura: 10,
  ...extra,
});

export const openResult = (chakra: number, cards = [card(1), card(2, 'R', { isNew: true })]) => ({
  user: { ...ME, chakra },
  cards,
  godPack: false,
  golden: false,
});
