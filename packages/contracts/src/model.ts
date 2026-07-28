// The write-model: what the canvas authors, rendered to C++ by the writer.
// Principle: code is the truth — every construct here emits C++ the parser
// reads straight back, including the wiring (configureOut via the Registry),
// so a drawn wire survives write → reparse as a Tier-1 'wired' link.
//
// Hierarchy: component ids are dot-paths ("CPU0.IF"). A composite ("CPU0")
// is a grouping node — C++ namespace + directory — whose children carry
// `parent: "CPU0"`. Composites emit no code of their own.

export interface AuthoredField {
  name: string;
  type: string;
}

export interface AuthoredEvent {
  id: string;
  fields: AuthoredField[];
  /** Explicit wire width in bits, overriding the sum of the field widths —
   *  for payloads the field list can't express (compression, an unnamed
   *  header, a burst that is one logical packet). Absent = derived. */
  bits?: number;
}

export interface AuthoredPort {
  name: string;
  message: string;
  /** Destination component id (full dot-path); null = intentionally dangling. */
  to: string | null;
  latency: number | null;
  /** Fabric-routed wires only: router latency-model function name (a member
   *  of each router's src/<R>.cpp class). Absent = the flat constant.
   *  Sidecar-only — never affects the generated block code. */
  latencyModel?: string;
}

/** A component state variable — a real C++ member on the class. */
export interface AuthoredVar {
  name: string;
  type: string;
  /** Optional init expression (e.g. "0x80000000"); null = type default. */
  init: string | null;
}

/** 'router': a top-level fabric switch — engine-provided (no .cpp/.sv),
 *  sidecar-only, transports cross-component traffic hop by hop. */
export type ComponentKind = 'leaf' | 'composite' | 'router';

/** I/O pin role: an 'in' pin receives from outside and forwards inward; an
 *  'out' pin collects from inside and sends outward. Sidecar-only (the C++
 *  is an ordinary pass-through leaf); a composite's minimized node renders
 *  its direct pin children as its input/output fields. */
export type IoDirection = 'in' | 'out';

/** Router arbitration for contended output ports. 'fifo' = arrival order
 *  (the default); 'roundrobin' = origins take turns; 'priority' = fixed
 *  priority per attachment (lower rank drains first); 'weighted' = deficit
 *  round-robin sharing bandwidth in proportion to attachment weights. */
export type ArbitrationPolicy = 'fifo' | 'roundrobin' | 'priority' | 'weighted';

/** What a bounded router queue does with a packet arriving while full:
 *  'stall' = the packet waits on the wire and retries next cycle (default);
 *  'drop' = the packet is discarded and reported as a 'drop' divergence. */
export type QueueFullPolicy = 'stall' | 'drop';

/** Per-attachment arbitration knobs (weight for 'weighted', priority rank
 *  for 'priority'), keyed by attached top-level component id. */
export interface AttachmentPolicy {
  weight?: number;
  priority?: number;
}

/** One ingress forwarding rule on a router. Rules are an ORDERED list —
 *  first match wins. A packet entering the fabric without a destination is
 *  matched on message type (absent = any) and inclusive address range
 *  (absent bound = open); the winning rule names the destination top-level
 *  component. Addresses are canonical 0x-hex STRINGS (uint64 does not fit a
 *  JS number) — parse with parseAddr, compare as BigInt. */
export interface ForwardingRule {
  /** Event id to match; absent = any message. */
  message?: string;
  /** Inclusive lower bound, canonical 0x-hex; absent = 0. */
  addrLo?: string;
  /** Inclusive upper bound, canonical 0x-hex; absent = 2^64-1. */
  addrHi?: string;
  /** Destination TOP-LEVEL component id (composite or leaf; never a router). */
  to: string;
  /** Optional latency-model fn name (member of the routers' src/<R>.cpp). */
  latencyModel?: string;
}

/** Traffic-generator parameters. The generator emits `burst` packets every
 *  `period` cycles starting at `start`, until `count` packets have been sent
 *  (0 = unlimited). `pattern` picks the destination among the block's wired
 *  out-ports per packet: 'fixed' = always the first, 'roundrobin' = cycle
 *  through them, 'random' = xorshift-pseudorandom. When `addrPattern` is set
 *  each packet also carries an address drawn from [addrLo, addrHi] (0x-hex
 *  strings): 'random' = xorshift within the range, 'sequential' = lo, lo+1,
 *  … wrapping at hi. All three address fields are set together. */
export interface TrafficParams {
  period: number;
  burst: number;
  count: number;
  start: number;
  pattern: 'fixed' | 'roundrobin' | 'random';
  addrLo?: string;
  addrHi?: string;
  addrPattern?: 'random' | 'sequential';
}

