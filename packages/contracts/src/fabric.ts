// Fabric derivation — the ONE place that decides how inter-composite
// dataflow moves. Wires exist only INSIDE a top-level component; between
// top-level components everything is authored as ordered forwarding rules on
// routers (message type + inclusive address range → destination top) and
// DERIVED here: ingress bindings, concrete rule routes, ghost edges for the
// canvas, and diagnostics. Pure over the AuthoringModel; shared by the
// harness generator (addMatchRule/addRoute/routeVia emission), the host
// augment step, and the extension's run gate. Cross-top wires are hard
// errors — codegen stays total (the harness still generates, marking the
// offenders), so a half-edited design never bricks generation.

import type { AuthoredComponent, AuthoringModel } from './model';
import { descendantsOf } from './model';

/** The top-level component an id lives under ("CPU0.IF" → "CPU0"). */
export function topOf(id: string): string {
  const dot = id.indexOf('.');
  return dot < 0 ? id : id.slice(0, dot);
}

/** BFS shortest path from router `a` to router `b` over peers. */
function routerPath(
  byId: Map<string, AuthoredComponent>,
  a: string,
  b: string,
): string[] | null {
  if (a === b) return [a];
  const prev = new Map<string, string>([[a, a]]);
  const queue = [a];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const peers = [...(byId.get(cur)?.peers ?? [])].sort();
    for (const peer of peers) {
      if (prev.has(peer)) continue;
      prev.set(peer, cur);
      if (peer === b) {
        const path = [b];
        let at = b;
        while (at !== a) {
          at = prev.get(at)!;
          path.unshift(at);
        }
        return path;
      }
      queue.push(peer);
    }
  }
  return null;
}

/* ======================= rule-based derivation =======================
 * Inter-composite dataflow is AUTHORED as ordered forwarding rules on
 * routers (message type + inclusive address range → destination top).
 * Everything else here is DERIVED: which router each
 * fabric-bound port enters, the concrete hop routes the harness emits, the
 * ghost edges the canvas draws, and a diagnostics list. Cross-top wires are
 * hard errors. Pure over the AuthoringModel; sorted iteration throughout so
 * output order is deterministic. */

/** One fabric-bound out-port (dangling, message-carrying, on an attached
 *  top) → the router its traffic enters. */
export interface IngressBinding {
  from: string;
  port: string;
  message: string;
  /** The chosen attachment router of topOf(from). */
  router: string;
  /** Some rule on `router` statically matches the port's message. */
  matched: boolean;
}

/** One concrete engine rule: an authored rule expanded to a single message
 *  with its resolved destination leaf and router path. */
export interface RuleRoute {
  router: string;
  ruleIndex: number;
  message: string;
  addrLo?: string;
  addrHi?: string;
  destTop: string;
  /** The packet's finalDest registry id. */
  destLeaf: string;
  /** Router path, rule owner first. Never empty. */
  path: string[];
  /** rule.latencyModel (absent = flat). */
  model?: string;
}

/** One derived top→top dataflow edge for the canvas — the ghost wire. */
export interface DerivedEdge {
  fromTop: string;
  toTop: string;
  router: string;
  ruleIndex: number;
  /** null = any-message rule (address-only). */
  message: string | null;
  addrLo?: string;
  addrHi?: string;
}

export interface FabricDiagnostic {
  /** Only errors block Run; warnings degrade to runtime drop+report. */
  severity: 'error' | 'warning';
  kind:
    | 'crossTopWire'
    | 'unmatchedPort'
    | 'unresolvableRuleDest'
    | 'ambiguousRuleDest'
    | 'unattachedTop'
    | 'noTrunkPath'
    | 'ambiguousIngress'
    | 'conflictingLatencyModel';
  detail: string;
  /** `${from}.${port}` — anchors crossTopWire onto its link. */
  link?: string;
  router?: string;
  ruleIndex?: number;
  component?: string;
  port?: string;
}

export interface FabricDerivation {
  /** All routers, sorted by id. */
  routers: AuthoredComponent[];
  ingress: IngressBinding[];
  ruleRoutes: RuleRoute[];
  derivedEdges: DerivedEdge[];
  diagnostics: FabricDiagnostic[];
}

