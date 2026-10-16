import type { ClaimKind, Progress } from '../api/schemas/account.js';

/*
 * Pure view helpers over the progress data, shared by the CLI and the web app.
 */

export interface ClaimableItem {
  kind: ClaimKind;
  id?: string;
  label: string;
}

/** Human-readable list of what can be claimed, derived from the progress view. */
export function listClaimables(p: Progress): ClaimableItem[] {
  const out: ClaimableItem[] = [];
  if (p.streak && p.streak.claimedToday === false) out.push({ kind: 'streak', label: `Daily streak (day ${p.streak.day ?? '?'})` });
  for (const a of p.achievements) {
    if (a.done && !a.claimed && a.id) out.push({ kind: 'achievement', id: a.id, label: a.label ?? a.id });
  }
  for (const s of p.series) {
    const complete = s.total !== undefined && s.size !== undefined ? s.total >= s.size : false;
    if (complete && !s.claimed) out.push({ kind: 'series', id: s.series, label: `Series complete: ${s.series}` });
  }
  return out;
}
