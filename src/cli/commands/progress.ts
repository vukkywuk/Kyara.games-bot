import type { Command } from 'commander';
import type { ClaimKind } from '../../api/schemas/account.js';
import { CLAIM_KINDS } from '../../api/schemas/account.js';
import { listClaimables } from '../../modules/ProgressModule.js';
import { UsageError } from '../../utils/errors.js';
import { formatDuration } from '../../utils/time.js';
import type { ActionFlags } from '../context.js';
import { getBot, guardOptions, isJson, withActionFlags } from '../context.js';
import { print, printJson } from '../output.js';

export function registerProgress(program: Command): void {
  const progress = program.command('progress').alias('missions').description('missions, streak, achievements and rewards');

  progress
    .command('show')
    .description('current missions and what can be claimed')
    .action(async (_o: unknown, cmd: Command) => {
      const p = await getBot(cmd).progress.get();
      if (isJson(cmd)) return printJson(p);
      print(`Claimable rewards: ${p.claimable}`);
      const reset = (s: string | null | undefined): string => (s ? `in ${formatDuration(Date.parse(s) - Date.now())}` : '?');
      print(`Daily reset ${reset(p.resets.nextDaily)} · weekly reset ${reset(p.resets.nextWeekly)}`);
      for (const [label, block] of [['Daily', p.daily], ['Weekly', p.weekly]] as const) {
        if (!block) continue;
        print(`\n${label} missions${block.bonusClaimed ? ' (bonus claimed)' : ''}:`);
        for (const m of block.missions) {
          print(`  ${m.claimed ? '✓' : m.done ? '!' : ' '} ${m.label ?? m.description ?? m.id ?? '?'}  ${m.progress ?? '?'}/${m.target ?? '?'}`);
        }
      }
      if (p.streak) print(`\nStreak: day ${p.streak.day ?? '?'}${p.streak.claimedToday ? ' (claimed today)' : ' — not claimed today'}`);
      const done = p.achievements.filter((a) => a.claimed).length;
      print(`Achievements: ${done}/${p.achievements.length} claimed`);
      const items = listClaimables(p);
      if (items.length) {
        print('\nClaimable now:');
        for (const i of items) print(`  ${i.kind}${i.id ? ` ${i.id}` : ''} — ${i.label}`);
      }
    });

  withActionFlags(
    progress
      .command('claim [kind] [id]')
      .description(`claim rewards; kind is one of ${CLAIM_KINDS.join(', ')} (default: all)`),
  ).action(async (kind: string | undefined, id: string | undefined, o: ActionFlags, cmd: Command) => {
    const k = (kind ?? 'all') as ClaimKind;
    if (!CLAIM_KINDS.includes(k)) throw new UsageError(`kind must be one of ${CLAIM_KINDS.join(', ')}`);
    const out = await getBot(cmd).progress.claim(k, id, guardOptions(o));
    if (out.status === 'dry-run') return isJson(cmd) ? printJson(out) : print(`[dry run] ${out.summary}`);
    const g = out.result.gained;
    if (isJson(cmd)) return printJson({ action: out.action.id, gained: g, chakra: out.result.user.chakra });
    const parts = [g.chakra ? `+${g.chakra} chakra` : '', g.bonusPacks ? `+${g.bonusPacks} bonus pack(s)` : '', ...Object.entries(g.grants).map(([p, n]) => `+${n} ${p}`)].filter(Boolean);
    print(`Claimed: ${parts.join(', ') || 'done'}. Chakra now ${out.result.user.chakra}. Still claimable: ${out.result.progress.claimable}.`);
  });
}
