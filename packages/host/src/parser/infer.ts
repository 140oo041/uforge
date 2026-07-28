// Graph assembly + edge inference. Pure: FileFacts[] → Graph.
//
// Three tiers per out-port (DESIGN_PLAN v3 P0):
//   Tier 1 'wired'      — explicit configureOut fact. Deterministic, survives
//                         multiple consumers, no message-type guessing. Wins.
//   Tier 2 'inferred'   — the port's message has exactly one other consumer.
//   Tier 2b 'unresolved'— multiple candidate consumers and no wiring: the
//                         link is kept with to:null and RENDERED, not dropped.
//   Tier 3 stub         — message emitted (or port silent), no consumer.

import type {
  Graph,
  GraphComponent,
  GraphEvent,
  GraphLink,
  Port,
  Stub,
} from '@iss/contracts/graph';
import type { FileFacts } from './facts';

const ENGINE_BASES = new Set(['Component', 'Event']);

export function assembleGraph(all: FileFacts[]): Graph {
  // Merge headers + sources: a class may be declared in inc/X.h with facts
  // contributed from src/X.cpp. First declaration wins for decl ranges.
  const componentDecls = new Map<string, GraphComponent>();
  const eventDecls = new Map<string, GraphEvent>();

  const parentOf = (id: string): string | null => {
    const dot = id.lastIndexOf('.');
    return dot < 0 ? null : id.slice(0, dot);
  };
  const leafOf = (id: string): string => {
    const dot = id.lastIndexOf('.');
    return dot < 0 ? id : id.slice(dot + 1);
  };

  for (const facts of all) {
    for (const cls of facts.classes) {
      if (cls.base === 'Component' && !componentDecls.has(cls.name)) {
        // A Component("…") string equal to the full id is engine identity,
        // not a display label — show the leaf name instead.
        componentDecls.set(cls.name, {
          id: cls.name,
          label: cls.label && cls.label !== cls.name ? cls.label : leafOf(cls.name),
          kind: 'leaf',
          parent: parentOf(cls.name),
          language: 'cpp',
          decl: cls.decl,
          outPorts: [],
          consumes: [],
          vars: cls.fields,
        });
      } else if (cls.base === 'Router' && !componentDecls.has(cls.name)) {
        // A generated router file (src/<R>.cpp): a real component whose
        // member functions are the fabric latency models.
        componentDecls.set(cls.name, {
          id: cls.name,
          label: cls.label && cls.label !== cls.name ? cls.label : leafOf(cls.name),
          kind: 'router',
          parent: parentOf(cls.name),
          language: 'cpp',
          decl: cls.decl,
          outPorts: [],
          consumes: [],
          vars: [],
          ...(cls.models ? { latencyModels: cls.models } : {}),
        });
      } else if (cls.base === 'Event' && !eventDecls.has(cls.name)) {
        eventDecls.set(cls.name, {
          id: cls.name,
          fields: cls.fields,
          decl: cls.decl,
        });
      } else if (cls.base === 'Component' && componentDecls.has(cls.name)) {
        // A second definition site may carry the label (ctor in the .cpp).
        const existing = componentDecls.get(cls.name)!;
        if (cls.label && cls.label !== existing.id && existing.label === leafOf(existing.id))
          existing.label = cls.label;
        for (const f of cls.fields) if (!existing.vars.includes(f)) existing.vars.push(f);
      }
    }
  }

  // Hierarchy: every dot-path prefix of a parsed leaf is a composite node.
  for (const comp of [...componentDecls.values()]) {
    let prefix = parentOf(comp.id);
    let childDecl = comp.decl;
    while (prefix !== null) {
      if (!componentDecls.has(prefix)) {
        componentDecls.set(prefix, {
          id: prefix,
          label: leafOf(prefix),
          kind: 'composite',
          parent: parentOf(prefix),
          language: 'cpp',
          decl: childDecl, // best-effort anchor: a child's file
          outPorts: [],
          consumes: [],
          vars: [],
        });
      }
      childDecl = componentDecls.get(prefix)!.decl;
      prefix = parentOf(prefix);
    }
  }

  // Ignore anything not deriving the engine vocabulary.
  for (const name of ENGINE_BASES) {
    componentDecls.delete(name);
    eventDecls.delete(name);
  }

  // Labels can arrive from another file (`: Component("label")` in the .cpp
  // ctor while the class body is in the .h) — merge the cross-file label facts.
  for (const facts of all) {
    for (const l of facts.labels) {
      const comp = componentDecls.get(l.cls);
      if (comp && l.label !== comp.id && comp.label === leafOf(comp.id)) comp.label = l.label;
    }
  }

  const byKey = <T extends { cls: string; port: string }>(rows: T[]) => {
    const map = new Map<string, T>();
    for (const row of rows) map.set(`${row.cls}.${row.port}`, row);
    return map;
  };

  const allPorts = all.flatMap((f) => f.ports).filter((p) => componentDecls.has(p.cls));
  const wires = byKey(all.flatMap((f) => f.wires));
  const latencies = byKey(all.flatMap((f) => f.latencies));
  const emits = byKey(all.flatMap((f) => f.emits));
  const consumes = all.flatMap((f) => f.consumes);
  const handlers = all.flatMap((f) => f.handlers);

  // Consumers per message (components only, dedup).
  const consumersOf = new Map<string, Set<string>>();
  for (const c of consumes) {
    if (!componentDecls.has(c.cls)) continue;
    if (!eventDecls.has(c.message)) continue;
    if (!consumersOf.has(c.message)) consumersOf.set(c.message, new Set());
    consumersOf.get(c.message)!.add(c.cls);
  }

  for (const [message, set] of consumersOf) {
    for (const cls of set) {
      const comp = componentDecls.get(cls)!;
      if (!comp.consumes.includes(message)) comp.consumes.push(message);
    }
  }
  for (const h of handlers) {
    const comp = componentDecls.get(h.cls);
    if (comp && !comp.handler) comp.handler = h.range;
  }

  // Ports: first-class, deduped per (class, port).
  const seenPorts = new Set<string>();
  for (const p of allPorts) {
    const key = `${p.cls}.${p.port}`;
    if (seenPorts.has(key)) continue;
    seenPorts.add(key);
    const port: Port = {
      name: p.port,
      message: emits.get(key)?.message ?? null,
      latency: latencies.get(key)?.latency ?? null,
      decl: p.decl,
    };
    componentDecls.get(p.cls)!.outPorts.push(port);
  }

  // Edges.
  const links: GraphLink[] = [];
  const stubs: Stub[] = [];
  for (const comp of componentDecls.values()) {
    for (const port of comp.outPorts) {
      const key = `${comp.id}.${port.name}`;
      const wire = wires.get(key);
      const message = port.message ?? '';

      if (wire && componentDecls.has(wire.dest)) {
        links.push({
          id: key,
          from: comp.id,
          fromPort: port.name,
          to: wire.dest,
          message,
          latency: port.latency,
          status: 'wired',
        });
        continue;
      }
      if (wire) {
        // configureOut names something that isn't a known block — visible.
        links.push({
          id: key,
          from: comp.id,
          fromPort: port.name,
          to: null,
          message,
          latency: port.latency,
          status: 'unresolved',
        });
        continue;
      }
      if (!port.message) {
        stubs.push({
          from: comp.id,
          port: port.name,
          message: '',
          reason: 'no send detected on this port',
        });
        continue;
      }
      const candidates = [...(consumersOf.get(port.message) ?? [])].filter(
        (c) => c !== comp.id,
      );
      if (candidates.length === 1) {
        links.push({
          id: key,
          from: comp.id,
          fromPort: port.name,
          to: candidates[0],
          message: port.message,
          latency: port.latency,
          status: 'inferred',
        });
      } else if (candidates.length > 1) {
        links.push({
          id: key,
          from: comp.id,
          fromPort: port.name,
          to: null,
          message: port.message,
          latency: port.latency,
          status: 'unresolved',
        });
      } else {
        stubs.push({
          from: comp.id,
          port: port.name,
          message: port.message,
          reason: 'no consumer',
        });
      }
    }
  }

  const sortById = <T extends { id: string }>(rows: T[]) =>
    rows.sort((a, b) => a.id.localeCompare(b.id));

  return {
    components: sortById([...componentDecls.values()]),
    events: sortById([...eventDecls.values()]),
    links: sortById(links),
    stubs: stubs.sort((a, b) => `${a.from}.${a.port}`.localeCompare(`${b.from}.${b.port}`)),
  };
}
