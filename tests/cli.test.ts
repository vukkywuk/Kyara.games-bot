import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/main.js';
import { EXIT } from '../src/utils/errors.js';
import { tempDir } from './helpers.js';

// Only paths that fail before any network call.
describe('CLI exit codes', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.KYARA_DATA_DIR = tempDir();
    delete process.env.KYARA_TOKEN;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    process.env = { ...env };
    process.exitCode = undefined;
  });

  const run = (...args: string[]) => main(['node', 'kyara', ...args]);

  it('--help exits 0', async () => expect(await run('--help')).toBe(EXIT.ok));
  it('unknown command exits 2', async () => expect(await run('nope')).toBe(EXIT.usage));
  it('invalid option values exit 2', async () => {
    expect(await run('characters', 'list', '--sort', 'bogus')).toBe(EXIT.usage);
    expect(await run('market', 'list', '--page-size', '500')).toBe(EXIT.usage);
    expect(await run('packs', 'open', 'all', '--count', '50')).toBe(EXIT.usage);
  });
  it('malformed listing id exits 2 before any request', async () => {
    expect(await run('market', 'bid', 'not-a-uuid', '5', '--yes')).toBe(EXIT.usage);
  });
  it('commands needing a session exit 3 without one', async () => {
    expect(await run('session', 'status', '--offline')).toBe(EXIT.auth);
    expect(await run('account', 'me')).toBe(EXIT.auth);
    expect(await run('monitor', 'account')).toBe(EXIT.usage);
  });
  it('auto-bid refuses unless enabled in config', async () => {
    expect(await run('monitor', 'auctions', '--auto-bid', '--max-price', '100')).toBe(EXIT.usage);
  });
});
