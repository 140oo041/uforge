// Pure reducer: (model, intent) → new model, throwing on invalid intents.
// Every mutation the canvas can express goes through here.

import { DEFAULT_BANDWIDTH_BITS } from '@iss/contracts/bits';
import { topOf } from '@iss/contracts/fabric';
import {
  AuthoringModel,
  DEFAULT_TRAFFIC,
  EditIntent,
  ForwardingRule,
  TrafficParams,
  cloneModel,
  descendantsOf,
  findComponent,
  findEvent,
  formatAddr,
  isIdentifier,
  isPathId,
  leafName,
  parentOf,
  parseAddr,
} from '@iss/contracts/model';

function assertNewId(model: AuthoringModel, id: string): void {
  if (!isPathId(id)) throw new Error(`'${id}' is not a valid component path (Ident.Ident…)`);
  if (findComponent(model, id) || findEvent(model, id))
    throw new Error(`'${id}' already exists`);
  // Root-level names share the global C++ class/namespace space with events.
  if (parentOf(id) === null && findEvent(model, leafName(id)))
    throw new Error(`'${id}' collides with event '${leafName(id)}'`);
  const parent = parentOf(id);
  if (parent !== null) {
    const container = findComponent(model, parent);
    if (!container) throw new Error(`unknown parent composite '${parent}'`);
    if (container.kind !== 'composite')
      throw new Error(`'${parent}' is a leaf block — it cannot contain children`);
  }
}

function requireComponent(model: AuthoringModel, id: string) {
  const comp = findComponent(model, id);
  if (!comp) throw new Error(`unknown component '${id}'`);
  return comp;
}

function requireLeaf(model: AuthoringModel, id: string) {
  const comp = requireComponent(model, id);
  if (comp.kind === 'router')
    throw new Error(`'${id}' is a router — wires connect leaf blocks; routers use attach`);
  if (comp.kind !== 'leaf')
    throw new Error(`'${id}' is a composite — wires connect leaf blocks (drill in)`);
  return comp;
}

function requireRouter(model: AuthoringModel, id: string) {
  const comp = requireComponent(model, id);
  if (comp.kind !== 'router') throw new Error(`'${id}' is not a router`);
  return comp;
}

function requireEvent(model: AuthoringModel, id: string) {
  const event = findEvent(model, id);
  if (!event) throw new Error(`unknown event '${id}'`);
  return event;
}

function requireTrafficGen(model: AuthoringModel, id: string) {
  const comp = requireLeaf(model, id);
  if (comp.role !== 'trafficgen') throw new Error(`'${id}' is not a traffic generator`);
  return comp;
}

function checkTraffic(traffic: TrafficParams): TrafficParams {
  const positive = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 1)
      throw new Error(`traffic ${name} must be a positive integer, got ${v}`);
  };
  const nonNegative = (name: string, v: number) => {
    if (!Number.isInteger(v) || v < 0)
      throw new Error(`traffic ${name} must be a non-negative integer, got ${v}`);
  };
  positive('period', traffic.period);
  positive('burst', traffic.burst);
  nonNegative('count', traffic.count);
  nonNegative('start', traffic.start);
  if (!['fixed', 'roundrobin', 'random'].includes(traffic.pattern))
    throw new Error(`unknown traffic pattern '${traffic.pattern}'`);
  const clean: TrafficParams = {
    period: traffic.period,
    burst: traffic.burst,
    count: traffic.count,
    start: traffic.start,
    pattern: traffic.pattern,
  };
  // Address emission: the trio is all-or-none, ranges canonicalize to 0x-hex.
  const wantsAddr =
    traffic.addrPattern !== undefined ||
    traffic.addrLo !== undefined ||
    traffic.addrHi !== undefined;
  if (wantsAddr) {
    if (
      traffic.addrPattern === undefined ||
      traffic.addrLo === undefined ||
      traffic.addrHi === undefined
    )
      throw new Error(`traffic address emission needs addrLo, addrHi and addrPattern together`);
    if (!['random', 'sequential'].includes(traffic.addrPattern))
      throw new Error(`unknown traffic addrPattern '${traffic.addrPattern}'`);
    const lo = parseAddr(traffic.addrLo);
    if (lo === null) throw new Error(`bad address '${traffic.addrLo}' — use 0x-hex or decimal`);
    const hi = parseAddr(traffic.addrHi);
    if (hi === null) throw new Error(`bad address '${traffic.addrHi}' — use 0x-hex or decimal`);
    if (lo > hi) throw new Error(`address range lo ${formatAddr(lo)} exceeds hi ${formatAddr(hi)}`);
    clean.addrLo = formatAddr(lo);
    clean.addrHi = formatAddr(hi);
    clean.addrPattern = traffic.addrPattern;
  }
  return clean;
}

