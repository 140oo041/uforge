// The block library — the one list of things a user can add to a design.
//
// Both surfaces render this: the VS Code palette rail (a column of draggable
// cards) and the desktop app's ⌘K Library (searchable commands). They used to
// declare it separately and had already drifted — different order, different
// hint wording, and the app was missing nothing but could have been.
//
// `prefix` is an id prefix, not an id: the session mints Stage1, Stage2, … from
// it. Adding an entry here adds it to both hosts.

import type { ComponentKind, IoDirection } from '@iss/contracts/model';

export interface BlockTemplate {
  /** Id prefix — the session appends the next free number. */
  prefix: string;
  label: string;
  /** One line, shown under the label in the rail and as search text in ⌘K. */
  hint: string;
  glyph: string;
  kind: ComponentKind;
  io?: IoDirection;
  role?: 'trafficgen';
}

/**
 * Order is structural — containers, then fabric, then boundary, then leaves —
 * because the rail is read top to bottom by someone learning the vocabulary.
 * The ⌘K list is filtered by typing, so order matters far less there.
 */
export const TEMPLATES: BlockTemplate[] = [
  { prefix: 'Unit', label: 'Composite', hint: 'a container — CPU, GPU core, DMA engine, anything', glyph: '▣', kind: 'composite' },
  { prefix: 'R', label: 'Router', hint: 'top level only — fabric switch; attached components’ traffic rides router-to-router', glyph: '◈', kind: 'router' },
  { prefix: 'In', label: 'Input pin', hint: 'I/O block: receives from outside, forwards inward — shows on the composite boundary', glyph: '⇥', kind: 'leaf', io: 'in' },
  { prefix: 'Out', label: 'Output pin', hint: 'I/O block: collects from inside, sends outward — shows on the composite boundary', glyph: '↦', kind: 'leaf', io: 'out' },
  { prefix: 'Gen', label: 'Traffic generator', hint: 'parameterized packet source — rate, burst, destination pattern; no C++ needed', glyph: '⚡', kind: 'leaf', role: 'trafficgen' },
  { prefix: 'Block', label: 'Generic block', hint: 'a plain component — shape it later', glyph: '▢', kind: 'leaf' },
  { prefix: 'Stage', label: 'Pipeline stage', hint: 'consumes one event, emits the next', glyph: '▭', kind: 'leaf' },
  { prefix: 'Control', label: 'Control', hint: 'hazards, stalls, flushes', glyph: '⌘', kind: 'leaf' },
  { prefix: 'Memory', label: 'Memory', hint: 'loads/stores behind a port', glyph: '▤', kind: 'leaf' },
  { prefix: 'Buffer', label: 'Buffer / queue', hint: 'decouples producer and consumer', glyph: '☰', kind: 'leaf' },
  { prefix: 'Sink', label: 'Sink', hint: 'terminal consumer (commit, retire)', glyph: '⊥', kind: 'leaf' },
];
