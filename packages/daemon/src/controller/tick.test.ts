import { expect, it, vi } from 'vitest';
import { APP_CONFIG_DEFAULTS } from '../config/schema.js';
import { execute } from './execute.js';
import { observe } from './observe.js';
import { Controller, type TickDeps } from './tick.js';
import type { ExecutionResult, State } from './types.js';

vi.mock('./observe.js', () => ({ observe: vi.fn() }));
vi.mock('./decide.js', () => ({ decide: () => [] }));
vi.mock('./gate.js', () => ({ gate: () => [] }));
vi.mock('./execute.js', () => ({ execute: vi.fn() }));

it.each(['v1', 'v2'] as const)(
  'reports %s bid terms after Braiins accepts an edit',
  async (apiVersion) => {
    const bid = {
      braiins_order_id: 'B1',
      price_sat: 10000,
      speed_limit_ph: 1,
      status: 'BID_STATUS_ACTIVE',
    };
    const state = {
      config: APP_CONFIG_DEFAULTS,
      owned_bids: [bid],
      unknown_bids: [],
      actual_hashrate: { total_ph: 0 },
      pool: { last_ok_at: 0 },
      tick_at: 10000,
    } as unknown as State;
    vi.mocked(observe).mockResolvedValue(state);
    vi.mocked(execute).mockResolvedValue([
      {
        outcome: 'EXECUTED',
        proposal: { kind: 'EDIT_PRICE', braiins_order_id: 'B1', new_price_sat: 9000 },
      },
      {
        outcome: 'EXECUTED',
        proposal: { kind: 'EDIT_SPEED', braiins_order_id: 'B1', new_speed_limit_ph: 2 },
      },
    ] as ExecutionResult[]);
    const insert = vi.fn();
    const controller = new Controller({
      braiinsClient: { apiVersion },
      runtimeRepo: { patch: vi.fn() },
      tickMetricsRepo: { insert },
    } as unknown as TickDeps);
    const result = await controller.tick();
    const expected = apiVersion === 'v2' ? bid : { ...bid, price_sat: 9000, speed_limit_ph: 2 };
    expect(result.state.owned_bids).toEqual([expected]);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        our_primary_price_sat_per_eh_day: expected.price_sat,
      }),
    );
  },
);