export const DEFAULT_TRAFFIC: TrafficParams = {
  period: 4,
  burst: 1,
  count: 0,
  start: 0,
  pattern: 'roundrobin',
};

/** How a traffic generator's behavior is owned: 'generated' = the whole
 *  block body is regenerated from its params (the default); 'custom' = the
 *  file switches to the head+tail layout and tick() below the END marker is
 *  hand-owned (params become inert until re-attach). */
export type TrafficMode = 'generated' | 'custom';

/** Which implementation is "active" for a leaf: the C++ block or its SV twin.
 *  Both files always exist. 'sv' means Run verilates the twin and executes it
 *  through a generated co-sim adapter (build/iss_sv_adapters_gen.h); 'cpp'
 *  (the default) executes the authored C++ handler. */
export type ImplChoice = 'cpp' | 'sv';

export interface AuthoredComponent {
  /** Full dot-path id, e.g. "CPU0.IF". */
  id: string;
  label: string;
  kind: ComponentKind;
  /** Parent composite id, or null at the root. Must equal the id's prefix. */
  parent: string | null;
  /** Set when this leaf is an I/O pin block. */
  io?: IoDirection;
  /** Active implementation; absent = 'cpp'. */
  impl?: ImplChoice;
  /** SV-impl leaves only: run the C++ block in shadow and report per-token
   *  output mismatches as 'cosim' divergences. Absent = off. The run-config
   *  master switch (RunConfig.checkDivergence) enables it for all SV leaves. */
  checkDivergence?: boolean;
  /** Routers only: per-hop forwarding latency in cycles (absent = 1). */
  routerLatency?: number;
  /** Routers only: arbitration policy for contended ports (absent = 'fifo'). */
  arbitration?: ArbitrationPolicy;
  /** Routers only: BITS forwarded per output port per cycle (absent =
   *  DEFAULT_BANDWIDTH_BITS). A packet costs its own width, so a wide payload
   *  occupies the port for several cycles; see `bits.ts`. */
  portBandwidthBits?: number;
  /** Routers only: bound on each output-port queue (absent = unbounded). */
  queueCapacity?: number;
  /** Routers only: full-queue behavior; meaningful only with a queueCapacity
   *  (absent = 'stall'). */
  fullPolicy?: QueueFullPolicy;
  /** Routers only: per-attachment weight/priority, keyed by attached
   *  top-level component id. The writer expands a composite attachment to
   *  one engine call per contained leaf (origins are leaf ids). */
  attachmentPolicy?: Record<string, AttachmentPolicy>;
  /** Routers only: trunk connections to other routers. Stored symmetrically
   *  on both endpoints (the reducer maintains the invariant). */
  peers?: string[];
  /** Routers only: ordered ingress forwarding rules — the authored truth of
   *  inter-composite dataflow (there are no cross-top wires). Absent = no
   *  rules: every packet entering here without a destination is dropped and
   *  reported. Sidecar-only; bound in the generated harness. */
  rules?: ForwardingRule[];
  /** Top-level components only: the routers this component attaches to. When
   *  both endpoints of a cross-component wire are attached, its transport is
   *  fabric-routed automatically (over the shortest trunk path between any of
   *  the source's and destination's attachment routers). Stored sorted and
   *  deduped; the field is absent when the component attaches to no router. */
  fabric?: string[];
  /** Leaves only: this block is a traffic generator — its C++ body is
   *  generated from `traffic` (or hand-owned below the markers in 'custom'
   *  mode). Sidecar-only; the parser sees an ordinary leaf. */
  role?: 'trafficgen';
  /** Traffic generators only: the generation parameters. */
  traffic?: TrafficParams;
  /** Traffic generators only: behavior ownership (absent = 'generated'). */
  trafficMode?: TrafficMode;
  outPorts: AuthoredPort[];
  consumes: string[];
  vars: AuthoredVar[];
}

/** Sidecar schema version, bumped whenever the on-disk shape changes in a way
 *  an older build cannot read correctly.
 *
 *  Pre-versioned sidecars carry no `schemaVersion` and migrate as version 0.
 *  A sidecar NEWER than this is refused rather than migrated — see `loadModel`.
 *  That matters because a sidecar this build cannot read used to be
 *  indistinguishable from no sidecar at all, and was overwritten on the next
 *  write. */
export const SCHEMA_VERSION = 1;

export interface AuthoringModel {
  /** Absent in pre-versioned sidecars; stamped on every write. */
  schemaVersion?: number;
  components: AuthoredComponent[];
  events: AuthoredEvent[];
}

