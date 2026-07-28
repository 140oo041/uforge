// The parsed graph is code-truth for structure; the model adds what code
// cannot carry: display labels (Component("…") is the engine identity),
// empty composites that have no children yet, I/O pin roles (a pin is
// an ordinary pass-through leaf in C++ — its direction lives in the sidecar),
// and the router fabric (routers are engine-provided, config-only — they
// exist only in the sidecar and the generated harness main()).
// Composites additionally get `pins`: their minimized node's input/output
// fields, derived from direct I/O pin children. Pure — no vscode dependency.

import { eventBits } from '@iss/contracts/bits';
import { deriveFabric } from '@iss/contracts/fabric';
import type { CompositePin, Graph, GraphComponent, GraphFabric, GraphLink, Stub } from '@iss/contracts/graph';
import { leafName, type AuthoringModel } from '@iss/contracts/model';
import type { SpecDocument } from '@iss/contracts/spec';

export function augmentWithModel(
  graph: Graph,
  model: AuthoringModel,
  spec?: SpecDocument | null,
): Graph {
  const byId = new Map(graph.components.map((c) => [c.id, c]));
  const components: GraphComponent[] = graph.components.map((c) => {
    const authored = model.components.find((m) => m.id === c.id);
    if (!authored) return c;
    const next = { ...c };
    if (authored.label !== leafName(c.id)) next.label = authored.label;
    if (authored.io) next.io = authored.io;
    if (authored.impl) next.impl = authored.impl;
    if (authored.checkDivergence) next.checkDivergence = true;
    if (authored.role === 'trafficgen') {
      next.role = 'trafficgen';
      if (authored.traffic) next.traffic = authored.traffic;
      if (authored.trafficMode) next.trafficMode = authored.trafficMode;
    }
    if (authored.kind === 'router') {
      next.routerLatency = authored.routerLatency ?? 1;
      if (authored.arbitration) next.arbitration = authored.arbitration;
      if (authored.portBandwidthBits !== undefined)
        next.portBandwidthBits = authored.portBandwidthBits;
      if (authored.queueCapacity !== undefined) next.queueCapacity = authored.queueCapacity;
      if (authored.fullPolicy) next.fullPolicy = authored.fullPolicy;
      if (authored.attachmentPolicy) next.attachmentPolicy = authored.attachmentPolicy;
      if (authored.rules) next.rules = authored.rules;
    }
    return next;
  });
  for (const authored of model.components) {
    if (byId.has(authored.id)) continue;
    // Sidecar-only nodes: empty composites and routers (routers never have
    // source files — they are engine-provided, configured by the harness).
    components.push({
      id: authored.id,
      label: authored.label,
      kind: authored.kind,
      parent: authored.parent,
      ...(authored.io ? { io: authored.io } : {}),
      ...(authored.kind === 'router'
        ? {
            routerLatency: authored.routerLatency ?? 1,
            ...(authored.arbitration ? { arbitration: authored.arbitration } : {}),
            ...(authored.portBandwidthBits !== undefined
              ? { portBandwidthBits: authored.portBandwidthBits }
              : {}),
            ...(authored.queueCapacity !== undefined
              ? { queueCapacity: authored.queueCapacity }
              : {}),
            ...(authored.fullPolicy ? { fullPolicy: authored.fullPolicy } : {}),
            ...(authored.attachmentPolicy ? { attachmentPolicy: authored.attachmentPolicy } : {}),
            ...(authored.rules ? { rules: authored.rules } : {}),
          }
        : {}),
      language: 'cpp',
      decl: { file: '', line: 1, col: 1, endLine: 1, endCol: 1 },
      outPorts: [],
      consumes: [],
      vars: [],
    });
  }

  // Composite boundary fields: direct I/O pin children become `pins`.
  const augmented = new Map(components.map((c) => [c.id, c]));
  for (const comp of components) {
    if (comp.kind !== 'composite') continue;
    const pins: CompositePin[] = components
      .filter((c) => c.parent === comp.id && c.io !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((pin) => ({
        id: pin.id,
        io: pin.io!,
        label: pin.label,
        message:
          pin.io === 'in'
            ? (pin.outPorts[0]?.message ?? null)
            : (pin.consumes[0] ?? null),
      }));
    if (pins.length > 0) augmented.set(comp.id, { ...comp, pins });
  }

  // Fabric: topology for the canvas, plus the rule-based derivation —
  // fabric-bound ports surface as 'routed' links, cross-top wires as errors,
  // and the derived top→top dataflow + diagnostics ride the graph.
  const derivation = deriveFabric(model);
  let fabric: GraphFabric | undefined;
  if (derivation.routers.length > 0) {
    const trunkKeys = new Set<string>();
    const trunks: GraphFabric['trunks'] = [];
    for (const r of derivation.routers)
      for (const peer of r.peers ?? []) {
        const key = [r.id, peer].sort().join('|');
        if (trunkKeys.has(key)) continue;
        trunkKeys.add(key);
        const [a, b] = [r.id, peer].sort();
        trunks.push({ a, b });
      }
    fabric = {
      attachments: model.components
        .flatMap((c) => (c.fabric ?? []).map((router) => ({ component: c.id, router })))
        .sort((x, y) => x.component.localeCompare(y.component) || x.router.localeCompare(y.router)),
      trunks,
    };
  }

  // A fabric-bound port may have parsed as a stub (no consumer), an inferred
  // link (unique consumer) or an unresolved link (several) — all become one
  // 'routed' link into the ingress router when a rule matches, or a stub with
  // a pointed reason when none does (runtime would drop + report).
  const ingressOf = new Map(derivation.ingress.map((b) => [`${b.from}.${b.port}`, b]));
  const crossTopError = new Map(
    derivation.diagnostics
      .filter((d) => d.kind === 'crossTopWire' && d.link)
      .map((d) => [d.link!, d.detail]),
  );
  const links: GraphLink[] = [];
  const stubs: Stub[] = [];
  const routedLink = (
    binding: NonNullable<ReturnType<typeof ingressOf.get>>,
    latency: number | null,
  ): GraphLink => ({
    id: `${binding.from}.${binding.port}`,
    from: binding.from,
    fromPort: binding.port,
    to: null,
    message: binding.message,
    latency,
    status: 'routed',
    via: [binding.router],
  });
  for (const l of graph.links) {
    const binding = ingressOf.get(l.id);
    if (binding) {
      if (binding.matched) links.push(routedLink(binding, l.latency));
      else
        stubs.push({
          from: l.from,
          port: l.fromPort,
          message: binding.message,
          reason: `no forwarding rule on ${binding.router} matches ${binding.message}`,
        });
      continue;
    }
    const error = crossTopError.get(l.id);
    links.push(error ? { ...l, fabricError: error } : l);
  }
  for (const s of graph.stubs) {
    const binding = ingressOf.get(`${s.from}.${s.port}`);
    if (!binding) {
      stubs.push(s);
      continue;
    }
    if (binding.matched) links.push(routedLink(binding, null));
    else
      stubs.push({
        ...s,
        message: binding.message,
        reason: `no forwarding rule on ${binding.router} matches ${binding.message}`,
      });
  }

  // Packet widths. The parser recovers the fields; the width they add up to
  // is the same number the generated event class carries and the same number a
  // router charges its bandwidth budget — derived in one place (contracts) so
  // the panel and the engine can never disagree about what a packet costs.
  const events = graph.events.map((event) => {
    const authored = model.events.find((e) => e.id === event.id);
    const override = authored?.bits;
    return {
      ...event,
      bits: eventBits({ fields: event.fields, bits: override }, spec),
      ...(override !== undefined ? { bitsOverridden: true } : {}),
    };
  });

  return {
    ...graph,
    events,
    components: [...augmented.values()],
    links,
    stubs,
    ...(fabric ? { fabric } : {}),
    ...(derivation.derivedEdges.length > 0 ? { derived: derivation.derivedEdges } : {}),
    ...(derivation.diagnostics.length > 0 ? { diagnostics: derivation.diagnostics } : {}),
  };
}
