import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { SettingsStore } from '../src/config/SettingsStore.js';
import { ActionRefusedError } from '../src/utils/errors.js';
import { MockTransport, makeBot, tempDir } from './helpers.js';

const config = (env: Record<string, string> = {}) => {
  const dir = tempDir();
  return { dir, config: loadConfig({ KYARA_DATA_DIR: dir, ...env }, dir) };
};

describe('SettingsStore', () => {
  it('starts with spending off, saves to settings.json and applies to the live config', () => {
    const { dir, config: c } = config();
    const store = new SettingsStore(path.join(dir, 'settings.json'), c);
    expect(store.view().values.autoBid.enabled).toBe(false);
    const ref = c.autoBid; // modules keep references: they must see the change
    store.update({ maxSpendPerAction: 800, autoBid: { enabled: true, budget: 400, maxBid: 50 }, autoTrade: { enabled: true, budget: 0 } });
    expect(ref).toEqual({ enabled: true, budget: 400, maxBid: 50 });
    expect(c.maxSpendPerAction).toBe(800);
    // a fresh process reads them back
    const again = config();
    fs.copyFileSync(path.join(dir, 'settings.json'), path.join(again.dir, 'settings.json'));
    new SettingsStore(path.join(again.dir, 'settings.json'), again.config);
    expect(again.config.autoTrade.enabled).toBe(true);
  });

  it('lets variables set in .env win and reports them as locked', () => {
    const { dir, config: c } = config({ KYARA_AUTO_BID_ENABLED: 'false', KYARA_AUTO_BID_MAX: '10' });
    const store = new SettingsStore(path.join(dir, 'settings.json'), c);
    expect(store.view().locked).toEqual({ 'autoBid.enabled': 'KYARA_AUTO_BID_ENABLED', 'autoBid.maxBid': 'KYARA_AUTO_BID_MAX' });
    store.update({ maxSpendPerAction: 500, autoBid: { enabled: true, budget: 300, maxBid: 999 }, autoTrade: { enabled: false, budget: 0 } });
    expect(c.autoBid).toEqual({ enabled: false, budget: 300, maxBid: 10 });
  });

  it('lists the changes that let the bot spend more', () => {
    const { dir, config: c } = config();
    const store = new SettingsStore(path.join(dir, 'settings.json'), c);
    const v = store.view().values;
    expect(store.raises({ ...v, maxSpendPerAction: v.maxSpendPerAction - 1 })).toEqual([]);
    expect(store.raises({ ...v, autoTrade: { enabled: true, budget: 100 } })).toEqual(['autoTrade.enabled', 'autoTrade.budget']);
  });

  it('ignores an unreadable settings file (spending stays off)', () => {
    const { dir, config: c } = config();
    fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
    new SettingsStore(path.join(dir, 'settings.json'), c);
    expect(c.autoBid.enabled).toBe(false);
  });

  it('the action guard follows the per-action limit as it changes', async () => {
    const { bot } = makeBot(new MockTransport());
    bot.settings.update({ ...bot.settings.view().values, maxSpendPerAction: 10 });
    const run = () => bot.guard.run({ kind: 't', key: 't', summary: 't', cost: 50, params: {}, confirm: false, execute: async () => 1, summarize: () => ({}) }, { assumeYes: true });
    await expect(run()).rejects.toBeInstanceOf(ActionRefusedError);
    bot.settings.update({ ...bot.settings.view().values, maxSpendPerAction: 100 });
    await expect(run()).resolves.toMatchObject({ status: 'succeeded' });
  });
});