/** Validate + canonicalize one forwarding rule (addresses re-stored as
 *  lowercase 0x-hex; unknown keys dropped). Throws on invalid input. */
function checkRule(model: AuthoringModel, rule: ForwardingRule): ForwardingRule {
  const dest = requireComponent(model, rule.to);
  if (dest.kind === 'router')
    throw new Error(`rule destination '${rule.to}' is a router — rules target components`);
  if (dest.parent !== null)
    throw new Error(`rule destination '${rule.to}' is nested — rules target top-level components`);
  if (rule.message !== undefined) requireEvent(model, rule.message);
  const lo = rule.addrLo !== undefined ? parseAddr(rule.addrLo) : null;
  if (rule.addrLo !== undefined && lo === null)
    throw new Error(`bad address '${rule.addrLo}' — use 0x-hex or decimal`);
  const hi = rule.addrHi !== undefined ? parseAddr(rule.addrHi) : null;
  if (rule.addrHi !== undefined && hi === null)
    throw new Error(`bad address '${rule.addrHi}' — use 0x-hex or decimal`);
  if (lo !== null && hi !== null && lo > hi)
    throw new Error(`address range lo ${formatAddr(lo)} exceeds hi ${formatAddr(hi)}`);
  if (rule.latencyModel !== undefined && !isIdentifier(rule.latencyModel))
    throw new Error(`'${rule.latencyModel}' is not a valid latency-model function name`);
  return {
    ...(rule.message !== undefined ? { message: rule.message } : {}),
    ...(lo !== null ? { addrLo: formatAddr(lo) } : {}),
    ...(hi !== null ? { addrHi: formatAddr(hi) } : {}),
    to: rule.to,
    ...(rule.latencyModel !== undefined ? { latencyModel: rule.latencyModel } : {}),
  };
}

function checkLatency(latency: number | null | undefined): number | null {
  if (latency === null || latency === undefined) return null;
  if (!Number.isInteger(latency) || latency < 0)
    throw new Error(`latency must be a non-negative integer, got ${latency}`);
  return latency;
}

