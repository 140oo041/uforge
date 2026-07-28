// The SPEC — Layer 1 as a general architectural contract for the whole
// design: a multicore CPU, a GPU, an accelerator. ISA-neutral by design
// (COMMIT_RECORD_SCHEMA.md: arbitrary named state, arbitrary operations;
// RVFI/RV32I is one binding). Operations the oracle actually grades carry
// `oracle: true`; everything else is honestly "spec-only".

/** Suggested kinds for the UI — `kind` itself is free-form (any accelerator). */
export const SPEC_KIND_SUGGESTIONS = ['cpu', 'gpu', 'accelerator', 'dsp', 'npu', 'custom'];
export type SpecKind = string;

/** A named type alias usable throughout the design: `using name = base;`. */
export interface TypeDef {
  name: string;
  base: string;
}

/** A named signal enum usable throughout the design: `enum class name : underlying`. */
export interface SignalDef {
  name: string;
  underlying: string;
  values: string[];
}

/** A design-level external input/output carrying one event type. */
export interface IoPort {
  name: string;
  direction: 'in' | 'out';
  message: string;
}

export interface StateElement {
  name: string;
  label: string;
  bits: number;
  count?: number;
  /** State space in the commit record: reg | pc | mem | anything custom. */
  space?: string;
  /** Explicit C++/alias/signal type; when absent, derived from `bits`. */
  type?: string;
  /** Initializer expression, e.g. "0x80000000". */
  init?: string;
}

export interface Operation {
  mnemonic: string;
  /** Known RISC-V format (R/I/S/B/U/J) renders an encoding strip; free-form otherwise. */
  format?: string;
  summary: string;
  /** Optional longer semantics text (spec prose / pseudocode). */
  semantics?: string;
  /** true = the reference oracle (xverify) actually checks this operation. */
  oracle: boolean;
}

export interface SpecDocument {
  name: string;
  kind: SpecKind;
  xlen?: number;
  /** Multicore/multi-lane structure — mirrors the CommitRecord lane. */
  lanes?: { harts: number };
  /** Type aliases generated into the shared arch header. */
  types?: TypeDef[];
  /** Signal enums generated into the shared arch header. */
  signals?: SignalDef[];
  /** Design-level external interface, materialized as IO.* canvas nodes. */
  io?: IoPort[];
  state: StateElement[];
  operations: Operation[];
}

export type SpecEdit =
  | { kind: 'setMeta'; name?: string; specKind?: SpecKind; xlen?: number; harts?: number }
  | { kind: 'addState'; element: StateElement }
  | { kind: 'editState'; name: string; element: Partial<StateElement> }
  | { kind: 'removeState'; name: string }
  | { kind: 'addType'; type: TypeDef }
  | { kind: 'removeType'; name: string }
  | { kind: 'addSignal'; signal: SignalDef }
  | { kind: 'editSignal'; name: string; signal: Partial<SignalDef> }
  | { kind: 'removeSignal'; name: string }
  | { kind: 'addIo'; port: IoPort }
  | { kind: 'removeIo'; name: string }
  | { kind: 'addOp'; op: Operation }
  | { kind: 'removeOp'; mnemonic: string };

/** Builtin C++ types always offered in type pickers. */
export const BUILTIN_TYPES = [
  'uint8_t',
  'uint16_t',
  'uint32_t',
  'uint64_t',
  'int8_t',
  'int16_t',
  'int32_t',
  'int64_t',
  'bool',
  'float',
  'double',
];

/** All type names usable in the design: builtins ∪ spec aliases ∪ signal enums. */
export function availableTypes(spec: SpecDocument | null): string[] {
  if (!spec) return BUILTIN_TYPES;
  return [
    ...(spec.types ?? []).map((t) => t.name),
    ...(spec.signals ?? []).map((s) => s.name),
    ...BUILTIN_TYPES,
  ];
}

/** The C++ type a state element renders as: explicit `type` wins, else bits. */
export function stateType(el: StateElement): string {
  if (el.type) return el.type;
  if (el.bits <= 8) return 'uint8_t';
  if (el.bits <= 16) return 'uint16_t';
  if (el.bits <= 32) return 'uint32_t';
  return 'uint64_t';
}