export const EMPTY_MODEL: AuthoringModel = {
  schemaVersion: SCHEMA_VERSION,
  components: [],
  events: [],
};

export type EditIntent =
  | {
      kind: 'addComponent';
      id: string;
      label?: string;
      parent?: string | null;
      nodeKind?: ComponentKind;
      io?: IoDirection;
      role?: 'trafficgen';
    }
  | { kind: 'renameComponent'; id: string; label: string }
  | { kind: 'removeComponent'; id: string }
  | { kind: 'duplicateComponent'; id: string; newId: string }
  | { kind: 'addEvent'; id: string; fields?: AuthoredField[] }
  | { kind: 'editEventFields'; id: string; fields: AuthoredField[] }
  | { kind: 'removeEvent'; id: string }
  | {
      kind: 'addWire';
      from: string;
      port: string;
      message: string;
      to?: string | null;
      latency?: number | null;
    }
  | { kind: 'deleteWire'; from: string; port: string }
  | { kind: 'setLatency'; from: string; port: string; latency: number | null }
  | { kind: 'setConsumes'; id: string; consumes: string[] }
  | { kind: 'setVars'; id: string; vars: AuthoredVar[] }
  | { kind: 'setImpl'; id: string; impl: ImplChoice }
  | { kind: 'setCheckDivergence'; id: string; enabled: boolean }
  | { kind: 'attachRouter'; id: string; router: string; attach: boolean }
  | { kind: 'linkRouters'; a: string; b: string; connect: boolean }
  | { kind: 'setRouterLatency'; id: string; latency: number }
  | { kind: 'setRouterArbitration'; id: string; policy: ArbitrationPolicy }
  | { kind: 'setRouterBandwidth'; id: string; bandwidthBits: number }
  | { kind: 'setEventBits'; id: string; bits: number | null }
  | { kind: 'setRouterQueue'; id: string; capacity: number | null; fullPolicy?: QueueFullPolicy }
  | {
      kind: 'setAttachmentPolicy';
      router: string;
      component: string;
      weight?: number | null;
      priority?: number | null;
    }
  | { kind: 'setWireLatencyModel'; from: string; port: string; model: string | null }
  | { kind: 'setTraffic'; id: string; traffic: TrafficParams }
  | { kind: 'setTrafficMode'; id: string; mode: TrafficMode }
  | { kind: 'addForwardingRule'; router: string; rule: ForwardingRule; index?: number }
  | { kind: 'updateForwardingRule'; router: string; index: number; rule: ForwardingRule }
  | { kind: 'removeForwardingRule'; router: string; index: number }
  | { kind: 'moveForwardingRule'; router: string; from: number; to: number };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Largest uint64 — the open upper bound for address ranges. */
export const ADDR_MAX: bigint = (1n << 64n) - 1n;

/** Parse an address literal: 0x-hex or plain decimal, `_` separators
 *  tolerated. Returns null when malformed or outside [0, 2^64-1]. */
export function parseAddr(text: string): bigint | null {
  const cleaned = text.trim().replace(/_/g, '');
  if (!/^(0[xX][0-9a-fA-F]+|\d+)$/.test(cleaned)) return null;
  const value = BigInt(cleaned);
  return value >= 0n && value <= ADDR_MAX ? value : null;
}

/** Canonical address text: lowercase 0x-hex. */
export function formatAddr(value: bigint): string {
  return `0x${value.toString(16)}`;
}

export function isIdentifier(text: string): boolean {
  return IDENT.test(text);
}

/** Dot-path id: identifiers joined by '.'. */
export function isPathId(text: string): boolean {
  return PATH.test(text);
}

export function leafName(id: string): string {
  const dot = id.lastIndexOf('.');
  return dot < 0 ? id : id.slice(dot + 1);
}

export function parentOf(id: string): string | null {
  const dot = id.lastIndexOf('.');
  return dot < 0 ? null : id.slice(0, dot);
}

export function cloneModel(model: AuthoringModel): AuthoringModel {
  return JSON.parse(JSON.stringify(model)) as AuthoringModel;
}

export function findComponent(
  model: AuthoringModel,
  id: string,
): AuthoredComponent | undefined {
  return model.components.find((c) => c.id === id);
}

export function findEvent(model: AuthoringModel, id: string): AuthoredEvent | undefined {
  return model.events.find((e) => e.id === id);
}

/** All components strictly inside `id` (any depth). */
export function descendantsOf(model: AuthoringModel, id: string): AuthoredComponent[] {
  const prefix = `${id}.`;
  return model.components.filter((c) => c.id.startsWith(prefix));
}
