import type * as ApiModule from '@/lib/api';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleForm } from '@/components/rule-form';
import type { AlertRule, Contract, Destination } from '@/lib/types';

const apiMock = vi.fn();
// A plain function decides the outcome so rejected calls are only seen by the component.
let failWith: string | null = null;
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: async (...args: unknown[]) => {
    apiMock(...args);
    if (failWith) throw new Error(failWith);
    return {};
  },
}));

const contracts = [
  { id: 'c1', label: 'Token', contractId: 'CABC', network: 'TESTNET' },
] as Contract[];
const destinations = [
  { id: 'd1', name: 'Ops hook', type: 'WEBHOOK', enabled: true },
] as Destination[];

beforeEach(() => {
  apiMock.mockReset();
  failWith = null;
});

describe('RuleForm', () => {
  it('creates an event-match rule with parsed topics and units converted to seconds', async () => {
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <RuleForm
        rule={null}
        contracts={contracts}
        destinations={destinations}
        onCancel={() => {}}
        onSaved={onSaved}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'Big transfers');
    await user.selectOptions(screen.getByLabelText('Contract'), 'c1');
    await user.type(screen.getByLabelText(/Topics/), 'transfer, * ,, GABC');
    await user.clear(screen.getByLabelText(/Threshold/));
    await user.type(screen.getByLabelText(/Threshold/), '3');
    await user.clear(screen.getByLabelText(/Window/));
    await user.type(screen.getByLabelText(/Window/), '10');
    await user.click(screen.getByRole('checkbox', { name: /Ops hook/ }));
    await user.click(screen.getByRole('button', { name: 'Create rule' }));

    expect(apiMock).toHaveBeenCalledWith('/alert-rules', {
      method: 'POST',
      body: expect.objectContaining({
        name: 'Big transfers',
        type: 'EVENT_MATCH',
        contractRefId: 'c1',
        cooldownSeconds: 300,
        destinationIds: ['d1'],
        config: {
          topics: ['transfer', '*', 'GABC'],
          threshold: 3,
          windowSeconds: 600,
          includeFailedCalls: false,
        },
      }),
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('adds a numeric value condition and keeps it when editing', async () => {
    const user = userEvent.setup();
    const created = render(
      <RuleForm
        rule={null}
        contracts={[]}
        destinations={[]}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'Whales');
    await user.click(screen.getByRole('checkbox', { name: /numeric value/ }));
    await user.selectOptions(screen.getByLabelText('Comparison'), 'gt');
    await user.type(screen.getByLabelText(/^Value$/), '10000000000000000000');
    await user.click(screen.getByRole('button', { name: 'Create rule' }));
    expect(apiMock.mock.calls[0]![1].body.config).toMatchObject({
      valueCondition: { path: 'amount', op: 'gt', value: '10000000000000000000' },
    });

    apiMock.mockReset();
    created.unmount();
    const rule = {
      id: 'r2',
      name: 'Whales',
      type: 'EVENT_MATCH',
      config: {
        topics: [],
        threshold: 1,
        windowSeconds: 300,
        valueCondition: { path: '0', op: 'lte', value: '5' },
      },
      cooldownSeconds: 0,
      severity: 'INFO',
      enabled: true,
      contractRefId: null,
      destinations: [],
    } as unknown as AlertRule;
    render(
      <RuleForm
        rule={rule}
        contracts={[]}
        destinations={[]}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByLabelText('Value path')).toHaveValue('0');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(apiMock.mock.calls[0]![1].body.config.valueCondition).toEqual({
      path: '0',
      op: 'lte',
      value: '5',
    });
  });

  it('converts TTL days to ledgers', async () => {
    const user = userEvent.setup();
    render(
      <RuleForm
        rule={null}
        contracts={[]}
        destinations={[]}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );
    await user.type(screen.getByLabelText('Name'), 'TTL');
    await user.selectOptions(screen.getByLabelText('Type'), 'TTL_EXPIRY');
    const days = screen.getByLabelText(/TTL is below/);
    await user.clear(days);
    await user.type(days, '2');
    await user.click(screen.getByRole('button', { name: 'Create rule' }));
    expect(apiMock.mock.calls[0]![1].body).toMatchObject({
      type: 'TTL_EXPIRY',
      contractRefId: null,
      config: { ledgersThreshold: 34_560 },
    });
  });

  it('edits with PATCH and shows API errors without closing', async () => {
    failWith = 'Cooldown too long';
    const onSaved = vi.fn();
    const user = userEvent.setup();
    const rule = {
      id: 'r1',
      name: 'Quiet',
      type: 'INACTIVITY',
      config: { windowSeconds: 3600 },
      cooldownSeconds: 60,
      severity: 'INFO',
      enabled: true,
      contractRefId: null,
      destinations: [],
    } as unknown as AlertRule;
    render(
      <RuleForm
        rule={rule}
        contracts={[]}
        destinations={[]}
        onCancel={() => {}}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByLabelText('Type')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const [path, init] = apiMock.mock.calls[0]!;
    expect(path).toBe('/alert-rules/r1');
    expect(init).toMatchObject({
      method: 'PATCH',
      body: { config: { windowSeconds: 3600 }, cooldownSeconds: 60 },
    });
    expect(await screen.findByText('Cooldown too long')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