export function deriveFabric(model: AuthoringModel): FabricDerivation {
  const byId = new Map(model.components.map((c) => [c.id, c]));
  const routers = model.components
    .filter((c) => c.kind === 'router')
    .sort((a, b) => a.id.localeCompare(b.id));
  const leaves = model.components
    .filter((c) => c.kind === 'leaf')
    .sort((a, b) => a.id.localeCompare(b.id));
  const diagnostics: FabricDiagnostic[] = [];
  const ingress: IngressBinding[] = [];
  const ruleRoutes: RuleRoute[] = [];
  const derivedEdges: DerivedEdge[] = [];

  // 1. Cross-top wires are design errors — dataflow between top-level
  //    components is authored as forwarding rules, never wires.
  for (const comp of leaves)
    for (const port of comp.outPorts)
      if (port.to !== null && topOf(comp.id) !== topOf(port.to))
        diagnostics.push({
          severity: 'error',
          kind: 'crossTopWire',
          link: `${comp.id}.${port.name}`,
          component: comp.id,
          port: port.name,
          detail:
            `${comp.id}.${port.name} → ${port.to} crosses top-level components — ` +
            `delete the wire and author a forwarding rule on a router`,
        });

  // 2+3. Fabric-bound ports (dangling + message + attached top) bind to an
  //      ingress router — preferring attachments whose rules match the
  //      message; sorted-first breaks ties.
  const ruleMatches = (routerComp: AuthoredComponent, message: string): boolean =>
    (routerComp.rules ?? []).some((r) => r.message === undefined || r.message === message);

  for (const comp of leaves) {
    const attachments = [...(byId.get(topOf(comp.id))?.fabric ?? [])].sort();
    if (attachments.length === 0) continue; // unattached tops keep plain stubs
    for (const port of comp.outPorts) {
      if (port.to !== null || !port.message) continue;
      const preferred = attachments.filter((r) => {
        const rc = byId.get(r);
        return rc !== undefined && ruleMatches(rc, port.message);
      });
      const chosen = preferred[0] ?? attachments[0];
      if (preferred.length > 1)
        diagnostics.push({
          severity: 'warning',
          kind: 'ambiguousIngress',
          component: comp.id,
          port: port.name,
          router: chosen,
          detail:
            `${comp.id}.${port.name} (${port.message}) could enter ${preferred.join(' or ')} — ` +
            `using ${chosen}`,
        });
      if (preferred.length === 0)
        diagnostics.push({
          severity: 'warning',
          kind: 'unmatchedPort',
          component: comp.id,
          port: port.name,
          router: chosen,
          detail:
            `${comp.id}.${port.name} (${port.message}) enters ${chosen} but no rule there ` +
            `matches ${port.message} — its packets will be dropped and reported`,
        });
      ingress.push({
        from: comp.id,
        port: port.name,
        message: port.message,
        router: chosen,
        matched: preferred.length > 0,
      });
    }
  }

  // 4. Authored rules → concrete routes: expand the message dimension,
  //    resolve the destination leaf by message type, BFS the trunk path.
  for (const routerComp of routers) {
    const ingressMessages = [
      ...new Set(ingress.filter((b) => b.router === routerComp.id).map((b) => b.message)),
    ].sort();
    (routerComp.rules ?? []).forEach((rule, ruleIndex) => {
      const at = (detail: string, kind: FabricDiagnostic['kind']): FabricDiagnostic => ({
        severity: 'warning',
        kind,
        router: routerComp.id,
        ruleIndex,
        detail: `${routerComp.id} rule ${ruleIndex + 1}: ${detail}`,
      });
      const dest = byId.get(rule.to);
      if (!dest || dest.parent !== null || dest.kind === 'router') {
        diagnostics.push(
          at(
            `destination '${rule.to}' ${
              !dest ? 'does not exist' : dest.kind === 'router' ? 'is a router' : 'is nested'
            }`,
            'unresolvableRuleDest',
          ),
        );
        return;
      }
      const destAttachments = [...(dest.fabric ?? [])].sort();
      if (destAttachments.length === 0) {
        diagnostics.push(
          at(`'${rule.to}' is not attached to any router`, 'unattachedTop'),
        );
        return;
      }
      let path: string[] | null = null;
      for (const target of destAttachments) {
        const candidate = routerPath(byId, routerComp.id, target);
        if (candidate && (!path || candidate.length < path.length)) path = candidate;
      }
      if (!path) {
        diagnostics.push(
          at(`no trunk path ${routerComp.id} → ${destAttachments.join('/')}`, 'noTrunkPath'),
        );
        return;
      }
      // Message expansion: an any-message rule covers the messages statically
      // known to enter this router. (Types only hand-written code emits are
      // invisible here — they resolve, or drop, at runtime.)
      const messages = rule.message !== undefined ? [rule.message] : ingressMessages;
      for (const message of messages) {
        let destLeaf: string;
        if (dest.kind === 'leaf') {
          destLeaf = dest.id;
          if (!dest.consumes.includes(message))
            diagnostics.push(at(`'${dest.id}' does not consume ${message}`, 'unresolvableRuleDest'));
        } else {
          const consumers = descendantsOf(model, dest.id)
            .filter((c) => c.kind === 'leaf' && c.consumes.includes(message))
            .sort((a, b) => a.id.localeCompare(b.id));
          const pins = consumers.filter((c) => c.io === 'in');
          const pool = pins.length > 0 ? pins : consumers;
          if (pool.length === 0) {
            diagnostics.push(
              at(`no leaf under '${dest.id}' consumes ${message}`, 'unresolvableRuleDest'),
            );
            continue;
          }
          if (pool.length > 1) {
            diagnostics.push(
              at(
                `${pool.length} leaves under '${dest.id}' consume ${message} ` +
                  `(${pool.map((c) => c.id).join(', ')}) — add a single in-pin`,
                'ambiguousRuleDest',
              ),
            );
            continue;
          }
          destLeaf = pool[0].id;
        }
        ruleRoutes.push({
          router: routerComp.id,
          ruleIndex,
          message,
          ...(rule.addrLo !== undefined ? { addrLo: rule.addrLo } : {}),
          ...(rule.addrHi !== undefined ? { addrHi: rule.addrHi } : {}),
          destTop: dest.id,
          destLeaf,
          path,
          ...(rule.latencyModel !== undefined ? { model: rule.latencyModel } : {}),
        });
      }
    });
  }

  // setRouteLatency is keyed by destination: two rules reaching the same
  // leaf with different models can't both win — surface it.
  const modelsByDest = new Map<string, Set<string>>();
  for (const route of ruleRoutes) {
    if (!route.model) continue;
    const set = modelsByDest.get(route.destLeaf) ?? new Set<string>();
    set.add(route.model);
    modelsByDest.set(route.destLeaf, set);
  }
  for (const [destLeaf, models] of [...modelsByDest].sort(([a], [b]) => a.localeCompare(b)))
    if (models.size > 1)
      diagnostics.push({
        severity: 'warning',
        kind: 'conflictingLatencyModel',
        component: destLeaf,
        detail:
          `destination '${destLeaf}' is reached by rules with different latency models ` +
          `(${[...models].sort().join(', ')}) — hop latency binds per destination, last wins`,
      });

  // 5. Derived top→top edges: one per (rule, attached source top with
  //    statically matching fabric-bound traffic).
  for (const routerComp of routers)
    (routerComp.rules ?? []).forEach((rule, ruleIndex) => {
      const dest = byId.get(rule.to);
      if (!dest || dest.parent !== null || dest.kind === 'router') return;
      const fromTops = [
        ...new Set(
          ingress
            .filter(
              (b) =>
                b.router === routerComp.id &&
                (rule.message === undefined || b.message === rule.message),
            )
            .map((b) => topOf(b.from)),
        ),
      ].sort();
      for (const fromTop of fromTops) {
        if (fromTop === rule.to) continue;
        derivedEdges.push({
          fromTop,
          toTop: rule.to,
          router: routerComp.id,
          ruleIndex,
          message: rule.message ?? null,
          ...(rule.addrLo !== undefined ? { addrLo: rule.addrLo } : {}),
          ...(rule.addrHi !== undefined ? { addrHi: rule.addrHi } : {}),
        });
      }
    });

  return { routers, ingress, ruleRoutes, derivedEdges, diagnostics };
}
