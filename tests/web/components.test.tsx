// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RaritySeal } from '../../web/src/components/character';
import { ConfirmDialog, ToastProvider } from '../../web/src/components/overlay';
import { useConfirmFlow } from '../../web/src/components/useConfirmFlow';
import { formatPct } from '../../web/src/components/CharacterDrawer';
import { api } from '../../web/src/lib/api';
import { duration, num } from '../../web/src/lib/format';
import type { ActionResponse } from '../../web/src/lib/types';
import { Explorer } from '../../web/src/pages/Explorer';
import { describeGain } from '../../web/src/lib/format';
import { lastLocation, mockApi, renderWithApp } from './setup';
import { MemoryRouter } from 'react-router';

const characters = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'characters.json'), 'utf8')) as unknown[];

afterEach(() => vi.unstubAllGlobals());

describe('formatting', () => {
  it('formats numbers, durations, tiny percentages and reward gains', () => {
    expect(num(1234567)).toBe('1,234,567');
    expect(num(null)).toBe('–');
    expect(duration(3 * 3600_000 + 5 * 60_000)).toBe('3h 05m');
    expect(duration(65_000)).toBe('1m 05s');
    expect(formatPct(0.0000371)).toBe('0.000037');
    expect(formatPct(0.33)).toBe('0.330');
    expect(formatPct(2.04)).toBe('2.0');
    expect(describeGain({ chakra: 50, bonusPacks: 1, grants: { 'seal-mythic': 1 } })).toBe('+50 chakra, +1 bonus pack, +1 seal-mythic');
  });
});

describe('RaritySeal', () => {
  it('has an accessible name and shows the rarity kanji', () => {
    render(<RaritySeal rarity="M" />);
    const seal = screen.getByRole('img', { name: 'Mythic' });
    expect(seal).toHaveTextContent('神');
  });
});

describe('ConfirmDialog', () => {
  it('shows the server summary and the spend warning, and confirms once', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog open title="Open this pack?" summary="Open 1× Hall of Fame — cost 750 chakra" cost={750} confirmLabel="Open" onConfirm={onConfirm} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Open this pack?' })).toBeInTheDocument();
    expect(screen.getByText(/cost 750 chakra/)).toBeInTheDocument();
    expect(screen.getByText(/This spends up to/)).toHaveTextContent('750');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('disables both buttons while busy (no double submission)', () => {
    render(<ConfirmDialog open busy title="t" summary="s" cost={0} confirmLabel="Go" onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});

function FlowHarness({ onSuccess, skipWhenFree }: { onSuccess: (r: unknown) => void; skipWhenFree?: boolean }) {
  const flow = useConfirmFlow<{ id: string }, { ok: boolean }>({
    run: (v) => api<ActionResponse<{ ok: boolean }>>(`/thing/${v.id}`, { method: 'POST', body: { [v.mode]: true } }),
    title: 'Do the thing?',
    confirmLabel: 'Do it',
    onSuccess,
    skipWhenFree,
  });
  return (
    <>
      <button type="button" onClick={() => void flow.request({ id: 'x' })}>
        Start
      </button>
      {flow.dialog}
    </>
  );
}

const harness = (ui: React.ReactElement) =>
  render(
    <MemoryRouter>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>,
  );

describe('confirm flow (dry run, then confirm)', () => {
  it('asks the server for a dry run, shows its summary, then sends confirm exactly once', async () => {
    const calls = mockApi({
      'POST /thing/x': ({ body }) => (JSON.parse(String(body)).dryRun ? { body: { status: 'dry-run', summary: 'Spend 100 chakra on x', cost: 100 } } : { body: { status: 'succeeded', actionId: 'a1', result: { ok: true } } }),
    });
    const onSuccess = vi.fn();
    harness(<FlowHarness onSuccess={onSuccess} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Spend 100 chakra on x')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/thing/x').map((c) => c.body)).toEqual([{ dryRun: true }]);
    const confirm = screen.getByRole('button', { name: 'Do it' });
    await userEvent.click(confirm);
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onSuccess.mock.calls[0]![0]).toEqual({ ok: true });
    expect(calls.filter((c) => c.path === '/thing/x').map((c) => c.body)).toEqual([{ dryRun: true }, { confirm: true }]);
  });

  it('cancelling sends nothing', async () => {
    const calls = mockApi({ 'POST /thing/x': () => ({ body: { status: 'dry-run', summary: 'Spend 5', cost: 5 } }) });
    harness(<FlowHarness onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText('Spend 5');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.filter((c) => (c.body as { confirm?: boolean } | undefined)?.confirm)).toHaveLength(0);
  });

  it('skips the dialog for free actions when allowed', async () => {
    const calls = mockApi({
      'POST /thing/x': ({ body }) => (JSON.parse(String(body)).dryRun ? { body: { status: 'dry-run', summary: 'Free', cost: 0 } } : { body: { status: 'succeeded', actionId: 'a2', result: { ok: true } } }),
    });
    const onSuccess = vi.fn();
    harness(<FlowHarness onSuccess={onSuccess} skipWhenFree />);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/thing/x')).toHaveLength(2);
  });

  it('reports an unknown outcome as such and never resends', async () => {
    const calls = mockApi({
      'POST /thing/x': ({ body }) =>
        JSON.parse(String(body)).dryRun
          ? { body: { status: 'dry-run', summary: 'Spend 9', cost: 9 } }
          : { status: 409, body: { error: { code: 'ambiguous', message: 'Outcome unknown', actionId: 'a3' } } },
    });
    const onSuccess = vi.fn();
    harness(<FlowHarness onSuccess={onSuccess} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByText('Spend 9');
    await userEvent.click(screen.getByRole('button', { name: 'Do it' }));
    expect(await screen.findByText('Outcome unknown: not retried')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(calls.filter((c) => (c.body as { confirm?: boolean } | undefined)?.confirm)).toHaveLength(1);
  });
});

describe('Explorer', () => {
  const routes = {
    'GET /characters': () => ({ body: characters }),
    'GET /status': () => ({ body: { session: { hasToken: false }, bridge: { clients: [] }, automation: {} } }),
  };

  it('filters by name and keeps the filter in the URL', async () => {
    mockApi(routes);
    renderWithApp(<Explorer />, { path: '/characters' });
    expect(await screen.findByText(`${characters.length} of ${characters.length}`)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name or ID'), 'gojou satoru');
    expect(await screen.findByText(`1 of ${characters.length}`)).toBeInTheDocument();
    await waitFor(() => expect(lastLocation).toContain('q=gojou+satoru'));
  });

  it('applies rarity filters as chips and resets them in one click', async () => {
    mockApi(routes);
    renderWithApp(<Explorer />, { path: '/characters?rarity=M' });
    const mythics = (characters as Array<{ rarity: string }>).filter((c) => c.rarity === 'M').length;
    expect(await screen.findByText(`${mythics} of ${characters.length}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mythic', pressed: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(await screen.findByText(`${characters.length} of ${characters.length}`)).toBeInTheDocument();
    await waitFor(() => expect(lastLocation).toBe('/characters'));
  });

  it('searches by numeric ID', async () => {
    mockApi(routes);
    renderWithApp(<Explorer />, { path: '/characters?q=127691' });
    expect(await screen.findByText(`1 of ${characters.length}`)).toBeInTheDocument();
  });

  it('shows an empty state with a way out', async () => {
    mockApi(routes);
    renderWithApp(<Explorer />, { path: '/characters?q=zzzz-nobody' });
    expect(await screen.findByText('No character matches these filters')).toBeInTheDocument();
    await act(async () => undefined);
  });
});
