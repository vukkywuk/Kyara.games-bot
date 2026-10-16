/**
 * Kyara Bot desktop app (Electron main process).
 *
 * Runs the same local server as `kyara serve` (127.0.0.1 only) and shows its web app in a
 * window, with a tray icon, start with Windows, and native notifications. The built-in
 * "Kyara" window is a normal browser window on kyara.games where you log in yourself; the
 * app only reads the three localStorage values the site maintains (token, device id, pass)
 * and validates them like the browser extension's sync. Nothing here touches Cloudflare:
 * the site renews its pass only while you look at it, exactly as in a normal browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Menu, Notification, Tray, app, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { WebContents } from 'electron';
import { createKyaraBot } from '../src/bot.js';
import type { KyaraBot } from '../src/bot.js';
import { BRIDGE_DEFAULT_PORT } from '../src/bridge/protocol.js';
import { fingerprint } from '../src/auth/SessionStore.js';
import { loadConfig, loadDotEnv } from '../src/config/config.js';
import { EventHub } from '../src/server/EventHub.js';
import type { HubEvent } from '../src/server/EventHub.js';
import { KyaraServer } from '../src/server/KyaraServer.js';
import { createLogger } from '../src/utils/logger.js';

const KYARA_ORIGIN = 'https://kyara.games';
const DEV = !app.isPackaged;
/** In development: the repository (shares .kyara and .env with the CLI). Packaged: the resources folder. */
const ROOT = DEV ? path.resolve(import.meta.dirname, '..', '..') : process.resourcesPath;
/** main.mjs, preload.cjs and the icons sit together (desktop/app, or app.asar when installed). */
const ASSETS = import.meta.dirname;
const startHidden = process.argv.includes('--hidden');

let bot: KyaraBot;
let hub: EventHub;
let server: KyaraServer;
let main: BrowserWindow | null = null;
let kyara: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(start).catch((err: unknown) => fatal((err as Error).message));
}

app.on('window-all-closed', () => {
  // closing windows keeps the bot running in the tray
});
app.on('before-quit', () => {
  quitting = true;
});

async function start(): Promise<void> {
  app.setAppUserModelId('Kyara Bot');
  // KYARA_DATA_DIR / KYARA_PORT override the defaults (used by the app's own tests)
  const dataDir = process.env.KYARA_DATA_DIR ? path.resolve(process.env.KYARA_DATA_DIR) : DEV ? path.join(ROOT, '.kyara') : path.join(app.getPath('userData'), 'data');
  const port = Number(process.env.KYARA_PORT) || BRIDGE_DEFAULT_PORT;
  fs.mkdirSync(dataDir, { recursive: true });
  // optional .env (developers): repository root in dev, the data folder when installed
  loadDotEnv(DEV ? path.join(ROOT, '.env') : path.join(dataDir, '.env'));
  const config = loadConfig({ ...process.env, KYARA_DATA_DIR: dataDir }, dataDir);

  hub = new EventHub();
  const logFile = path.join(dataDir, 'app.log');
  const logger = createLogger({
    level: config.logLevel,
    format: 'pretty',
    sink: (line) => {
      hub.log(line);
      appendLog(logFile, line);
    },
  });
  bot = createKyaraBot(config, { logger });
  server = new KyaraServer(bot, hub, { port, webRoot: DEV ? path.join(ROOT, 'web', 'dist') : path.join(process.resourcesPath, 'web'), version: app.getVersion() });
  try {
    await server.start();
  } catch (err) {
    const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
    return fatal(
      busy
        ? `Another Kyara bot is already running on port ${port} (probably \`npm run serve\` in a terminal). Stop it, then start the app again.`
        : (err as Error).message,
    );
  }

  hub.subscribe(notify);
  ipc();
  createTray();
  if (!startHidden) showMain();
}

// ------------------------------------------------------------------ windows

function icon(name = 'icon.png'): Electron.NativeImage {
  return nativeImage.createFromPath(path.join(ASSETS, name));
}

