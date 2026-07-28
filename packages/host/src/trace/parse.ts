// iss_trace.jsonl → Trace. Hop from/to may carry either the component id or
// its display label (Component("…") is the label the engine reports), so
// names are resolved against the graph both ways.

import type { Graph } from '@iss/contracts/graph';
import type { Divergence, Hop, MetricSample, Trace } from '@iss/contracts/trace';

export function parseTrace(jsonl: string, graph: Graph, ranCycles?: number): Trace {
  const byLabel = new Map<string, string>();
  for (const c of graph.components) {
    byLabel.set(c.id, c.id);
    byLabel.set(c.label, c.id);
  }
  const resolve = (name: string): string => byLabel.get(name) ?? name;

  const hops: Hop[] = [];
  const divergences: Divergence[] = [];
  const metrics: MetricSample[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.diverge === true) {
      divergences.push({
        cycle: Number(obj.cycle ?? 0),
        component: resolve(String(obj.component ?? '')),
        token: Number(obj.token ?? 0),
        detail: String(obj.detail ?? ''),
        provenance: obj.kind === 'cosim' ? 'cosim' : obj.kind === 'drop' ? 'drop' : 'architectural',
      });
    } else if (typeof obj.metric === 'string') {
      metrics.push({
        metric: obj.metric,
        cycle: Number(obj.cycle ?? 0),
        component: resolve(String(obj.component ?? '')),
        ...(obj.port !== undefined ? { port: String(obj.port) } : {}),
        value: Number(obj.value ?? 0),
      });
    } else if (obj.from !== undefined && obj.to !== undefined) {
      hops.push({
        token: Number(obj.token ?? 0),
        from: resolve(String(obj.from)),
        to: resolve(String(obj.to)),
        event: String(obj.event ?? 'Event'),
        depart: Number(obj.depart ?? 0),
        arrive: Number(obj.arrive ?? 0),
        ...(typeof obj.addr === 'string' ? { addr: obj.addr } : {}),
      });
    }
  }
  const cycles = hops.reduce((max, h) => Math.max(max, h.arrive + 1), 0);
  return { hops, divergences, metrics, cycles, ranCycles, source: 'run' };
}

/** A trace with no hops is "thin" — fall back to the synthesizer. */
export function isThin(trace: Trace): boolean {
  return trace.hops.length === 0;
}
