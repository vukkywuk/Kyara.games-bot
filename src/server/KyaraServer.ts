import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import type { KyaraBot } from '../bot.js';
import type { Logger } from '../utils/logger.js';
import { AppApi } from './AppApi.js';
import { BridgeService } from './BridgeService.js';
import type { EventHub } from './EventHub.js';
import { HttpError, baseHeaders, isAllowedHost, isLoopbackAddress, parseJson, readBody, sendError, sendJson } from './http.js';
import { MonitorService } from './MonitorService.js';

export interface ServerOptions {
  port: number;
  /** Built web app (web/dist). When missing, only the APIs are served. */
  webRoot: string | null;
  /** Extra origin allowed to call the app API (the Vite dev server in development). */
  devOrigin?: string | null;
  version: string;
}

const APP_BODY_LIMIT = 16 * 1024;
const BRIDGE_BODY_LIMIT = 8 * 1024;
export const APP_TOKEN_HEADER = 'x-kyara-app-token';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Motion writes inline transform/opacity styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://s4.anilist.co https://cdn.discordapp.com",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/**
 * One loopback HTTP server for the three local surfaces:
 *   /bridge/*   the browser extension (HMAC-signed, see src/bridge/protocol.ts)
 *   /app-api/*  the web app (Host + Origin checks + per-run app token in a custom header)
 *   /*          the built web app (static, strict CSP)
 */
export class KyaraServer {
  readonly bridge: BridgeService;
  readonly monitors: MonitorService;
  readonly api: AppApi;
  private server: http.Server | null = null;
  private sockets = new Set<Socket>();
  private sseClients = new Set<ServerResponse>();
  private readonly appToken = randomBytes(32).toString('base64url');
  private readonly startedAt = new Date().toISOString();
  private readonly log: Logger;
  private port = 0;

  constructor(
    private readonly bot: KyaraBot,
    private readonly hub: EventHub,
    private readonly opts: ServerOptions,
  ) {
    this.log = bot.log.child('server');
    this.bridge = new BridgeService(path.join(bot.config.dataDir, 'bridge.json'), bot.session, bot.log.child('bridge'), {
      onEvent: (type, data) => this.onBridgeEvent(type, data),
    });
    this.monitors = new MonitorService(bot, hub, path.join(bot.config.dataDir, 'monitors.json'));
    this.api = new AppApi(bot, this.bridge, this.monitors, hub, this.startedAt, opts.version);
    bot.session.onChange((view) => {
      this.hub.publish({ type: 'session.changed', level: 'info', title: 'Session updated', data: { bot: view } });
      // monitors waiting for a session (or stopped by an auth error) resume by themselves
      if (view.hasToken && this.server) this.monitors.startEnabled();
    });
  }