function showMain(route?: string): void {
  if (!server) return;
  if (!main || main.isDestroyed()) {
    main = new BrowserWindow({
      width: 1360,
      height: 880,
      minWidth: 880,
      minHeight: 600,
      title: 'Kyara Bot',
      backgroundColor: '#0f1424',
      icon: icon(),
      show: false,
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(ASSETS, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    lockToApp(main.webContents, server.address);
    main.on('page-title-updated', (e) => e.preventDefault()); // keep "Kyara Bot" in the taskbar
    main.once('ready-to-show', () => main?.show());
    main.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      main?.hide();
      once('tray-hint', () => tray?.displayBalloon?.({ title: 'Kyara Bot keeps running', content: 'Your monitors keep working. Open the app from the tray icon, or quit it there.', iconType: 'info' }));
    });
    void main.loadURL(server.address + (route ?? '/'));
    return;
  }
  if (route) void main.loadURL(server.address + route);
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

/** The app window only shows the local app; any other link opens in the default browser. */
function lockToApp(wc: WebContents, origin: string): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== origin) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
}

/** A normal window on kyara.games, with its own persistent cookies and storage. */
function openKyara(): void {
  if (kyara && !kyara.isDestroyed()) {
    if (kyara.isMinimized()) kyara.restore();
    kyara.show();
    kyara.focus();
    return;
  }
  kyara = new BrowserWindow({
    width: 1240,
    height: 880,
    title: 'Kyara',
    icon: icon(),
    autoHideMenuBar: true,
    backgroundColor: '#0f1424',
    webPreferences: { partition: 'persist:kyara', contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const wc = kyara.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    const host = safeHost(url);
    // Discord login may use a popup: keep it in the same session
    if (host === 'kyara.games' || host === 'discord.com' || host?.endsWith('.discord.com')) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: 'persist:kyara', contextIsolation: true, sandbox: true } } };
    }
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const sync = () => void syncFromKyara();
  wc.on('did-finish-load', sync);
  wc.on('did-navigate-in-page', sync);
  kyara.on('focus', sync);
  const timer = setInterval(sync, 15_000);
  kyara.on('closed', () => {
    clearInterval(timer);
    kyara = null;
  });
  void kyara.loadURL(KYARA_ORIGIN);
}

let lastSync = '';
let lastProblems = '';
let syncing = false;
/** Reads kyara_token / kyara_device / kyara_pass from the Kyara window and hands them to the session manager. */
async function syncFromKyara(): Promise<void> {
  if (!kyara || kyara.isDestroyed() || syncing) return;
  const wc = kyara.webContents;
  if (safeOrigin(wc.getURL()) !== KYARA_ORIGIN) return;
  syncing = true;
  try {
    // an isolated world: same storage as the page, but the page's scripts cannot tamper with the reader
    const snap = (await wc.executeJavaScriptInIsolatedWorld(1001, [
      {
        code: `(() => {
          const g = (k) => localStorage.getItem(k);
          let pass = null;
          try {
            const p = JSON.parse(g('kyara_pass') || 'null');
            if (p && typeof p.pass === 'string' && typeof p.expiresAt === 'number') pass = { pass: p.pass, expiresAt: p.expiresAt };
          } catch {}
          return { token: g('kyara_token'), deviceId: g('kyara_device'), pass };
        })()`,
      },
    ])) as { token: string | null; deviceId: string | null; pass: { pass: string; expiresAt: number } | null };
    const key = [snap.token ? fingerprint(snap.token) : '-', snap.deviceId ?? '-', snap.pass ? fingerprint(snap.pass.pass) : '-'].join(':');
    if (key === lastSync) return;
    const res = await bot.session.applySiteSnapshot({
      token: typeof snap.token === 'string' && snap.token.length < 4096 ? snap.token : null,
      deviceId: typeof snap.deviceId === 'string' && snap.deviceId.length < 200 ? snap.deviceId : null,
      pass: snap.pass,
    });
    lastSync = key;
    const problems = res.problems.join('; ');
    // the pass renews every minute: say a problem once, not on every renewal
    if (problems && problems !== lastProblems && !problems.startsWith('this session was already refused')) hub.publish({ type: 'session.app', level: 'warn', title: 'Kyara window not used', detail: problems });
    lastProblems = problems || lastProblems;
    if (res.accepted.token) lastProblems = '';
    if (!problems && res.accepted.token) hub.publish({ type: 'session.app', level: 'success', title: 'Logged in from the Kyara window', detail: res.session.pseudo ?? undefined });
  } catch (err) {
    bot.log.debug(`Kyara window sync skipped: ${(err as Error).message}`);
  } finally {
    syncing = false;
  }
}