export function applyIntent(model: AuthoringModel, intent: EditIntent): AuthoringModel {
  const next = cloneModel(model);
  switch (intent.kind) {
    case 'addComponent': {
      assertNewId(next, intent.id);
      if (intent.io && (intent.nodeKind ?? 'leaf') !== 'leaf')
        throw new Error(`an I/O pin must be a leaf block`);
      if (intent.nodeKind === 'router' && parentOf(intent.id) !== null)
        throw new Error(`routers live at the top level — '${intent.id}' is nested`);
      if (intent.role === 'trafficgen' && ((intent.nodeKind ?? 'leaf') !== 'leaf' || intent.io))
        throw new Error(`a traffic generator must be a plain leaf block`);
      next.components.push({
        id: intent.id,
        label: intent.label ?? leafName(intent.id),
        kind: intent.nodeKind ?? 'leaf',
        parent: parentOf(intent.id),
        ...(intent.io ? { io: intent.io } : {}),
        ...(intent.role === 'trafficgen'
          ? { role: 'trafficgen' as const, traffic: { ...DEFAULT_TRAFFIC } }
          : {}),
        outPorts: [],
        consumes: [],
        vars: [],
      });
      return next;
    }
    case 'renameComponent': {
      requireComponent(next, intent.id).label = intent.label;
      return next;
    }
    case 'removeComponent': {
      requireComponent(next, intent.id);
      const removed = new Set([intent.id, ...descendantsOf(next, intent.id).map((c) => c.id)]);
      next.components = next.components.filter((c) => !removed.has(c.id));
      // Wires into the removed subtree become dangling, not deleted — the
      // canvas shows them as unresolved so the user sees what broke.
      for (const c of next.components)
        for (const p of c.outPorts) if (p.to !== null && removed.has(p.to)) p.to = null;
      // Fabric references to a removed router (attachments + trunks) go away,
      // as do routers' policy entries for a removed attachment.
      for (const c of next.components) {
        if (c.fabric) {
          c.fabric = c.fabric.filter((r) => !removed.has(r));
          if (c.fabric.length === 0) delete c.fabric;
        }
        if (c.peers) {
          c.peers = c.peers.filter((p) => !removed.has(p));
          if (c.peers.length === 0) delete c.peers;
        }
        if (c.attachmentPolicy) {
          for (const id of Object.keys(c.attachmentPolicy))
            if (removed.has(id)) delete c.attachmentPolicy[id];
          if (Object.keys(c.attachmentPolicy).length === 0) delete c.attachmentPolicy;
        }
      }
      return next;
    }
    case 'duplicateComponent': {
      const source = requireComponent(next, intent.id);
      assertNewId(next, intent.newId);
      if (intent.newId === intent.id || intent.newId.startsWith(`${intent.id}.`))
        throw new Error(`cannot duplicate '${intent.id}' into itself`);
      const subtree = [source, ...descendantsOf(next, intent.id)];
      const remap = (id: string): string =>
        id === intent.id ? intent.newId : intent.newId + id.slice(intent.id.length);
      const inSubtree = new Set(subtree.map((c) => c.id));
      for (const original of subtree) {
        const copy = JSON.parse(JSON.stringify(original)) as typeof original;
        copy.id = remap(original.id);
        copy.parent = parentOf(copy.id);
        if (copy.label === leafName(original.id)) copy.label = leafName(copy.id);
        for (const port of copy.outPorts)
          if (port.to !== null && inSubtree.has(port.to)) port.to = remap(port.to);
        next.components.push(copy);
        // A duplicated router keeps its trunks — mirror the copy into each
        // peer so the symmetric-peers invariant holds.
        if (copy.kind === 'router' && copy.peers)
          for (const peerId of copy.peers) {
            const peer = findComponent(next, peerId);
            if (peer) peer.peers = [...new Set([...(peer.peers ?? []), copy.id])].sort();
          }
      }
      return next;
    }
    case 'addEvent': {
      if (!isIdentifier(intent.id)) throw new Error(`'${intent.id}' is not a valid C++ identifier`);
      if (findEvent(next, intent.id) || findComponent(next, intent.id))
        throw new Error(`'${intent.id}' already exists`);
      for (const f of intent.fields ?? [])
        if (!isIdentifier(f.name)) throw new Error(`bad field name '${f.name}'`);
      next.events.push({ id: intent.id, fields: intent.fields ?? [] });
      return next;
    }
    case 'editEventFields': {
      for (const f of intent.fields)
        if (!isIdentifier(f.name)) throw new Error(`bad field name '${f.name}'`);
      requireEvent(next, intent.id).fields = intent.fields;
      return next;
    }
    case 'removeEvent': {
      requireEvent(next, intent.id);
      const users = next.components.filter(
        (c) =>
          c.consumes.includes(intent.id) ||
          c.outPorts.some((p) => p.message === intent.id) ||
          (c.rules ?? []).some((r) => r.message === intent.id),
      );
      if (users.length > 0)
        throw new Error(
          `event '${intent.id}' is used by ${users.map((c) => c.id).join(', ')} — disconnect first`,
        );
      next.events = next.events.filter((e) => e.id !== intent.id);
      return next;
    }
    case 'addWire': {
      const from = requireLeaf(next, intent.from);
      if (!isIdentifier(intent.port)) throw new Error(`bad port name '${intent.port}'`);
      requireEvent(next, intent.message);
      if (from.outPorts.some((p) => p.name === intent.port))
        throw new Error(`component '${intent.from}' already has a port '${intent.port}'`);
      if (from.vars.some((v) => v.name === intent.port))
        throw new Error(`'${intent.port}' is already a variable on '${intent.from}'`);
      const to = intent.to ?? null;
      if (to !== null && topOf(intent.from) !== topOf(to))
        throw new Error(
          `'${intent.from}' and '${to}' live under different top-level components — ` +
            `cross-top wires are not allowed; author a forwarding rule on a router instead`,
        );
      if (to !== null) {
        const dest = requireLeaf(next, to);
        if (!dest.consumes.includes(intent.message)) dest.consumes.push(intent.message);
      }
      from.outPorts.push({
        name: intent.port,
        message: intent.message,
        to,
        latency: checkLatency(intent.latency),
      });
      return next;
    }
    case 'deleteWire': {
      const from = requireComponent(next, intent.from);
      if (!from.outPorts.some((p) => p.name === intent.port))
        throw new Error(`component '${intent.from}' has no port '${intent.port}'`);
      from.outPorts = from.outPorts.filter((p) => p.name !== intent.port);
      return next;
    }
    case 'setLatency': {
      const from = requireComponent(next, intent.from);
      const port = from.outPorts.find((p) => p.name === intent.port);
      if (!port) throw new Error(`component '${intent.from}' has no port '${intent.port}'`);
      port.latency = checkLatency(intent.latency);
      return next;
    }
    case 'setConsumes': {
      const comp = requireLeaf(next, intent.id);
      for (const id of intent.consumes) requireEvent(next, id);
      comp.consumes = [...new Set(intent.consumes)];
      return next;
    }
    case 'setImpl': {
      const comp = requireLeaf(next, intent.id);
      if (comp.role === 'trafficgen' && intent.impl !== 'cpp')
        throw new Error(`'${intent.id}' is a traffic generator — it has no SV twin`);
      if (intent.impl === 'cpp') delete comp.impl;
      else comp.impl = intent.impl;
      return next;
    }
    case 'setCheckDivergence': {
      const comp = requireLeaf(next, intent.id);
      if (intent.enabled) comp.checkDivergence = true;
      else delete comp.checkDivergence;
      return next;
    }
    case 'attachRouter': {
      const comp = requireComponent(next, intent.id);
      if (comp.kind === 'router') throw new Error(`'${intent.id}' is a router — link routers instead`);
      if (comp.parent !== null)
        throw new Error(`'${intent.id}' is nested — the fabric attaches top-level components`);
      requireRouter(next, intent.router);
      const attached = new Set(comp.fabric ?? []);
      if (intent.attach) attached.add(intent.router);
      else attached.delete(intent.router);
      if (attached.size === 0) delete comp.fabric;
      else comp.fabric = [...attached].sort();
      // A detached component's per-attachment policy on that router goes away.
      if (!intent.attach) {
        const router = requireRouter(next, intent.router);
        if (router.attachmentPolicy) {
          delete router.attachmentPolicy[intent.id];
          if (Object.keys(router.attachmentPolicy).length === 0) delete router.attachmentPolicy;
        }
      }
      return next;
    }
    case 'linkRouters': {
      if (intent.a === intent.b) throw new Error(`cannot link router '${intent.a}' to itself`);
      const a = requireRouter(next, intent.a);
      const b = requireRouter(next, intent.b);
      if (intent.connect) {
        a.peers = [...new Set([...(a.peers ?? []), intent.b])].sort();
        b.peers = [...new Set([...(b.peers ?? []), intent.a])].sort();
      } else {
        a.peers = (a.peers ?? []).filter((p) => p !== intent.b);
        b.peers = (b.peers ?? []).filter((p) => p !== intent.a);
        if (a.peers.length === 0) delete a.peers;
        if (b.peers.length === 0) delete b.peers;
      }
      return next;
    }
    case 'setWireLatencyModel': {
      const from = requireComponent(next, intent.from);
      const port = from.outPorts.find((p) => p.name === intent.port);
      if (!port) throw new Error(`component '${intent.from}' has no port '${intent.port}'`);
      if (intent.model === null) delete port.latencyModel;
      else {
        if (!isIdentifier(intent.model))
          throw new Error(`'${intent.model}' is not a valid latency-model function name`);
        port.latencyModel = intent.model;
      }
      return next;
    }
    case 'setRouterLatency': {
      const router = requireRouter(next, intent.id);
      if (!Number.isInteger(intent.latency) || intent.latency < 0)
        throw new Error(`router latency must be a non-negative integer, got ${intent.latency}`);
      if (intent.latency === 1) delete router.routerLatency;
      else router.routerLatency = intent.latency;
      return next;
    }
    case 'setRouterArbitration': {
      const router = requireRouter(next, intent.id);
      if (intent.policy === 'fifo') delete router.arbitration;
      else router.arbitration = intent.policy;
      return next;
    }
    case 'setRouterBandwidth': {
      const router = requireRouter(next, intent.id);
      if (!Number.isInteger(intent.bandwidthBits) || intent.bandwidthBits < 1)
        throw new Error(
          `router bandwidth must be a positive number of bits, got ${intent.bandwidthBits}`,
        );
      if (intent.bandwidthBits === DEFAULT_BANDWIDTH_BITS) delete router.portBandwidthBits;
      else router.portBandwidthBits = intent.bandwidthBits;
      return next;
    }
    case 'setEventBits': {
      const event = findEvent(next, intent.id);
      if (!event) throw new Error(`no event '${intent.id}'`);
      // null clears the override — the width goes back to the sum of the
      // declared field types, which is the answer that stays correct as the
      // payload is edited.
      if (intent.bits === null) delete event.bits;
      else {
        if (!Number.isInteger(intent.bits) || intent.bits < 1)
          throw new Error(`packet width must be a positive number of bits, got ${intent.bits}`);
        event.bits = intent.bits;
      }
      return next;
    }
    case 'setRouterQueue': {
      const router = requireRouter(next, intent.id);
      if (intent.capacity === null) {
        // Unbounded again: the full policy is moot without a bound.
        delete router.queueCapacity;
        delete router.fullPolicy;
        return next;
      }
      if (!Number.isInteger(intent.capacity) || intent.capacity < 1)
        throw new Error(`queue capacity must be a positive integer, got ${intent.capacity}`);
      router.queueCapacity = intent.capacity;
      const policy = intent.fullPolicy ?? router.fullPolicy ?? 'stall';
      if (policy === 'stall') delete router.fullPolicy;
      else router.fullPolicy = policy;
      return next;
    }
    case 'setAttachmentPolicy': {
      const router = requireRouter(next, intent.router);
      const comp = requireComponent(next, intent.component);
      if (!(comp.fabric ?? []).includes(intent.router))
        throw new Error(`'${intent.component}' is not attached to router '${intent.router}'`);
      const policies = router.attachmentPolicy ?? {};
      const entry = { ...(policies[intent.component] ?? {}) };
      if (intent.weight !== undefined) {
        if (intent.weight === null) delete entry.weight;
        else if (!Number.isInteger(intent.weight) || intent.weight < 1)
          throw new Error(`weight must be a positive integer, got ${intent.weight}`);
        else if (intent.weight === 1) delete entry.weight;
        else entry.weight = intent.weight;
      }
      if (intent.priority !== undefined) {
        if (intent.priority === null) delete entry.priority;
        else if (!Number.isInteger(intent.priority) || intent.priority < 0)
          throw new Error(`priority must be a non-negative integer, got ${intent.priority}`);
        else entry.priority = intent.priority;
      }
      if (Object.keys(entry).length === 0) delete policies[intent.component];
      else policies[intent.component] = entry;
      if (Object.keys(policies).length === 0) delete router.attachmentPolicy;
      else router.attachmentPolicy = policies;
      return next;
    }
    case 'setTraffic': {
      const comp = requireTrafficGen(next, intent.id);
      comp.traffic = checkTraffic(intent.traffic);
      return next;
    }
    case 'setTrafficMode': {
      const comp = requireTrafficGen(next, intent.id);
      if (intent.mode === 'generated') delete comp.trafficMode;
      else comp.trafficMode = intent.mode;
      return next;
    }
    case 'addForwardingRule': {
      const router = requireRouter(next, intent.router);
      const rule = checkRule(next, intent.rule);
      const rules = router.rules ?? [];
      const index = intent.index ?? rules.length;
      if (!Number.isInteger(index) || index < 0 || index > rules.length)
        throw new Error(`rule index ${index} out of range (0..${rules.length})`);
      rules.splice(index, 0, rule);
      router.rules = rules;
      return next;
    }
    case 'updateForwardingRule': {
      const router = requireRouter(next, intent.router);
      const rules = router.rules ?? [];
      if (!Number.isInteger(intent.index) || intent.index < 0 || intent.index >= rules.length)
        throw new Error(`rule index ${intent.index} out of range (0..${rules.length - 1})`);
      rules[intent.index] = checkRule(next, intent.rule);
      return next;
    }
    case 'removeForwardingRule': {
      const router = requireRouter(next, intent.router);
      const rules = router.rules ?? [];
      if (!Number.isInteger(intent.index) || intent.index < 0 || intent.index >= rules.length)
        throw new Error(`rule index ${intent.index} out of range (0..${rules.length - 1})`);
      rules.splice(intent.index, 1);
      if (rules.length === 0) delete router.rules;
      return next;
    }
    case 'moveForwardingRule': {
      const router = requireRouter(next, intent.router);
      const rules = router.rules ?? [];
      const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < rules.length;
      if (!valid(intent.from) || !valid(intent.to))
        throw new Error(
          `rule move ${intent.from} → ${intent.to} out of range (0..${rules.length - 1})`,
        );
      const [rule] = rules.splice(intent.from, 1);
      rules.splice(intent.to, 0, rule);
      return next;
    }
    case 'setVars': {
      const comp = requireLeaf(next, intent.id);
      const seen = new Set<string>();
      for (const v of intent.vars) {
        if (!isIdentifier(v.name)) throw new Error(`bad variable name '${v.name}'`);
        if (!v.type.trim()) throw new Error(`variable '${v.name}' needs a type`);
        if (seen.has(v.name)) throw new Error(`duplicate variable '${v.name}'`);
        if (comp.outPorts.some((p) => p.name === v.name))
          throw new Error(`'${v.name}' is already a port on '${intent.id}'`);
        seen.add(v.name);
      }
      comp.vars = intent.vars.map((v) => ({
        name: v.name,
        type: v.type.trim(),
        init: v.init && v.init.trim() !== '' ? v.init.trim() : null,
      }));
      return next;
    }
  }
}