/** RISC-V encoding fields per format, MSB→LSB, for the designer's bit strip. */
export const FORMAT_FIELDS: Record<string, Array<{ name: string; bits: number }>> = {
  R: [
    { name: 'funct7', bits: 7 },
    { name: 'rs2', bits: 5 },
    { name: 'rs1', bits: 5 },
    { name: 'funct3', bits: 3 },
    { name: 'rd', bits: 5 },
    { name: 'opcode', bits: 7 },
  ],
  I: [
    { name: 'imm[11:0]', bits: 12 },
    { name: 'rs1', bits: 5 },
    { name: 'funct3', bits: 3 },
    { name: 'rd', bits: 5 },
    { name: 'opcode', bits: 7 },
  ],
  S: [
    { name: 'imm[11:5]', bits: 7 },
    { name: 'rs2', bits: 5 },
    { name: 'rs1', bits: 5 },
    { name: 'funct3', bits: 3 },
    { name: 'imm[4:0]', bits: 5 },
    { name: 'opcode', bits: 7 },
  ],
  B: [
    { name: 'imm[12|10:5]', bits: 7 },
    { name: 'rs2', bits: 5 },
    { name: 'rs1', bits: 5 },
    { name: 'funct3', bits: 3 },
    { name: 'imm[4:1|11]', bits: 5 },
    { name: 'opcode', bits: 7 },
  ],
  U: [
    { name: 'imm[31:12]', bits: 20 },
    { name: 'rd', bits: 5 },
    { name: 'opcode', bits: 7 },
  ],
  J: [
    { name: 'imm[20|10:1|11|19:12]', bits: 20 },
    { name: 'rd', bits: 5 },
    { name: 'opcode', bits: 7 },
  ],
};

// ---------------------------------------------------------------------------
// Templates — starting points for a new spec.

/** The RV32I subset the xverify oracle contract covers (oracle-checked). */
export const TEMPLATE_RV32I: SpecDocument = {
  name: 'RISC-V RV32I CPU',
  kind: 'cpu',
  xlen: 32,
  lanes: { harts: 1 },
  types: [{ name: 'word', base: 'uint32_t' }],
  signals: [],
  io: [],
  state: [
    { name: 'x', label: 'General registers', bits: 32, count: 32, space: 'reg', type: 'word' },
    {
      name: 'pc',
      label: 'Program counter',
      bits: 32,
      space: 'pc',
      type: 'word',
      init: '0x80000000',
    },
  ],
  operations: [
    { mnemonic: 'addi', format: 'I', summary: 'rd = rs1 + imm', oracle: true },
    { mnemonic: 'add', format: 'R', summary: 'rd = rs1 + rs2', oracle: true },
    { mnemonic: 'sub', format: 'R', summary: 'rd = rs1 - rs2', oracle: true },
    { mnemonic: 'lui', format: 'U', summary: 'rd = imm << 12', oracle: true },
    { mnemonic: 'lw', format: 'I', summary: 'rd = mem[rs1 + imm]', oracle: true },
    { mnemonic: 'sw', format: 'S', summary: 'mem[rs1 + imm] = rs2', oracle: true },
    { mnemonic: 'beq', format: 'B', summary: 'if rs1 == rs2: pc += imm', oracle: true },
  ],
};

/** A SIMT-style GPU compute core — spec-only (no oracle binding yet). */
export const TEMPLATE_GPU: SpecDocument = {
  name: 'GPU compute core',
  kind: 'gpu',
  xlen: 32,
  lanes: { harts: 32 },
  types: [{ name: 'lane_mask', base: 'uint32_t' }],
  signals: [
    { name: 'WaveState', underlying: 'uint8_t', values: ['READY', 'RUNNING', 'STALLED', 'DONE'] },
  ],
  io: [],
  state: [
    { name: 'vgpr', label: 'Vector registers (per lane)', bits: 32, count: 256, space: 'reg' },
    { name: 'sgpr', label: 'Scalar registers', bits: 32, count: 104, space: 'reg' },
    { name: 'exec', label: 'Execution mask', bits: 32, space: 'reg' },
    { name: 'lds', label: 'Local data share', bits: 8, count: 65536, space: 'mem' },
    { name: 'pc', label: 'Wave program counter', bits: 48, space: 'pc' },
  ],
  operations: [
    { mnemonic: 'v_add', summary: 'vdst = vsrc0 + vsrc1 (per active lane)', oracle: false },
    { mnemonic: 'v_mul', summary: 'vdst = vsrc0 * vsrc1 (per active lane)', oracle: false },
    { mnemonic: 's_branch', summary: 'pc += imm (wave-uniform)', oracle: false },
    { mnemonic: 'ds_read', summary: 'vdst = lds[addr] (per active lane)', oracle: false },
    { mnemonic: 'ds_write', summary: 'lds[addr] = vsrc (per active lane)', oracle: false },
  ],
};

