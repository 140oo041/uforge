// Token animation + pipeline analytics: pure functions of (trace, playhead),
// so scrubbing/rewinding in any direction is deterministic — no per-frame
// state to get stuck. One bubble per token: in FLIGHT along a wire during
// [depart, arrive), DWELLING inside the destination between hops, and cleaned
// up one cycle after its last arrival. No DOM, no React — unit-testable.

import type { Hop, Trace } from '@iss/contracts/trace';
import { displayCycles, tickStride } from '@iss/contracts/trace';

/** How long (cycles) a token keeps showing inside its final block. */
export const DWELL_GRACE = 1;

export interface TokenPos {
  token: number;
  /** 'flight' between blocks, or 'dwell' inside one. */
  state: 'flight' | 'dwell';
  /** flight: hop endpoints; dwell: `to` is the residing block (from === to). */
  from: string;
  to: string;
  /** flight: 0..1 along the wire; dwell: 0. */
  t: number;
  event: string;
}

/** Per-token hop timelines, sorted by departure (stable for equal departs). */
export function tokenTimelines(trace: Trace): Map<number, Hop[]> {
  const byToken = new Map<number, Hop[]>();
  for (const hop of trace.hops) {
    if (!byToken.has(hop.token)) byToken.set(hop.token, []);
    byToken.get(hop.token)!.push(hop);
  }
  for (const hops of byToken.values())
    hops.sort((a, b) => a.depart - b.depart || a.arrive - b.arrive);
  return byToken;
}

/**
 * Where every live token is at `playhead`. Exactly one entry per visible
 * token; tokens not yet seeded or past their final dwell window are absent.
 */
export function tokenPositions(
  timelines: Map<number, Hop[]>,
  playhead: number,
): TokenPos[] {
  const out: TokenPos[] = [];
  for (const [token, hops] of timelines) {
    const pos = tokenPositionAt(hops, playhead);
    if (pos) out.push({ token, ...pos });
  }
  return out.sort((a, b) => a.token - b.token);
}

function tokenPositionAt(
  hops: Hop[],
  playhead: number,
): Omit<TokenPos, 'token'> | null {
  if (hops.length === 0) return null;
  if (playhead < hops[0].depart) return null; // not seeded yet

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    // In flight: [depart, arrive). A 0-latency hop has an empty window and
    // reads as an instantaneous move — the token dwells at its destination.
    if (playhead >= hop.depart && playhead < hop.arrive) {
      const t = (playhead - hop.depart) / (hop.arrive - hop.depart);
      return { state: 'flight', from: hop.from, to: hop.to, t, event: hop.event };
    }
    // Dwelling inside hop.to until the next hop departs.
    const next = hops[i + 1];
    const dwellEnd = next ? next.depart : hop.arrive + DWELL_GRACE;
    if (playhead >= hop.arrive && playhead < dwellEnd) {
      return { state: 'dwell', from: hop.to, to: hop.to, t: 0, event: hop.event };
    }
  }
  return null; // past the final dwell window — cleaned up
}

// ---------------------------------------------------------------------------
// Pipeline view: token × cycle → occupied block.

export interface PipelineCell {
  block: string;
  /** true when the token is on a wire toward `block` at that cycle. */
  inFlight: boolean;
  event: string;
}

export interface PipelineTable {
  tokens: number[];
  cycles: number;
  /** cell for (token, integer cycle); null when the token isn't live. */
  cellAt(token: number, cycle: number): PipelineCell | null;
}

export function pipelineTable(trace: Trace): PipelineTable {
  const timelines = tokenTimelines(trace);
  const tokens = [...timelines.keys()].sort((a, b) => a - b);
  // Columns are reference-domain CYCLES (what a reader thinks in); hop times
  // are absolute TICKS. One stride converts, in one place.
  const stride = tickStride(trace);
  const cellAt = (token: number, cycle: number): PipelineCell | null => {
    const hops = timelines.get(token);
    if (!hops) return null;
    const pos = tokenPositionAt(hops, cycle * stride);
    if (!pos) return null;
    return { block: pos.to, inFlight: pos.state === 'flight', event: pos.event };
  };
  return { tokens, cycles: displayCycles(trace), cellAt };
}

// ---------------------------------------------------------------------------
// Occupancy / bottlenecks: tokens per block at the playhead (dwelling there,
// or in flight toward it).

export function occupancyAt(
  timelines: Map<number, Hop[]>,
  playhead: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pos of tokenPositions(timelines, playhead))
    counts.set(pos.to, (counts.get(pos.to) ?? 0) + 1);
  return counts;
}

/**
 * Blocks that look congested at the playhead: at least `minTokens` queued AND
 * at least twice the mean occupancy of the OTHER busy blocks — so a uniformly
 * busy pipeline doesn't light up everywhere, but a lone pile-up (all tokens
 * stacked on Memory1) does.
 */
export function congestedAt(
  occupancy: Map<string, number>,
  minTokens = 3,
): Set<string> {
  const counts = [...occupancy.values()].filter((n) => n > 0);
  if (counts.length === 0) return new Set();
  const total = counts.reduce((s, n) => s + n, 0);
  const out = new Set<string>();
  for (const [block, n] of occupancy) {
    if (n < minTokens) continue;
    const othersMean = counts.length > 1 ? (total - n) / (counts.length - 1) : 0;
    if (n >= 2 * othersMean) out.add(block);
  }
  return out;
}
