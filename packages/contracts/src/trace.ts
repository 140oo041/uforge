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

export interface Trace {
  hops: Hop[];
  divergences: Divergence[];
  /** Engine performance samples; absent on old traces and synthetic ones. */
  metrics?: MetricSample[];
  /** Total cycles spanned by the playback timeline (max arrive + 1). */
  cycles: number;
  /**
   * Cycles the engine actually executed. Hop records are written at SEND
   * time, so a long-latency wire can carry arrivals far past the clock stop —
   * those events were never delivered. Absent = assume the whole timeline ran.
   */
  ranCycles?: number;
  source: 'run' | 'synthetic';
}

export const EMPTY_TRACE: Trace = { hops: [], divergences: [], cycles: 0, source: 'synthetic' };

/** Hops whose arrival lands at/after the clock stop — sent but never delivered. */
export function undeliveredHops(trace: Trace): Hop[] {
  if (trace.ranCycles === undefined) return [];
  return trace.hops.filter((h) => h.arrive >= trace.ranCycles!);
}
