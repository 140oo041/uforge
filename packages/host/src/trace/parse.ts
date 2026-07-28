// iss_trace.jsonl → Trace. Hop from/to may carry either the component id or
// its display label (Component("…") is the label the engine reports), so
// names are resolved against the graph both ways.

import type { Graph } from '@iss/contracts/graph';
import type { Divergence, Hop, MetricSample, Timebase, Trace } from '@iss/contracts/trace';

export function parseTrace(jsonl: string, graph: Graph, ranTicks?: number): Trace {
  const byLabel = new Map<string, string>();
  for (const c of graph.components) {
    byLabel.set(c.id, c.id);
    byLabel.set(c.label, c.id);
  }
  const resolve = (name: string): string => byLabel.get(name) ?? name;

  const hops: Hop[] = [];
  const divergences: Divergence[] = [];
  const metrics: MetricSample[] = [];
  let timebase: Timebase | undefined;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.timebase !== undefined) {
      const tb = obj.timebase as Record<string, unknown>;
      timebase = {
        femtosPerTick: Number(tb.femtosPerTick ?? 1),
        reference: Number(tb.reference ?? 0),
        domains: (Array.isArray(tb.domains) ? tb.domains : []).map((d) => {
          const dom = d as Record<string, unknown>;
          return {
            name: String(dom.name ?? ''),
            periodTicks: Number(dom.periodTicks ?? 1),
            phaseTicks: Number(dom.phaseTicks ?? 0),
            syncDepth: Number(dom.syncDepth ?? 0),
          };
        }),
      };
    } else if (obj.diverge === true) {
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
  const ticks = hops.reduce((max, h) => Math.max(max, h.arrive + 1), 0);

  // Records with no declared units are the one failure mode that cannot be
  // seen: every time field would be read as cycles when it is ticks, the
  // playhead would sit at 0 for the whole run, and nothing would error.
  if (!timebase && (hops.length > 0 || metrics.length > 0 || divergences.length > 0))
    throw new Error(
      'trace has records but no timebase — refusing to guess the units. ' +
        'Regenerate the harness (it emits the timebase as the first line).',
    );

  return { hops, divergences, metrics, timebase, ticks, ranTicks, source: 'run' };
}

/** A trace with no hops is "thin" — fall back to the synthesizer. */
export function isThin(trace: Trace): boolean {
  return trace.hops.length === 0;
}
