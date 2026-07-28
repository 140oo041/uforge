// Pure Graph → Trace synthesizer: a preview animation for designs that have
// never run (or whose real trace is thin). Tokens flow from the entry blocks
// along resolved links, one issue per cycle.

import type { Graph } from '@iss/contracts/graph';
import type { Hop, Trace } from '@iss/contracts/trace';

export interface SynthOptions {
  tokens?: number;
  issueInterval?: number;
}

export function synthesizeTrace(graph: Graph, opts?: SynthOptions): Trace {
  const tokens = opts?.tokens ?? 4;
  const interval = opts?.issueInterval ?? 1;

  const resolved = graph.links.filter((l) => l.to !== null);
  const outgoing = new Map<string, typeof resolved>();
  for (const link of resolved) {
    if (!outgoing.has(link.from)) outgoing.set(link.from, []);
    outgoing.get(link.from)!.push(link);
  }
  // Tokens flow between leaves; composites are containers, never endpoints.
  const leaves = graph.components.filter((c) => c.kind === 'leaf');
  const targets = new Set(resolved.map((l) => l.to!));
  const entries = leaves.filter((c) => !targets.has(c.id) && outgoing.has(c.id));
  const starts =
    entries.length > 0 ? entries : leaves.filter((c) => outgoing.has(c.id)).slice(0, 1);

  const hops: Hop[] = [];
  for (let token = 0; token < tokens; token++) {
    for (const start of starts) {
      // BFS one token through the pipeline; visited set breaks feedback loops.
      const visited = new Set<string>();
      const frontier: Array<{ id: string; at: number }> = [
        { id: start.id, at: token * interval },
      ];
      while (frontier.length > 0) {
        const { id, at } = frontier.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const link of outgoing.get(id) ?? []) {
          const latency = Math.max(1, link.latency ?? 1);
          hops.push({
            token,
            from: link.from,
            to: link.to!,
            event: link.message || 'Event',
            depart: at,
            arrive: at + latency,
          });
          frontier.push({ id: link.to!, at: at + latency });
        }
      }
    }
  }
  const cycles = hops.reduce((max, h) => Math.max(max, h.arrive + 1), 0);
  // A synthetic preview has no engine behind it. Declare a unit timebase
  // anyway: every consumer reads `timebase` to convert ticks to cycles, and a
  // synthetic trace that omitted it would silently divide by the wrong stride.
  return {
    hops,
    divergences: [],
    timebase: {
      femtosPerTick: 1,
      reference: 0,
      domains: [{ name: 'main', periodTicks: 1, phaseTicks: 0, syncDepth: 0 }],
    },
    ticks: cycles,
    source: 'synthetic',
  };
}
