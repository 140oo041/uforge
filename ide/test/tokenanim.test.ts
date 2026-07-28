// Token animation + pipeline analytics: pure functions of (trace, playhead).
// Regression targets: the old per-hop filter double-rendered tokens at
// integer cycle boundaries, never showed 0-latency hops, and left bubbles
// behind when scrubbing backwards.

import { describe, expect, it } from 'vitest';

import { undeliveredHops, type Trace } from '@iss/contracts/trace';
import {
  DWELL_GRACE,
  congestedAt,
  occupancyAt,
  pipelineTable,
  tokenPositions,
  tokenTimelines,
} from '@iss/canvas/tokenAnim';

/** token 0: IF→DE (0..1), dwell, DE→EX (2..3), EX→MEM 0-latency at 3.
 *  token 1: IF→DE (1..2) then done. */
const TRACE: Trace = {
  hops: [
    { token: 0, from: 'IF', to: 'DE', event: 'FetchEvent', depart: 0, arrive: 1 },
    { token: 0, from: 'DE', to: 'EX', event: 'DecodeEvent', depart: 2, arrive: 3 },
    { token: 0, from: 'EX', to: 'MEM', event: 'ExecEvent', depart: 3, arrive: 3 },
    { token: 1, from: 'IF', to: 'DE', event: 'FetchEvent', depart: 1, arrive: 2 },
  ],
  divergences: [],
  cycles: 8,
  source: 'run',
};

const timelines = tokenTimelines(TRACE);
const at = (playhead: number) => tokenPositions(timelines, playhead);
const of = (playhead: number, token: number) => at(playhead).find((p) => p.token === token);

describe('tokenPositions', () => {
  it('exactly one bubble per live token — including integer boundaries', () => {
    for (const playhead of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
      const counts = new Map<number, number>();
      for (const p of at(playhead)) counts.set(p.token, (counts.get(p.token) ?? 0) + 1);
      for (const [token, n] of counts) expect(n, `token ${token} at ${playhead}`).toBe(1);
    }
  });

  it('flight → dwell → next flight for token 0', () => {
    expect(of(0.5, 0)).toMatchObject({ state: 'flight', from: 'IF', to: 'DE', t: 0.5 });
    // Arrived: dwelling inside DE until the next hop departs at 2.
    expect(of(1, 0)).toMatchObject({ state: 'dwell', to: 'DE' });
    expect(of(1.9, 0)).toMatchObject({ state: 'dwell', to: 'DE' });
    expect(of(2.5, 0)).toMatchObject({ state: 'flight', from: 'DE', to: 'EX', t: 0.5 });
  });

  it('0-latency hops read as an instantaneous move (dwell at destination)', () => {
    // At 3, DE→EX arrives and EX→MEM departs+arrives: token dwells at MEM.
    expect(of(3, 0)).toMatchObject({ state: 'dwell', to: 'MEM' });
  });

  it('cleans up after the final dwell grace — nothing lingers', () => {
    expect(of(2 + DWELL_GRACE - 0.01, 1)).toMatchObject({ state: 'dwell', to: 'DE' });
    expect(of(2 + DWELL_GRACE, 1)).toBeUndefined();
    expect(of(7.5, 0)).toBeUndefined();
    expect(of(7.5, 1)).toBeUndefined();
  });

  it('not visible before its first departure', () => {
    expect(of(0.5, 1)).toBeUndefined();
  });

  it('pure in playhead: rewinding reproduces earlier frames exactly', () => {
    const forward = at(1.5);
    at(5); // move ahead…
    expect(at(1.5)).toEqual(forward); // …and back: identical
  });
});

describe('pipelineTable', () => {
  const table = pipelineTable(TRACE);

  it('lists tokens and spans the trace cycles', () => {
    expect(table.tokens).toEqual([0, 1]);
    expect(table.cycles).toBe(8);
  });

  it('reports the stage per token per cycle', () => {
    expect(table.cellAt(0, 0)).toMatchObject({ block: 'DE', inFlight: true });
    expect(table.cellAt(0, 1)).toMatchObject({ block: 'DE', inFlight: false });
    expect(table.cellAt(0, 2)).toMatchObject({ block: 'EX', inFlight: true });
    expect(table.cellAt(0, 3)).toMatchObject({ block: 'MEM', inFlight: false });
    expect(table.cellAt(1, 0)).toBeNull(); // not seeded yet
    expect(table.cellAt(1, 5)).toBeNull(); // long gone
    expect(table.cellAt(99, 0)).toBeNull(); // unknown token
  });
});

describe('undelivered events (clock stopped before arrivals)', () => {
  it('flags hops arriving at/after the engine stop; silent without ranCycles', () => {
    const trace: Trace = {
      hops: [
        { token: 0, from: 'MEM', to: 'Out1', event: 'E', depart: 3, arrive: 103 },
        { token: 1, from: 'IF', to: 'DE', event: 'E', depart: 1, arrive: 2 },
      ],
      divergences: [],
      cycles: 104,
      ranCycles: 64,
      source: 'run',
    };
    expect(undeliveredHops(trace).map((h) => h.token)).toEqual([0]);
    // No engine info (older traces / synthetic) → no warning.
    expect(undeliveredHops({ ...trace, ranCycles: undefined })).toEqual([]);
    // Fully drained run → nothing flagged.
    expect(undeliveredHops({ ...trace, ranCycles: 104 })).toEqual([]);
  });
});

describe('occupancy + congestion', () => {
  it('counts tokens per block at the playhead', () => {
    // At 1.5: token 0 dwells in DE, token 1 is in flight toward DE.
    expect(occupancyAt(timelines, 1.5)).toEqual(new Map([['DE', 2]]));
  });

  it('congestedAt flags heavy blocks only when they stand out', () => {
    const uniform = new Map([
      ['A', 3],
      ['B', 3],
    ]);
    expect(congestedAt(uniform)).toEqual(new Set()); // busy everywhere ≠ bottleneck
    const skewed = new Map([
      ['A', 6],
      ['B', 1],
      ['C', 1],
    ]);
    expect(congestedAt(skewed)).toEqual(new Set(['A']));
    // A lone pile-up (everything stacked on one block) IS a bottleneck.
    expect(congestedAt(new Map([['Memory1', 4]]))).toEqual(new Set(['Memory1']));
    expect(congestedAt(new Map([['A', 2]]))).toEqual(new Set()); // below minTokens
  });
});
