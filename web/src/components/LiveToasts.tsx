import { useEffect } from 'react';
import { stream } from '../lib/stream';
import { useToast } from './overlay';

/** Surfaces important server events (outbid, auto-bids, errors, pairing) as toasts. */
const SHOW = /^(auction\.(outbid|autobid|ending)|monitor\.error|bridge\.(paired|unpaired)|rewards\.claimed|packs\.(opened|free\.full)|automation\.)/;

export function LiveToasts() {
  const toast = useToast();
  useEffect(
    () =>
      stream.subscribe((e) => {
        if (!SHOW.test(e.type)) return;
        toast({ kind: e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : e.level === 'success' ? 'success' : 'info', title: e.title, detail: e.detail });
      }),
    [toast],
  );
  return null;
}