export const TEMPLATE_BLANK: SpecDocument = {
  name: 'Untitled architecture',
  kind: 'custom',
  types: [],
  signals: [],
  io: [],
  state: [],
  operations: [],
};

/** A generic streaming accelerator — shows the universal shape: types, signals, I/O. */
export const TEMPLATE_ACCEL: SpecDocument = {
  name: 'Generic accelerator',
  kind: 'accelerator',
  lanes: { harts: 1 },
  types: [{ name: 'word', base: 'uint32_t' }],
  signals: [
    { name: 'Phase', underlying: 'uint8_t', values: ['IDLE', 'LOAD', 'COMPUTE', 'DRAIN'] },
  ],
  // I/O is authored on the canvas now (Input/Output pin blocks), not here.
  io: [],
  state: [
    { name: 'phase', label: 'Pipeline phase', bits: 8, type: 'Phase', init: 'Phase::IDLE' },
    { name: 'processed', label: 'Items processed', bits: 32, type: 'word', init: '0' },
  ],
  operations: [],
};

export const SPEC_TEMPLATES: Array<{ id: string; label: string; spec: SpecDocument }> = [
  { id: 'rv32i', label: 'RISC-V RV32I CPU (oracle-backed)', spec: TEMPLATE_RV32I },
  { id: 'gpu', label: 'GPU compute core (spec-only)', spec: TEMPLATE_GPU },
  { id: 'accel', label: 'Generic accelerator (I/O + signals)', spec: TEMPLATE_ACCEL },
  { id: 'blank', label: 'Blank', spec: TEMPLATE_BLANK },
];

export function applySpecEdit(spec: SpecDocument, edit: SpecEdit): SpecDocument {
  switch (edit.kind) {
    case 'setMeta':
      return {
        ...spec,
        name: edit.name ?? spec.name,
        kind: edit.specKind ?? spec.kind,
        xlen: edit.xlen ?? spec.xlen,
        lanes: edit.harts !== undefined ? { harts: Math.max(1, edit.harts) } : spec.lanes,
      };
    case 'addState':
      return {
        ...spec,
        state: [...spec.state.filter((s) => s.name !== edit.element.name), edit.element],
      };
    case 'editState':
      return {
        ...spec,
        state: spec.state.map((s) => (s.name === edit.name ? { ...s, ...edit.element } : s)),
      };
    case 'removeState':
      return { ...spec, state: spec.state.filter((s) => s.name !== edit.name) };
    case 'addType':
      return {
        ...spec,
        types: [...(spec.types ?? []).filter((t) => t.name !== edit.type.name), edit.type],
      };
    case 'removeType':
      return { ...spec, types: (spec.types ?? []).filter((t) => t.name !== edit.name) };
    case 'addSignal':
      return {
        ...spec,
        signals: [
          ...(spec.signals ?? []).filter((s) => s.name !== edit.signal.name),
          edit.signal,
        ],
      };
    case 'editSignal':
      return {
        ...spec,
        signals: (spec.signals ?? []).map((s) =>
          s.name === edit.name ? { ...s, ...edit.signal } : s,
        ),
      };
    case 'removeSignal':
      return { ...spec, signals: (spec.signals ?? []).filter((s) => s.name !== edit.name) };
    case 'addIo':
      return {
        ...spec,
        io: [...(spec.io ?? []).filter((p) => p.name !== edit.port.name), edit.port],
      };
    case 'removeIo':
      return { ...spec, io: (spec.io ?? []).filter((p) => p.name !== edit.name) };
    case 'addOp':
      return {
        ...spec,
        operations: [
          ...spec.operations.filter((o) => o.mnemonic !== edit.op.mnemonic),
          edit.op,
        ],
      };
    case 'removeOp':
      return {
        ...spec,
        operations: spec.operations.filter((o) => o.mnemonic !== edit.mnemonic),
      };
  }
}

export function isSpecDocument(value: unknown): value is SpecDocument {
  const v = value as SpecDocument;
  return (
    !!v &&
    typeof v.name === 'string' &&
    typeof v.kind === 'string' &&
    Array.isArray(v.state) &&
    Array.isArray(v.operations)
  );
}
