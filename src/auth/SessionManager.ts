import fs from 'node:fs';
import { KyaraApi } from '../api/KyaraApi.js';
import type { HttpClientOptions } from '../api/KyaraHttpClient.js';
import { KyaraHttpClient } from '../api/KyaraHttpClient.js';
import type { Me } from '../api/schemas/account.js';
import type { BrowserManager } from '../browser/BrowserManager.js';
import { AuthRequiredError, KyaraError, UsageError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { BotSessionView, SyncRequest, SyncResponse } from '../bridge/protocol.js';
import { Mutex } from '../utils/mutex.js';
import { MIN_REMAINING_MS, validatePass } from './PassManager.js';
import type { StoredSession, SessionStore } from './SessionStore.js';
import { fingerprint } from './SessionStore.js';

const DEVICE_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** localStorage keys used by the site (from its client bundle). */
export const SITE_STORAGE = { token: 'kyara_token', device: 'kyara_device', pass: 'kyara_pass' } as const;

export interface SessionStatus {
  hasToken: boolean;
  source: string;
  savedAt: string | null;
  valid: boolean | null;
  user: { id: string; pseudo: string | null; discordLinked: boolean; chakra: number } | null;
  problem: string | null;
  passValidForMs: number | null;
}

export interface LoginOptions {
  /** Accept a guest (not Discord-linked) account. Default false: wait for Discord login. */
  allowGuest?: boolean;
  timeoutMs?: number;
}

export class SessionManager {
  /** Serialises every session mutation (bridge syncs, imports, logout). */
  private readonly lock = new Mutex();
  /** Fingerprints of tokens Kyara refused: never asked for again (prevents a resend loop). Bounded. */
  private readonly rejectedTokenFps = new Set<string>();
  /**
   * Fingerprints of valid tokens for a different account than the bot's. They are never
   * adopted silently: the bot keeps its account until the user forgets the session.
   */
  private readonly otherAccountFps = new Set<string>();

  constructor(
    private readonly store: SessionStore,
    private readonly api: KyaraApi,
    private readonly httpOptions: Omit<HttpClientOptions, 'credentials'>,
    private readonly log: Logger,
    private readonly browserFactory: () => BrowserManager,
    private readonly browserProfileDir: string,
  ) {}

  /** Notified on every session change. Listeners receive no secrets, only the public view. */
  onChange(fn: (view: BotSessionView) => void): () => void {
    return this.store.onChange(() => fn(this.view()));
  }

  /** Credential-free summary of the current session, safe for UIs and the extension. */
  view(): BotSessionView {
    const s = this.store.load();
    const token = this.store.token();
    const passLeft = s.pass ? s.pass.expiresAt - Date.now() : 0;
    return {
      hasToken: !!token,
      tokenMatches: null,
      pseudo: token ? (s.user?.pseudo ?? null) : null,
      passValidForMs: passLeft > MIN_REMAINING_MS ? passLeft : null,
    };
  }

  /**
   * Applies session material from the browser extension or the app's Kyara window. A token
   * is stored only after `/api/me` accepts it, and `accepted` reports only what was
   * validated and stored.
   */
  applyBridgeSync(req: SyncRequest, source: 'bridge' | 'app' = 'bridge'): Promise<SyncResponse> {
    return this.lock.run(async () => {
      const accepted = { token: false, pass: false, device: false };
      const problems: string[] = [];
      const before = this.store.load();
      // once the bot has no session, a token for any account may be adopted again
      if (!this.store.token()) this.otherAccountFps.clear();

      if (req.loggedOut) {
        // The site has no session any more: drop the pass, and the token if it came from a
        // sync. An imported token may be a different session and is kept.
        const patch: Partial<StoredSession> = { pass: null };
        if (before.source === 'bridge' || before.source === 'app') Object.assign(patch, { token: null, user: null, source: 'none', invalidatedAt: null });
        this.store.update(patch);
        return { needToken: false, accepted, problems, session: this.viewWith(null) };
      }

      if (req.deviceId != null && req.deviceId !== before.deviceId) {
        if (DEVICE_ID.test(req.deviceId)) {
          this.store.update({ deviceId: req.deviceId });
          accepted.device = true;
        } else problems.push('device id rejected (unexpected format)');
      }

      const currentFp = this.store.tokenFingerprint();
      if (req.token) {
        if (req.tokenFp && fingerprint(req.token) !== req.tokenFp) problems.push('token does not match its fingerprint');
        else if (this.store.tokenSource() === 'env') problems.push('KYARA_TOKEN is set in the environment; it takes precedence');
        else if (fingerprint(req.token) === currentFp) accepted.token = true;
        else if (this.rejectedTokenFps.has(fingerprint(req.token)) || this.otherAccountFps.has(fingerprint(req.token))) {
          problems.push('this session was already refused (guest, rejected or another account)');
        } else {
          const me = await this.validateToken(req.token);
          const bound = (set: Set<string>, fp: string) => {
            if (set.size >= 64) set.delete(set.values().next().value as string);
            set.add(fp);
          };
          if (!me) {
            problems.push('the server rejected the token');
            bound(this.rejectedTokenFps, fingerprint(req.token));
          } else if (!me.discord) {
            // Kyara creates a guest account for anyone not logged in yet: never adopt one from a sync,
            // or the real account the user logs in with next would be refused as "another account".
            problems.push(`${me.pseudo ?? 'this'} is a Kyara guest account (created before you log in). Log in with Discord; guest sessions are not used.`);
            bound(this.rejectedTokenFps, fingerprint(req.token));
          } else if (this.store.token() && before.user?.id && before.user.id !== me.id && before.user.discordLinked !== false) {
            // Never switch the bot (and its monitors, auto-bids, claims) to another account silently.
            problems.push(
              `this browser is logged in as ${me.pseudo ?? 'another account'}, but the bot uses ${before.user.pseudo ?? 'a different account'}. Forget the bot's session (Session page) to switch.`,
            );
            bound(this.otherAccountFps, fingerprint(req.token));
            this.log.warn('Ignored a browser session for a different Kyara account than the bot uses.');
          } else {
            this.store.update({
              token: req.token,
              source,
              savedAt: new Date().toISOString(),
              invalidatedAt: null,
              user: { id: me.id, pseudo: me.pseudo ?? null, discordLinked: !!me.discord },
              // a pass belongs to the session that obtained it
              pass: null,
            });
            accepted.token = true;
            const replaced = before.user && before.user.id !== me.id ? ` (replaces the guest account ${before.user.pseudo ?? ''})` : '';
            this.log.info(`Session synchronised from ${source === 'app' ? "the app's Kyara window" : 'the browser extension'} (${me.pseudo ?? me.id})${replaced}.`);
          }
        }
      }

      const fpNow = this.store.tokenFingerprint();
      const tokenMatches = req.tokenFp !== null && fpNow !== null && req.tokenFp === fpNow;
      if (req.pass) {
        if (!tokenMatches) problems.push('pass ignored: it belongs to a different session than the bot');
        else {
          try {
            const pass = validatePass(req.pass);
            if (this.store.load().pass?.pass !== pass.pass) this.store.update({ pass });
            accepted.pass = true;
          } catch (err) {
            problems.push((err as Error).message);
          }
        }
      }

      return {
        needToken:
          req.tokenFp !== null && !tokenMatches && !accepted.token && !this.rejectedTokenFps.has(req.tokenFp) && !this.otherAccountFps.has(req.tokenFp),
        accepted,
        problems,
        session: this.viewWith(req.tokenFp),
      };
    });
  }

  /** The desktop app's Kyara window: the site's three localStorage values, validated like an extension sync. */
  applySiteSnapshot(snap: { token: string | null; deviceId: string | null; pass: { pass: string; expiresAt: number } | null }): Promise<SyncResponse> {
    // logged out in the app window: only a session that came from that window is dropped
    if (!snap.token) {
      if (this.store.load().source === 'app') return this.applyBridgeSync({ tokenFp: null, loggedOut: true }, 'app');
      return Promise.resolve({ needToken: false, accepted: { token: false, pass: false, device: false }, problems: [], session: this.viewWith(null) });
    }
    return this.applyBridgeSync({ tokenFp: fingerprint(snap.token), token: snap.token, deviceId: snap.deviceId, pass: snap.pass }, 'app');
  }

  /**
   * Forgets the session locally without revoking it on Kyara, since a browser may share it.
   * A later sync may then provide a session for another account.
   */
  forget(): Promise<void> {
    return this.lock.run(async () => {
      this.store.clear();
      this.otherAccountFps.clear();
      this.rejectedTokenFps.clear();
    });
  }

  private viewWith(tokenFp: string | null): BotSessionView {
    const fp = this.store.tokenFingerprint();
    return { ...this.view(), tokenMatches: tokenFp === null || fp === null ? null : tokenFp === fp };
  }

  async status(checkServer = true): Promise<SessionStatus> {
    const s = this.store.load();
    const token = this.store.token();
    const pass = s.pass && s.pass.expiresAt > Date.now() ? s.pass.expiresAt - Date.now() : null;
    const base: SessionStatus = {
      hasToken: !!token,
      source: this.store.tokenSource(),
      savedAt: s.savedAt,
      valid: null,
      user: s.user ? { ...s.user, chakra: NaN } : null,
      problem: s.invalidatedAt ? `Token rejected by the server at ${s.invalidatedAt}` : null,
      passValidForMs: pass,
    };
    if (!token || !checkServer) return base;
    try {
      const me = await this.api.account.me();
      return { ...base, valid: true, user: summarise(me), problem: null };
    } catch (err) {
      if (err instanceof AuthRequiredError) return { ...base, valid: false, problem: err.message };
      return { ...base, problem: `Could not verify: ${(err as Error).message}` };
    }
  }

  /**
   * Opens a visible browser on kyara.games and waits for the user to log in. The token is
   * taken from the page's localStorage once it belongs to a Discord-linked account.
   */
  async loginWithBrowser(opts: LoginOptions = {}): Promise<Me> {
    const browser = this.browserFactory();
    if (browser.isHeadless) {
      throw new UsageError('Login needs a visible browser. Unset KYARA_HEADLESS (or set it to false) and retry.');
    }
    try {
      await browser.open('/');
      this.log.info('A browser window opened on Kyara. In that window:');
      this.log.info('  1. If Cloudflare shows "Vérifiez que vous êtes humain", tick the box.');
      this.log.info('  2. Log in with Discord (account button, top right) and authorise Kyara.');
      this.log.info('  3. Wait until this terminal says you are logged in, then the window closes by itself.');
      this.log.info('The bot only reads the token the site stores after login. It never sees your Discord password.');
      let warnedGuest = false;
      let lastToken: string | null = null;
      let lastCheck = 0;
      const result = await browser.waitForHuman(
        'log in with Discord on kyara.games',
        async () => {
          // Never navigate here: the user may be on discord.com mid-login.
          const ls = await browser.peekLocalStorage([SITE_STORAGE.token, SITE_STORAGE.device]);
          const token = ls?.[SITE_STORAGE.token];
          if (!ls || !token) return null;
          // localStorage is read locally every poll; the server is asked again only when the
          // token changes, or every 15 s (Discord linking can keep the same token).
          if (token === lastToken && Date.now() - lastCheck < 15_000) return null;
          lastToken = token;
          lastCheck = Date.now();
          const me = await this.validateToken(token, ls[SITE_STORAGE.device] ?? undefined);
          if (!me) return null;
          const linked = !!me.discord;
          if (!linked && !opts.allowGuest) {
            if (!warnedGuest) this.log.info('Currently a guest session. Waiting for Discord login to finish…');
            warnedGuest = true;
            return null;
          }
          return { token, deviceId: ls[SITE_STORAGE.device], me };
        },
        { timeoutMs: opts.timeoutMs ?? 10 * 60_000, intervalMs: 2500 },
      );
      this.store.update({
        token: result.token,
        deviceId: result.deviceId ?? this.store.load().deviceId,
        source: 'browser',
        savedAt: new Date().toISOString(),
        invalidatedAt: null,
        user: { id: result.me.id, pseudo: result.me.pseudo ?? null, discordLinked: !!result.me.discord },
        pass: null,
      });
      this.log.info(`Logged in as ${result.me.pseudo ?? result.me.id}. Session saved to ${this.store.filePath}.`);
      return result.me;
    } finally {
      await browser.close();
    }
  }

  /** Stores a token copied by hand (DevTools -> Application -> Local Storage -> kyara_token). */
  importToken(token: string, deviceId?: string): Promise<Me> {
    return this.lock.run(() => this.importTokenUnlocked(token, deviceId));
  }

  private async importTokenUnlocked(token: string, deviceId?: string): Promise<Me> {
    const trimmed = token.trim().replace(/^"|"$/g, '');
    if (trimmed.length < 8 || /\s/.test(trimmed)) throw new UsageError('That does not look like a Kyara token.');
    const me = await this.validateToken(trimmed, deviceId);
    if (!me) throw new AuthRequiredError('The server rejected this token.');
    this.store.update({
      token: trimmed,
      ...(deviceId ? { deviceId } : {}),
      source: 'manual',
      savedAt: new Date().toISOString(),
      invalidatedAt: null,
      user: { id: me.id, pseudo: me.pseudo ?? null, discordLinked: !!me.discord },
      pass: null,
    });
    return me;
  }

  /**
   * Logs out: revokes the token server-side (the site's own POST /auth/logout), then
   * deletes it locally. With `wipeBrowser`, also deletes the bot's browser profile.
   */
  logout(opts: { wipeBrowser?: boolean } = {}): Promise<{ revoked: boolean }> {
    return this.lock.run(() => this.logoutUnlocked(opts));
  }

  private async logoutUnlocked(opts: { wipeBrowser?: boolean }): Promise<{ revoked: boolean }> {
    let revoked = false;
    if (this.store.token() && this.store.tokenSource() !== 'env') {
      try {
        await this.api.account.logout();
        revoked = true;
      } catch (err) {
        this.log.warn('Server-side logout failed; the local session is removed anyway.', { error: (err as Error).message });
      }
    }
    this.store.clear();
    if (opts.wipeBrowser && fs.existsSync(this.browserProfileDir)) {
      fs.rmSync(this.browserProfileDir, { recursive: true, force: true });
    }
    if (this.store.tokenSource() === 'env') {
      this.log.warn('KYARA_TOKEN is set in the environment; remove it from .env to fully log out.');
    }
    return { revoked };
  }

  /** Null when Kyara rejects the token; any other failure throws. */
  async validateToken(token: string, deviceId?: string): Promise<Me | null> {
    const client = new KyaraHttpClient({
      ...this.httpOptions,
      credentials: { getToken: () => token, getDeviceId: () => deviceId ?? this.store.deviceId() },
    });
    try {
      return await new KyaraApi(client).account.me();
    } catch (err) {
      if (err instanceof AuthRequiredError) return null;
      if (err instanceof KyaraError) throw err;
      throw new KyaraError(`Could not validate the token: ${(err as Error).message}`);
    }
  }
}

function summarise(me: Me): NonNullable<SessionStatus['user']> {
  return { id: me.id, pseudo: me.pseudo ?? null, discordLinked: !!me.discord, chakra: me.chakra };
}