  get address(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.route(req, res).catch((err: unknown) => {
        if (!res.headersSent) sendError(req, res, err);
        else res.destroy();
      });
    });
    server.on('connection', (s) => {
      // The server listens on 127.0.0.1; non-loopback peers are refused here as well.
      if (!isLoopbackAddress(s.remoteAddress)) {
        s.destroy();
        return;
      }
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.monitors.startEnabled();
    this.log.info(`Listening on ${this.address} (loopback only)`);
  }

  async stop(): Promise<void> {
    await this.monitors.shutdown();
    for (const c of this.sseClients) c.end();
    this.sseClients.clear();
    const srv = this.server;
    this.server = null;
    if (srv) {
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        for (const s of this.sockets) s.destroy();
      });
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, 'forbidden', 'Loopback only');
    if (!isAllowedHost(req.headers.host, this.port)) throw new HttpError(421, 'bad_host', 'Unexpected Host header');
    const url = new URL(req.url ?? '/', this.address);
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      // No CORS. Preflights are refused, so browsers block cross-origin calls with custom headers.
      res.writeHead(403, baseHeaders());
      res.end();
      return;
    }
    if (url.pathname.startsWith('/bridge/')) return this.routeBridge(req, res, url, method);
    if (url.pathname.startsWith('/app-api/')) return this.routeApp(req, res, url, method);
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    return this.serveStatic(req, res, url.pathname);
  }

  private async routeBridge(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const raw = method === 'GET' || method === 'DELETE' ? '' : await readBody(req, BRIDGE_BODY_LIMIT);
    if (url.pathname === '/bridge/pair' && method === 'POST') {
      sendJson(req, res, 200, this.bridge.pair(parseJson(raw), origin));
      return;
    }
    const client = await this.bridge.authenticate(req.headers, method, url.pathname, raw, origin);
    if (url.pathname === '/bridge/status' && method === 'GET') return sendJson(req, res, 200, this.bridge.status(client));
    if (url.pathname === '/bridge/sync' && method === 'POST') return sendJson(req, res, 200, await this.bridge.sync(client, parseJson(raw)));
    if (url.pathname === '/bridge/pair' && method === 'DELETE') {
      this.bridge.unpair(client.id);
      return sendJson(req, res, 200, { ok: true });
    }
    throw new HttpError(404, 'not_found', 'Unknown bridge operation');
  }

  private async routeApp(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const sub = url.pathname.slice('/app-api'.length);

    // The token is handed only to same-origin pages: other sites can neither read it
    // (no CORS) nor forge requests (they cannot set the custom header without a preflight).
    if (sub === '/token' && method === 'GET') {
      // Browsers send Sec-Fetch-Site; only our own page may read the token. A missing header
      // means a non-browser local client, which is inside the trust boundary anyway.
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'forbidden', 'Same-origin only');
      sendJson(req, res, 200, { token: this.appToken });
      return;
    }
    this.checkAppToken(req);
    if (method !== 'GET') this.checkOrigin(req);

    if (sub === '/stream' && method === 'GET') return this.openStream(req, res);

    const raw = method === 'GET' || method === 'DELETE' ? '' : await readBody(req, APP_BODY_LIMIT);
    const { body, etag } = await this.api.handle({ method, path: sub, query: url.searchParams, body: parseJson(raw) });
    if (etag) {
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ...baseHeaders(), etag });
        res.end();
        return;
      }
      res.setHeader('etag', etag);
      sendJson(req, res, 200, body, 'private, no-cache');
      return;
    }
    sendJson(req, res, 200, body);
  }

  private checkAppToken(req: IncomingMessage): void {
    const given = req.headers[APP_TOKEN_HEADER];
    const a = Buffer.from(typeof given === 'string' ? given : '');
    const b = Buffer.from(this.appToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'app_unauthorized', 'Missing or invalid app token');
  }

  private checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    const allowed = new Set([this.address, `http://localhost:${this.port}`, ...(this.opts.devOrigin ? [this.opts.devOrigin] : [])]);
    if (typeof origin !== 'string' || !allowed.has(origin)) throw new HttpError(403, 'bad_origin', 'Unexpected Origin');
  }

  /** Server-sent events over a normal fetch (so the app token stays in a header, not the URL). */
  private openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { ...baseHeaders(), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`retry: 3000\n\n`);
    this.sseClients.add(res);
    const unsubscribe = this.hub.subscribe((e) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(`: ping\n\n`), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      this.sseClients.delete(res);
    });
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const root = this.opts.webRoot;
    if (!root || !fs.existsSync(path.join(root, 'index.html'))) {
      res.writeHead(200, { ...baseHeaders(), 'content-type': 'text/plain; charset=utf-8' });
      res.end('Kyara bot server is running. The web app is not built yet: run `npm run web:build`.\n');
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'bad_request', 'Malformed path');
    }
    const target = path.resolve(root, '.' + decoded);
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) throw new HttpError(403, 'forbidden', 'Forbidden');
    // Only regular files are served (Windows device names like "aux" are not files).
    const isFile = (() => {
      try {
        return fs.statSync(target).isFile();
      } catch {
        return false;
      }
    })();
    const file = isFile ? target : path.join(root, 'index.html'); // SPA fallback
    const ext = path.extname(file);
    const headers: Record<string, string> = {
      ...baseHeaders(),
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-security-policy': CSP,
      'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return void res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  private onBridgeEvent(type: string, data: Record<string, unknown>): void {
    const titles: Record<string, string> = {
      'bridge.pairing': 'Pairing code created',
      'bridge.paired': 'Browser extension paired',
      'bridge.unpaired': 'Browser extension unpaired',
      'bridge.sync': 'Session synchronised from the browser',
    };
    const problems = Array.isArray(data.problems) ? (data.problems as string[]) : [];
    this.hub.publish({
      type,
      level: type === 'bridge.paired' ? 'success' : problems.length ? 'warn' : 'info',
      title: titles[type] ?? type,
      detail: problems.join('; ') || undefined,
      data,
    });
  }
}
