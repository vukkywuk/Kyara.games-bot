import type { Command } from 'commander';
import type { ActionStatus } from '../../services/ActionJournal.js';
import { UsageError } from '../../utils/errors.js';
import { getBot, isJson } from '../context.js';
import { parseIntArg, print, printJson, table } from '../output.js';

export function registerActions(program: Command): void {
  const actions = program.command('actions').description('journal of state-changing actions, and resolving unknown outcomes');

  actions
    .command('list')
    .description('recent actions (newest first)')
    .option('--status <status>', 'pending, succeeded, failed or unknown')
    .option('-n, --limit <n>', 'rows', parseIntArg('limit', 1), 20)
    .action((o: { status?: ActionStatus; limit: number }, cmd: Command) => {
      const rows = getBot(cmd).journal.list({ status: o.status, limit: o.limit });
      if (isJson(cmd)) return printJson(rows);
      if (!rows.length) return print('No actions recorded.');
      print(table(rows, [
        { header: 'Id', get: (r) => r.id.slice(0, 8) },
        { header: 'When', get: (r) => r.startedAt.replace('T', ' ').slice(0, 19) },
        { header: 'Status', get: (r) => r.status.toUpperCase() },
        { header: 'Cost≤', get: (r) => r.cost, align: 'right' },
        { header: 'Summary', get: (r) => r.summary, max: 70 },
      ]));
      const unknown = rows.filter((r) => r.status === 'unknown' || r.status === 'pending').length;
      if (unknown) print(`\n${unknown} action(s) with unknown outcome. Check your account, then \`kyara actions resolve <id> --as succeeded|failed\`.`);
    });

  actions
    .command('show <id>')
    .description('full record of one action')
    .action((id: string, _o: unknown, cmd: Command) => {
      const r = getBot(cmd).journal.get(id);
      if (!r) throw new UsageError(`No action ${id}`);
      printJson(r);
    });

  actions
    .command('resolve <id>')
    .description('record what actually happened to an action with an unknown outcome')
    .requiredOption('--as <status>', 'succeeded or failed')
    .action((id: string, o: { as: string }, cmd: Command) => {
      if (o.as !== 'succeeded' && o.as !== 'failed') throw new UsageError('--as must be succeeded or failed');
      const j = getBot(cmd).journal;
      const r = j.get(id);
      if (!r) throw new UsageError(`No action ${id}`);
      if (r.status !== 'unknown' && r.status !== 'pending') throw new UsageError(`Action is ${r.status}; only unknown/pending actions can be resolved.`);
      j.finish(r.id, o.as, { resolvedBy: 'user', error: r.error ?? undefined });
      print(`Action ${r.id.slice(0, 8)} marked ${o.as}.`);
    });
}
