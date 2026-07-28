// The read-model: what the parser recovers from the C++ sources.
// Shared by parser, host, and webview — the single contract.
//
// v2 fixes baked into the shape (DESIGN_PLAN v3 §0/P0):
//  - Ports are first-class on components (name + message + latency), so the
//    canvas anchors wires to real ports and the read-model can represent
//    exactly what the write-model authored.
//  - Links carry (from, fromPort) and a status that includes 'unresolved' —
//    a link the parser couldn't pin to one consumer is rendered visibly
//    instead of silently dropped.

import type { DerivedEdge, FabricDiagnostic } from './fabric';
import type { ComponentKind, ForwardingRule } from './model';

export interface SourceRange {
  file: string;
  line: number; // 1-based
  col: number;
  endLine: number;
  endCol: number;
}

export type Language = 'cpp' | 'sv';

export interface Port {
  name: string;
  /** Event type this port emits, when the parser could pair a send to it. */
  message: string | null;
  latency: number | null;
  decl?: SourceRange;
}

/** A composite's boundary field, derived from an I/O pin block inside it. */
export interface CompositePin {
  /** The pin block's full id, e.g. "CPU0.in1". */
  id: string;
  io: 'in' | 'out';
  label: string;
  /** in-pin: the event it forwards inward; out-pin: the event it collects. */
  message: string | null;
}

export interface GraphComponent {
  /** Full dot-path id ("CPU0.IF"); segments mirror the C++ namespace path. */
  id: string;
  label: string;
  kind: ComponentKind;
  /** Enclosing composite id, or null at the root (derived from the id path). */
  parent: string | null;
  /** Set on I/O pin leaves (sidecar-only; merged host-side). */
  io?: 'in' | 'out';
  /** Active implementation choice (sidecar-only; merged host-side). */
  impl?: 'cpp' | 'sv';
  /** SV↔C++ divergence check opt-in (sidecar-only; merged host-side). */
  checkDivergence?: boolean;
  /** On routers: per-hop forwarding latency (sidecar-only; merged host-side). */
  routerLatency?: number;
  /** On routers: arbitration policy (sidecar-only; absent = 'fifo'). */
  arbitration?: 'fifo' | 'roundrobin' | 'priority' | 'weighted';
  /** On routers: BITS per output port per cycle (sidecar-only; absent =
   *  DEFAULT_BANDWIDTH_BITS). Packets cost their own width. */
  portBandwidthBits?: number;
  /** On routers: output-queue bound (sidecar-only; absent = unbounded). */
  queueCapacity?: number;
  /** On routers: full-queue behavior (sidecar-only; absent = 'stall'). */
  fullPolicy?: 'stall' | 'drop';
  /** On routers: per-attachment weight/priority, keyed by attached id. */
  attachmentPolicy?: Record<string, { weight?: number; priority?: number }>;
  /** On routers: latency-model member functions parsed from src/<R>.cpp. */
  latencyModels?: string[];
  /** On routers: ordered ingress forwarding rules (sidecar-only; merged
   *  host-side) — the authored truth of inter-composite dataflow. */
  rules?: ForwardingRule[];
  /** On composites: boundary fields from direct I/O pin children. */
  pins?: CompositePin[];
  /** On traffic-generator leaves (sidecar-only; merged host-side). */
  role?: 'trafficgen';
  /** On traffic generators: the generation parameters. */
  traffic?: {
    period: number;
    burst: number;
    count: number;
    start: number;
    pattern: string;
    addrLo?: string;
    addrHi?: string;
    addrPattern?: string;
  };
  /** On traffic generators: behavior ownership (absent = 'generated'). */
  trafficMode?: 'generated' | 'custom';
  language: Language;
  decl: SourceRange;
  handler?: SourceRange;
  outPorts: Port[];
  /** Event ids this component consumes in its handler. */
  consumes: string[];
  /** State variables ("name:type") — real C++ members on the class. */
  vars: string[];
}

export interface GraphEvent {
  id: string;
  fields: string[]; // "name:type"
  decl: SourceRange;
  /** Wire width in bits — derived host-side from the field types (or the
   *  authored override). What a router charges its bandwidth budget. */
  bits?: number;
  /** True when `bits` was authored rather than derived from the fields. */
  bitsOverridden?: boolean;
}

/**
 * wired      — explicit configureOut in the source (Tier 1, solid)
 * inferred   — unique consumer of the emitted message (Tier 2, dashed)
 * unresolved — emitted, multiple candidate consumers, no wiring (visible, red)
 * routed     — fabric-bound: the port is intentionally destination-less and
 *              enters its attachment router, whose forwarding rules resolve
 *              the destination per packet (merged host-side; `via` names the
 *              ingress router, `to` stays null)
 */
export type LinkStatus = 'wired' | 'inferred' | 'unresolved' | 'routed';

export interface GraphLink {
  /** `${from}.${fromPort}` — stable, one link per out-port. */
  id: string;
  from: string;
  fromPort: string;
  to: string | null; // null when status is 'unresolved' or 'routed'
  message: string;
  latency: number | null;
  status: LinkStatus;
  /** Fabric annotation: router path this wire's transport rides (merged
   *  host-side from the model; absent on intra-component wires). */
  via?: string[];
  /** Latency-model function name assigned to this routed wire. */
  latencyModel?: string;
  /** Cross-component wire with NO fabric route — an error (direct delivery
   *  between top-level units is not allowed); the reason, human-readable. */
  fabricError?: string;
}

/** Emitted-but-unconsumed message: dangles off the source block. */
export interface Stub {
  from: string;
  port: string;
  message: string;
  reason: string;
}

/** The fabric topology at the top canvas level: which components attach to
 *  which router, and the router↔router trunks. Deliberately NOT GraphLinks —
 *  attachments carry all messages, not one, and every wire-centric surface
 *  (level edges, connect forms, wire deletion) must stay uninvolved. */
export interface GraphFabric {
  attachments: Array<{ component: string; router: string }>;
  trunks: Array<{ a: string; b: string }>;
}

export interface Graph {
  components: GraphComponent[];
  events: GraphEvent[];
  links: GraphLink[];
  stubs: Stub[];
  /** Router topology (merged host-side from the model sidecar). */
  fabric?: GraphFabric;
  /** Derived inter-composite dataflow (from forwarding rules) — the canvas
   *  draws these as ghost edges; nothing about them is authored as a wire. */
  derived?: DerivedEdge[];
  /** Fabric diagnostics (errors block Run; warnings surface in PROBLEMS). */
  diagnostics?: FabricDiagnostic[];
}

export const EMPTY_GRAPH: Graph = { components: [], events: [], links: [], stubs: [] };