// ------------------------------------------------------------------ tray, IPC, notifications

function createTray(): void {
  tray = new Tray(icon('tray.png'));
  tray.setToolTip('Kyara Bot');
  tray.on('click', () => showMain());
  const refresh = () => {
    const paused = server.monitors.isPausedAll;
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Kyara Bot', click: () => showMain() },
        { label: 'Open Kyara', click: () => openKyara() },
        { type: 'separator' },
        {
          label: paused ? 'Resume automation' : 'Pause all automation',
          click: async () => {
            if (paused) server.monitors.resumeAll();
            else await server.monitors.pauseAll();
            refresh();
          },
        },
        { label: 'Start with Windows', type: 'checkbox', checked: autoStart(), click: (item) => (setAutoStart(item.checked), refresh()) },
        { label: 'Open data folder', click: () => void shell.openPath(bot.config.dataDir) },
        { type: 'separator' },
        { label: 'Quit Kyara Bot', click: () => void quit() },
      ]),
    );
  };
  refresh();
  hub.subscribe((e) => {
    if (e.type.startsWith('automation')) refresh();
  });
}

async function quit(): Promise<void> {
  quitting = true;
  try {
    await server.stop();
  } finally {
    app.quit();
  }
}

function autoStart(): boolean {
  return app.getLoginItemSettings(loginArgs()).openAtLogin;
}
function setAutoStart(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, ...loginArgs() });
}
function loginArgs(): { path?: string; args: string[] } {
  // in development the app is `electron <folder>`, so the folder must be passed too
  return DEV ? { path: process.execPath, args: [app.getAppPath(), '--hidden'] } : { args: ['--hidden'] };
}

/** Requests from the app window only (checked by sender), through the preload bridge. */
function ipc(): void {
  const fromApp = (e: Electron.IpcMainInvokeEvent) => !!main && e.sender === main.webContents && safeOrigin(e.senderFrame?.url ?? '') === server.address;
  ipcMain.handle('kyara:open-site', (e) => (fromApp(e) ? (openKyara(), true) : false));
  ipcMain.handle('kyara:get-autostart', (e) => (fromApp(e) ? autoStart() : false));
  ipcMain.handle('kyara:set-autostart', (e, on: unknown) => (fromApp(e) && typeof on === 'boolean' ? (setAutoStart(on), autoStart()) : false));
  ipcMain.handle('kyara:open-data-folder', (e) => (fromApp(e) ? (void shell.openPath(bot.config.dataDir), true) : false));
}

const NOTIFY = new Set(['auction.won', 'auction.target', 'trade.sent', 'trade.accepted', 'packs.opened', 'rewards.claimed', 'monitor.error', 'auction.autobid.unknown', 'trade.unknown', 'trade.needs-pass', 'auction.needs-pass', 'packs.autoopen.blocked']);
const notifiedOnce = new Set<string>();

function notify(e: HubEvent): void {
  if (!NOTIFY.has(e.type) || !Notification.isSupported()) return;
  // "needs Kyara open" style warnings: once per run is enough
  if (e.type.endsWith('needs-pass') || e.type === 'packs.autoopen.blocked') {
    if (notifiedOnce.has(e.type)) return;
    notifiedOnce.add(e.type);
  }
  const n = new Notification({ title: e.title, body: e.detail ?? '', icon: icon(), silent: e.level === 'info' });
  n.on('click', () => showMain('/activity'));
  n.show();
}

// ------------------------------------------------------------------ helpers

const onceKeys = new Set<string>();
function once(key: string, fn: () => void): void {
  if (onceKeys.has(key)) return;
  onceKeys.add(key);
  fn();
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function appendLog(file: string, line: string): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 5_000_000) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, line + '\n');
  } catch {
    // logging must never take the app down
  }
}

function fatal(message: string): void {
  console.error(`Kyara Bot could not start: ${message}`);
  dialog.showErrorBox('Kyara Bot could not start', message);
  app.quit();
}
