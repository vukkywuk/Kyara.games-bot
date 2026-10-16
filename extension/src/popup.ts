import type { PopupRequest, PopupState } from './messages.js';
import { describeState } from './popupModel.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function ask(msg: PopupRequest): Promise<PopupState> {
  const res = (await chrome.runtime.sendMessage(msg)) as PopupState | { error: string };
  if ('error' in res) throw new Error(res.error);
  return res;
}

function render(s: PopupState): void {
  const view = describeState(s, Date.now());
  const rows = $<HTMLUListElement>('rows');
  rows.replaceChildren(
    ...view.rows.map((r) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `dot ${r.tone}`;
      dot.setAttribute('aria-hidden', 'true');
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = r.label;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = r.value;
      li.append(dot, k, v);
      return li;
    }),
  );
  const note = $<HTMLParagraphElement>('note');
  note.hidden = !view.note;
  note.textContent = view.note ?? '';
  const err = $<HTMLParagraphElement>('error');
  err.hidden = !s.lastError;
  err.textContent = s.lastError ?? '';
  const paired = s.bridge !== 'unpaired' && s.bridge !== 'rejected';
  $<HTMLFormElement>('pair-form').hidden = paired;
  $<HTMLDivElement>('paired-actions').hidden = !paired;
  $<HTMLParagraphElement>('sub').textContent = paired ? `Paired as ${s.label ?? 'this browser'}.` : 'Connects your kyara.games tab to the bot on this computer.';
}

function showError(e: unknown): void {
  const err = $<HTMLParagraphElement>('error');
  err.hidden = false;
  err.textContent = (e as Error).message;
}

async function withBusy(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    showError(e);
  } finally {
    btn.disabled = false;
  }
}

$<HTMLInputElement>('label').value = navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome';

$<HTMLFormElement>('pair-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const btn = $<HTMLButtonElement>('pair-btn');
  void withBusy(btn, async () => {
    render(
      await ask({
        type: 'popup:pair',
        port: Number($<HTMLInputElement>('port').value),
        code: $<HTMLInputElement>('code').value,
        label: $<HTMLInputElement>('label').value.trim(),
      }),
    );
    $<HTMLInputElement>('code').value = '';
  });
});

$<HTMLButtonElement>('resync').addEventListener('click', (ev) => void withBusy(ev.currentTarget as HTMLButtonElement, async () => render(await ask({ type: 'popup:resync' }))));
$<HTMLButtonElement>('unpair').addEventListener('click', (ev) => void withBusy(ev.currentTarget as HTMLButtonElement, async () => render(await ask({ type: 'popup:unpair' }))));

void (async () => {
  try {
    render(await ask({ type: 'popup:state' }));
    render(await ask({ type: 'popup:check' }));
  } catch (e) {
    showError(e);
  }
})();
