// The trace contract — mirrors the engine's JSONL records
// (engine/include/microarch/trace.hpp).

export interface Hop {
  token: number;
  from: string;
  to: string;
  event: string;
  depart: number;
  arrive: number;
  /** Transaction address as 0x-hex (uint64 never fits a JS number);
   *  absent when the packet was unaddressed. */
  addr?: string;
}

export interface Divergence {
  cycle: number;
  component: string;
  token: number;
  detail: string;
  /**
   * 'architectural' = ISA oracle (xverify); 'cosim' = SV twin vs C++ shadow;
   * 'drop' = packet discarded by a bounded router queue.
   */
  provenance: 'architectural' | 'synthetic' | 'cosim' | 'drop';
}

/**
 * A performance sample localized to a component (and optionally one of its
 * ports) at a cycle. Emitted by routers: 'qdepth' (settled per-port queue
 * depth, change-only), 'flow' (packets forwarded on a port that cycle),
 * 'bits' (their total width — bandwidth is metered in bits, so packet counts
 * alone don't say how loaded a port was), 'stall' (full-queue retries charged
 * to a port that cycle).
 */
export interface MetricSample {
  metric: string;
  cycle: number;
  component: string;
  port?: string;
  value: number;
}

/** One clock, as the engine reports it in the trace's timebase record. */
export interface ClockDomainInfo {
  name: string;
  /** Ticks between edges. */
  periodTicks: number;
  phaseTicks: number;
  /** Synchronizer flops crossing INTO this domain. */
  syncDepth: number;
}

/**
 * What the numbers in this trace MEAN.
 *
 * Every time field — `Hop.depart`/`arrive`, `Divergence.cycle`,
 * `MetricSample.cycle` — is an absolute tick, and a tick is meaningless
 * without this. A consumer that reads those numbers as cycles is off by the
 * period, silently, with nothing to notice: the playhead simply appears frozen.
 * `parseTrace` therefore REFUSES a trace that has records but no timebase.
 */
export interface Timebase {
  /** Femtoseconds per tick. */
  femtosPerTick: number;
  domains: ClockDomainInfo[];
  /** Index into `domains` of the reference clock — the one `runFor` counts. */
  reference: number;
}

export interface Trace {
  hops: Hop[];
  divergences: Divergence[];
  /** Engine performance samples; absent on old traces and synthetic ones. */
  metrics?: MetricSample[];
  /** Units for every time field here. Absent only on an empty trace. */
  timebase?: Timebase;
  /** Total TICKS spanned by the playback timeline (max arrive + 1). */
  ticks: number;
  /**
   * Ticks the engine actually executed. Hop records are written at SEND time,
   * so a long-latency wire can carry arrivals far past the clock stop — those
   * events were never delivered. Absent = assume the whole timeline ran.
   */
  ranTicks?: number;
  source: 'run' | 'synthetic';
}

export const EMPTY_TRACE: Trace = { hops: [], divergences: [], ticks: 0, source: 'synthetic' };

/** Hops whose arrival lands at/after the clock stop — sent but never delivered. */
export function undeliveredHops(trace: Trace): Hop[] {
  if (trace.ranTicks === undefined) return [];
  return trace.hops.filter((h) => h.arrive >= trace.ranTicks!);
}

/* ------------------------------------------------------------ display units */
// Users author frequencies and think in cycles, so the UI reads in cycles even
// though the timeline is ticks. One domain is the yardstick: the reference.

export function referenceDomain(trace: Trace): ClockDomainInfo | undefined {
  return trace.timebase?.domains[trace.timebase.reference];
}

/** Ticks per reference cycle — 1 when the trace carries no timebase. */
export function tickStride(trace: Trace): number {
  return referenceDomain(trace)?.periodTicks || 1;
}

/** An absolute tick as a reference-domain cycle number. */
export function displayCycle(trace: Trace, tick: number): number {
  return Math.floor(tick / tickStride(trace));
}

/** Timeline length in reference-domain cycles. */
export function displayCycles(trace: Trace): number {
  return Math.ceil(trace.ticks / tickStride(trace));
}

/** An absolute tick as wall-clock time, e.g. "12.44 ns". Empty with no timebase. */
export function formatTime(trace: Trace, tick: number): string {
  const fs = trace.timebase?.femtosPerTick;
  if (!fs) return '';
  const ns = (tick * fs) / 1e6;
  if (ns >= 1000) return `${(ns / 1000).toFixed(2)} µs`;
  if (ns >= 1) return `${ns.toFixed(2)} ns`;
  return `${(ns * 1000).toFixed(0)} ps`;
}
