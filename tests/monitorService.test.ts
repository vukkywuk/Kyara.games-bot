import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventHub } from '../src/server/EventHub.js';
import { MonitorService } from '../src/server/MonitorService.js';
import { MockTransport, makeBot } from './helpers.js';

const trades = (mode: 'preview' | 'auto') => ({ kind: 'trades', name: 'Chat trades', enabled: false, intervalSec: 90, params: { mode } });

describe('MonitorService: trade monitors', () => {
  let svc: MonitorService | null = null;
  afterEach(async () => {
    await svc?.shutdown();
    svc = null;
  });

  it('fills in safe defaults and stays in preview until sending is allowed in Settings', () => {
    const { bot, dir } = makeBot(new MockTransport());
    svc = new MonitorService(bot, new EventHub(), path.join(dir, 'monitors.json'));
    const m = svc.create(trades('auto'));
    expect(m.kind === 'trades' && m.params.limits).toEqual({ maxPending: 3, maxPerHour: 5, perUserHours: 24, expireMin: 30, budget: 0 });
    let st = svc.list()[0]!.status;
    expect(st.trades?.mode).toBe('preview');
    expect(st.tradeBlockedReason).toMatch(/Settings/);

    bot.settings.update({ ...bot.settings.view().values, autoTrade: { enabled: true, budget: 50 } });
    st = svc.list()[0]!.status;
    expect(st.trades?.mode).toBe('auto');
    expect(st.tradeBlockedReason).toBeNull();
  });

  it('rejects inconsistent ranges and intervals under the floor', () => {
    const { bot, dir } = makeBot(new MockTransport());
    svc = new MonitorService(bot, new EventHub(), path.join(dir, 'monitors.json'));
    expect(() => svc!.create({ ...trades('preview'), params: { seek: { wishMinPct: 150, wishMaxPct: 100 } } })).toThrow(/Minimum percentages/);
    expect(() => svc!.create({ ...trades('preview'), intervalSec: 30 })).toThrow(/at least 60/);
  });

  it('persists trade progress with the monitors', () => {
    const { bot, dir } = makeBot(new MockTransport());
    const file = path.join(dir, 'monitors.json');
    svc = new MonitorService(bot, new EventHub(), file);
    const m = svc.create(trades('preview'));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.progress = { [m.id]: { lastSeen: {}, sent: [{ tradeId: 'x', toUserId: 'u', pseudo: 'p', at: new Date().toISOString(), give: { cards: [], chakra: 0 }, want: { cards: [], chakra: 0 }, summary: 's', status: 'accepted' }], stats: { sent: 1, accepted: 1, declined: 0, expired: 0, cancelled: 0 }, halted: false } };
    fs.writeFileSync(file, JSON.stringify(saved));
    const again = new MonitorService(bot, new EventHub(), file);
    expect(again.list()[0]!.status.trades).toMatchObject({ sent: 1, accepted: 1, pending: 0 });
    expect(again.botTradeIds()).toEqual(['x']);
  });
});
