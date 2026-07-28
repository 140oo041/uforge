// Properties panel for the current selection — a real shell region, not an
// overlay. Layout: a sticky identity header (glyph · name · kind chip · icon
// actions, delete isolated on the right) over collapsible cards, one card per
// concern. Router numerics render as a stat-tile strip; weighted attachments
// show their derived bandwidth share. Fold state persists per card id for the
// life of the webview. All edits go through the same EditIntent + undo pairs
// as before — this is a presentation rework, not a model change.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { Graph, GraphComponent } from '@iss/contracts/graph';
import type {
  AuthoredVar,
  EditIntent,
  ForwardingRule,
  ImplChoice,
  TrafficParams,
} from '@iss/contracts/model';
import { DEFAULT_BANDWIDTH_BITS, eventBits, formatBits } from '@iss/contracts/bits';
import { DEFAULT_TRAFFIC, parseAddr } from '@iss/contracts/model';
import { isTile } from '@iss/contracts/fabric';
import { availableTypes, type SpecDocument } from '@iss/contracts/spec';
import type { Authored, UndoEntry } from './app';
import type { Selection } from './canvas';
import { useTransport } from './transport';

interface Props {
  graph: Graph;
  authored: Authored;
  selection: Selection;
  /** Spec feeds the type pickers (aliases + signal enums + builtins). */
  spec: SpecDocument | null;
  onEdit(intent: EditIntent, undo?: UndoEntry): void;
  onReveal(id: string): void;
  onRevealEvent(id: string): void;
  onDelete(): void;
  /** Delete one wire by link id (undo-able; authored guard in the app). */
  onDeleteWire(linkId: string): void;
  onDrillIn(id: string): void;
  onDuplicate(id: string): void;
  /** Add a boundary I/O pin inside a composite without drilling in. */
  onAddPin(compositeId: string, io: 'in' | 'out'): void;
}

/* ---------- building blocks ---------- */

/** Card fold state, keyed by card id (not per component — folding "Trunks"
 *  once folds it for every router until the webview reloads). */
const foldState = new Map<string, boolean>();

function Card(props: {
  id: string;
  title: string;
  chip?: ReactNode;
  /** One sentence explaining what the card is for — hover on the ⓘ. */
  help?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { id, title, chip, help, defaultOpen = true, children } = props;
  return (
    <details
      id={`insp-${id}`}
      className="insp-card"
      open={foldState.get(id) ?? defaultOpen}
      onToggle={(e) => foldState.set(id, (e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="insp-chev">▶</span>
        <span className="insp-card-title">{title}</span>
        {help && (
          <span className="insp-help" title={help} aria-label={help}>
            ⓘ
          </span>
        )}
        {chip != null && <span className="badge insp-count">{chip}</span>}
      </summary>
      <div className="insp-card-body">{children}</div>
    </details>
  );
}

/**
 * What every field in this panel actually means, in one sentence each.
 *
 * Hover help is not decoration here: half of these names ("stubs", "consumes",
 * "weighted DRR", "latency model") are terms of art that a user meeting the
 * tool for the first time cannot guess, and the alternative — reading DESIGN.md
 * — is not available while dragging a wire. Keyed by a stable slug so the same
 * sentence is reused wherever the field appears.
 */
const HELP: Record<string, string> = {
  consumes:
    'Messages this block receives. Parsed from its handler — a typed handler parameter, a static_cast, or an ev.type() test. Incoming wires can only carry a message the destination consumes.',
  outports:
    'Every message this block sends. One out-port per wire drawn from it; a port with no destination either ends in a stub or enters the fabric to be routed by address.',
  vars: 'State that lives on the C++ class — real members, regenerated into the block source on every edit.',
  impl: 'Which body runs on Run: the C++ block, or its SystemVerilog twin verilated and co-simulated in its place.',
  divergence:
    'Run also executes the C++ block in shadow (its outputs never enter the design) and reports per-token output mismatches in PROBLEMS.',
  rules:
    'Ordered ingress rules. Each arriving packet takes the FIRST rule whose message type and address range both match; unmatched packets are dropped and reported.',
  traffic:
    'A packet source that needs no C++: it emits `burst` packets every `period` cycles, `count` times, starting at cycle `start`.',
  fabric:
    'Which router this block attaches to. Between top-level units there are no wires — the router forwards by rule, so a block must attach to reach anything outside its parent.',
  trunks: 'Router-to-router links. A packet may hop across several trunks before it reaches its destination.',
  arbitration:
    'Who wins when two packets contend for the same output port in one cycle: FIFO order, round-robin, static priority, or weighted deficit round-robin.',
  bandwidth: 'Packets each output port can forward per cycle. Excess packets queue.',
  queue:
    'Output-queue bound. When full, the router either stalls the sender (backpressure) or drops the packet and reports it.',
  latency: 'Cycles a message spends in flight on this wire before it is delivered.',
  latencyModel:
    'A C++ member function on the router that computes per-packet latency, instead of one fixed number.',
  stubs: 'Messages that are emitted but nothing consumes — a dangling output.',
  events: 'The message vocabulary of the design: the packet types blocks send to each other.',
  pins: 'A composite’s interface. In-pins forward inward; out-pins collect from inside and send outward.',
};

function IconBtn(props: {
  icon: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      className={`insp-iconbtn${props.danger ? ' danger' : ''}`}
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
    </button>
  );
}

function Hint(props: { error?: boolean; children: ReactNode }) {
  return (
    <p className={`insp-hint${props.error ? ' error' : ''}`}>
      <span className="i">{props.error ? '⛔' : 'ⓘ'}</span>
      <span>{props.children}</span>
    </p>
  );
}

function StatusChip(props: { status: string; count?: number }) {
  return (
    <span className={`insp-status ${props.status}`}>
      <span className="dot" />
      {props.count != null && <b>{props.count}</b>} {props.status}
    </span>
  );
}

/** Blur-committed number input (the panel-wide edit idiom). Keyed by id so a
 *  selection change remounts it and defaultValue can't go stale. */
function NumberField(props: {
  id: string;
  value: number | null;
  min: number;
  nullable?: boolean;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  className?: string;
  onCommit(next: number | null): void;
}) {
  return (
    <input
      key={props.id}
      className={props.className}
      type="number"
      min={props.min}
      placeholder={props.placeholder}
      defaultValue={props.value ?? ''}
      disabled={props.disabled}
      title={props.title}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        const next =
          raw === '' && props.nullable
            ? null
            : Math.max(props.min, Math.floor(Number(raw) || props.min));
        if (next === props.value) return;
        props.onCommit(next);
      }}
    />
  );
}

function Tile(props: {
  label: string;
  unit?: string;
  wide?: boolean;
  /** Hovering the LABEL should explain the field, not just the input — the
   *  label is what the eye lands on when scanning a strip of tiles. */
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className={`insp-tile${props.wide ? ' wide' : ''}`}>
      <span className="insp-tile-lab" title={props.help}>
        {props.label}
      </span>
      <span className="insp-tile-val">
        {props.children}
        {props.unit && <small>{props.unit}</small>}
      </span>
    </div>
  );
}

function ToggleRow(props: {
  glyph?: string;
  label: string;
  title?: string;
  checked: boolean;
  disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className="insp-item insp-togrow" title={props.title}>
      {props.glyph && <span className="insp-avatar router">{props.glyph}</span>}
      <span className="insp-id">{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="insp-toggle" aria-hidden="true" />
    </label>
  );
}

function Head(props: {
  glyph: string;
  glyphClass?: string;
  title: ReactNode;
  chip?: ReactNode;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="insp-head">
      <div className="insp-head-row">
        <div className={`insp-glyph ${props.glyphClass ?? ''}`}>{props.glyph}</div>
        <div className="insp-title">
          {props.title}
          {props.chip}
        </div>
      </div>
      {props.sub && (
        <div className="insp-sub" title={props.sub}>
          {props.sub}
        </div>
      )}
      {props.actions && <div className="insp-actionrow">{props.actions}</div>}
    </div>
  );
}

/** Blur-committed address input (0x-hex or decimal; empty = open bound).
 *  Invalid input reverts to the last good value instead of committing. */
function AddrField(props: {
  id: string;
  value: string | undefined;
  placeholder: string;
  disabled?: boolean;
  title?: string;
  onCommit(next: string | undefined): void;
}) {
  return (
    <input
      key={props.id}
      className="insp-num insp-addr"
      placeholder={props.placeholder}
      defaultValue={props.value ?? ''}
      disabled={props.disabled}
      title={props.title}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        if (raw === '') {
          if (props.value !== undefined) props.onCommit(undefined);
          return;
        }
        if (parseAddr(raw) === null) {
          e.target.value = props.value ?? '';
          return;
        }
        if (raw !== props.value) props.onCommit(raw);
      }}
    />
  );
}

/* ---------- section cards ---------- */

/** Ordered forwarding rules — the authored truth of inter-composite dataflow.
 *  First match on (message, address) at this router stamps the destination;
 *  unmatched packets drop + report. */
function RulesCard(props: {
  comp: GraphComponent;
  graph: Graph;
  onEdit(intent: EditIntent, undo?: UndoEntry): void;
}) {
  const { comp, graph, onEdit } = props;
  const rules = comp.rules ?? [];
  const dests = graph.components
    .filter(isTile)
    .sort((a, b) => a.id.localeCompare(b.id));
  const models = comp.latencyModels ?? [];
  const ruleDiagnostics = (graph.diagnostics ?? []).filter((d) => d.router === comp.id);

  const update = (index: number, rule: ForwardingRule) => {
    const prev = rules[index];
    onEdit(
      { kind: 'updateForwardingRule', router: comp.id, index, rule },
      {
        undo: () => onEdit({ kind: 'updateForwardingRule', router: comp.id, index, rule: prev }),
        redo: () => onEdit({ kind: 'updateForwardingRule', router: comp.id, index, rule }),
      },
    );
  };
  const remove = (index: number) => {
    const prev = rules[index];
    onEdit(
      { kind: 'removeForwardingRule', router: comp.id, index },
      {
        undo: () => onEdit({ kind: 'addForwardingRule', router: comp.id, rule: prev, index }),
        redo: () => onEdit({ kind: 'removeForwardingRule', router: comp.id, index }),
      },
    );
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rules.length) return;
    onEdit(
      { kind: 'moveForwardingRule', router: comp.id, from, to },
      {
        undo: () => onEdit({ kind: 'moveForwardingRule', router: comp.id, from: to, to: from }),
        redo: () => onEdit({ kind: 'moveForwardingRule', router: comp.id, from, to }),
      },
    );
  };
  const add = () => {
    if (dests.length === 0) return;
    const rule: ForwardingRule = { to: dests[0].id };
    const index = rules.length;
    onEdit(
      { kind: 'addForwardingRule', router: comp.id, rule },
      {
        undo: () => onEdit({ kind: 'removeForwardingRule', router: comp.id, index }),
        redo: () => onEdit({ kind: 'addForwardingRule', router: comp.id, rule, index }),
      },
    );
  };
  const commitAddr = (index: number, key: 'addrLo' | 'addrHi', next: string | undefined) => {
    const rule = { ...rules[index] };
    if (next === undefined) delete rule[key];
    else rule[key] = next;
    // Client-side lo<=hi guard; the reducer canonicalizes the hex.
    const lo = rule.addrLo !== undefined ? parseAddr(rule.addrLo) : null;
    const hi = rule.addrHi !== undefined ? parseAddr(rule.addrHi) : null;
    if (lo !== null && hi !== null && lo > hi) return;
    update(index, rule);
  };

  return (
    <Card id="router-rules" title="Forwarding rules" chip={rules.length} help={HELP.rules}>
      {rules.length === 0 && (
        <Hint>
          no rules — every packet entering {comp.label} without a destination is dropped and
          reported. First match wins; order with ↑ ↓.
        </Hint>
      )}
      {rules.map((rule, index) => (
        <div key={index} className="insp-rule">
          <div className="insp-item">
            <span className="insp-ruleno" title={`rule ${index + 1} — first match wins`}>
              {index + 1}
            </span>
            <select
              value={rule.message ?? ''}
              title="message type to match; (any) matches every type"
              onChange={(e) => {
                const next = { ...rule };
                if (e.target.value === '') delete next.message;
                else next.message = e.target.value;
                update(index, next);
              }}
            >
              <option value="">(any)</option>
              {graph.events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.id}
                </option>
              ))}
            </select>
            <span className="insp-rulearrow">→</span>
            <select
              value={rule.to}
              title="destination top-level component"
              onChange={(e) => update(index, { ...rule, to: e.target.value })}
            >
              {!dests.some((d) => d.id === rule.to) && (
                <option value={rule.to}>⚠ {rule.to}</option>
              )}
              {dests.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id}
                </option>
              ))}
            </select>
          </div>
          <div className="insp-item insp-rule-detail">
            <AddrField
              id={`${comp.id}:${index}:lo:${rule.addrLo ?? ''}`}
              value={rule.addrLo}
              placeholder="0x0"
              title="inclusive lower address bound; empty = 0"
              onCommit={(next) => commitAddr(index, 'addrLo', next)}
            />
            <span className="insp-rulearrow">..</span>
            <AddrField
              id={`${comp.id}:${index}:hi:${rule.addrHi ?? ''}`}
              value={rule.addrHi}
              placeholder="max"
              title="inclusive upper address bound; empty = 2^64-1"
              onCommit={(next) => commitAddr(index, 'addrHi', next)}
            />
            {models.length > 0 && (
              <select
                value={rule.latencyModel ?? ''}
                title="hop-latency model applied along this rule's route"
                onChange={(e) => {
                  const next = { ...rule };
                  if (e.target.value === '') delete next.latencyModel;
                  else next.latencyModel = e.target.value;
                  update(index, next);
                }}
              >
                <option value="">flat</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    ƒ {m}
                  </option>
                ))}
              </select>
            )}
            <span className="insp-rule-spacer" />
            <IconBtn
              icon="↑"
              label="match earlier"
              disabled={index === 0}
              onClick={() => move(index, index - 1)}
            />
            <IconBtn
              icon="↓"
              label="match later"
              disabled={index === rules.length - 1}
              onClick={() => move(index, index + 1)}
            />
            <IconBtn icon="✕" label={`remove rule ${index + 1}`} danger onClick={() => remove(index)} />
          </div>
          {ruleDiagnostics
            .filter((d) => d.ruleIndex === index)
            .map((d, i) => (
              <Hint key={i} error={d.severity === 'error'}>
                {d.detail}
              </Hint>
            ))}
        </div>
      ))}
      <div className="insp-btnrow">
        <button
          disabled={dests.length === 0}
          title={
            dests.length === 0
              ? 'no top-level components to route to yet'
              : 'append a rule (matches last)'
          }
          onClick={add}
        >
          + Add rule
        </button>
      </div>
    </Card>
  );
}

/** Traffic-generator card: generation params as a tile strip. In 'generated'
 *  mode every edit regenerates the block's tick(); in 'custom' mode the tick()
 *  below the file's END marker is hand-owned, params are inert, and the only
 *  way back is the destructive "Regenerate from params". */
function TrafficCard(props: {
  comp: GraphComponent;
  editable: boolean;
  onEdit(intent: EditIntent, undo?: UndoEntry): void;
  onReveal(id: string): void;
}) {
  const { comp, editable, onEdit } = props;
  const traffic: TrafficParams = { ...DEFAULT_TRAFFIC, ...(comp.traffic ?? {}) } as TrafficParams;
  const mode = comp.trafficMode ?? 'generated';
  const detached = mode === 'custom';

  const setTraffic = (next: TrafficParams) =>
    onEdit(
      { kind: 'setTraffic', id: comp.id, traffic: next },
      {
        undo: () => onEdit({ kind: 'setTraffic', id: comp.id, traffic }),
        redo: () => onEdit({ kind: 'setTraffic', id: comp.id, traffic: next }),
      },
    );
  const tile = (
    key: 'period' | 'burst' | 'count' | 'start',
    label: string,
    min: number,
    unit: string,
    title: string,
  ) => (
    <Tile label={label} unit={unit} help={title}>
      <NumberField
        id={`${comp.id}:${key}`}
        className="insp-tile-in"
        value={traffic[key]}
        min={min}
        disabled={!editable || detached}
        title={title}
        onCommit={(next) => setTraffic({ ...traffic, [key]: next as number })}
      />
    </Tile>
  );

  return (
    <Card id="traffic" title="Traffic" chip={detached ? 'custom' : 'generated'} help={HELP.traffic}>
      {detached && (
        <Hint>
          detached — <code>tick()</code> below the markers is hand-owned; these params are inert
          until you regenerate.
        </Hint>
      )}
      <div className="insp-tiles">
        {tile('period', 'period', 1, 'cy', 'cycles between bursts')}
        {tile('burst', 'burst', 1, 'pkt', 'packets per burst')}
        {tile('count', 'count', 0, 'pkt', 'total packets; 0 = unlimited until clock stop')}
        {tile('start', 'start', 0, 'cy', 'first generation cycle')}
      </div>
      <div className="insp-crow">
        <span className="insp-k">pattern</span>
        <select
          value={traffic.pattern}
          disabled={!editable || detached}
          title="destination pick among this block's wired out-ports, per packet"
          onChange={(e) =>
            setTraffic({ ...traffic, pattern: e.target.value as TrafficParams['pattern'] })
          }
        >
          <option value="fixed">fixed (first port)</option>
          <option value="roundrobin">round-robin</option>
          <option value="random">random</option>
        </select>
      </div>
      <div className="insp-crow">
        <span className="insp-k">addresses</span>
        <select
          value={traffic.addrPattern ?? 'off'}
          disabled={!editable || detached}
          title="per-packet ev->addr within [lo, hi] — router rules match on it"
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'off') {
              const next = { ...traffic };
              delete next.addrLo;
              delete next.addrHi;
              delete next.addrPattern;
              setTraffic(next);
            } else {
              setTraffic({
                ...traffic,
                addrLo: traffic.addrLo ?? '0x0',
                addrHi: traffic.addrHi ?? '0xffff',
                addrPattern: value as 'random' | 'sequential',
              });
            }
          }}
        >
          <option value="off">off (addr = 0)</option>
          <option value="random">random in range</option>
          <option value="sequential">sequential in range</option>
        </select>
      </div>
      {traffic.addrPattern !== undefined && (
        <div className="insp-crow">
          <span className="insp-k">addr range</span>
          <AddrField
            id={`${comp.id}:addrLo:${traffic.addrLo ?? ''}`}
            value={traffic.addrLo}
            placeholder="0x0"
            disabled={!editable || detached}
            title="inclusive lower bound (0x-hex)"
            onCommit={(next) => setTraffic({ ...traffic, addrLo: next ?? '0x0' })}
          />
          <span className="insp-rulearrow">..</span>
          <AddrField
            id={`${comp.id}:addrHi:${traffic.addrHi ?? ''}`}
            value={traffic.addrHi}
            placeholder="0xffff"
            disabled={!editable || detached}
            title="inclusive upper bound (0x-hex)"
            onCommit={(next) => setTraffic({ ...traffic, addrHi: next ?? '0xffff' })}
          />
        </div>
      )}
      <div className="insp-btnrow">
        {!detached ? (
          <button
            disabled={!editable}
            title="switch tick() to hand-owned code below the markers — seeded with the current generated behavior"
            onClick={() => {
              onEdit(
                { kind: 'setTrafficMode', id: comp.id, mode: 'custom' },
                {
                  undo: () => onEdit({ kind: 'setTrafficMode', id: comp.id, mode: 'generated' }),
                  redo: () => onEdit({ kind: 'setTrafficMode', id: comp.id, mode: 'custom' }),
                },
              );
              props.onReveal(comp.id);
            }}
          >
            Detach to custom code
          </button>
        ) : (
          <button
            className="danger"
            disabled={!editable}
            title="OVERWRITES the hand-owned tick() with code generated from the params above"
            onClick={() => onEdit({ kind: 'setTrafficMode', id: comp.id, mode: 'generated' })}
          >
            Regenerate from params
          </button>
        )}
      </div>
    </Card>
  );
}

/** Fabric attachment card — top-level components only, and only when the
 *  design has routers. Attaching both endpoints of a cross-component wire
 *  makes its transport ride the fabric (see the ⇢ via badge on the wire). */
function FabricCard(props: {
  comp: GraphComponent;
  graph: Graph;
  onEdit(intent: EditIntent, undo?: UndoEntry): void;
}) {
  const { comp, graph, onEdit } = props;
  const routers = graph.components
    .filter((c) => c.kind === 'router')
    .sort((a, b) => a.id.localeCompare(b.id));
  if (comp.parent !== null || comp.kind === 'router' || routers.length === 0) return null;
  const attachedTo = new Set(
    (graph.fabric?.attachments ?? [])
      .filter((a) => a.component === comp.id)
      .map((a) => a.router),
  );
  const toggle = (router: string, attach: boolean) => {
    onEdit(
      { kind: 'attachRouter', id: comp.id, router, attach },
      {
        undo: () => onEdit({ kind: 'attachRouter', id: comp.id, router, attach: !attach }),
        redo: () => onEdit({ kind: 'attachRouter', id: comp.id, router, attach }),
      },
    );
  };
  return (
    <Card id="fabric" title="Fabric" chip={`${attachedTo.size}/${routers.length}`} help={HELP.fabric}>
      {routers.map((r) => (
        <ToggleRow
          key={r.id}
          glyph="◈"
          label={r.label}
          title={`attach ${comp.label} to ${r.label}`}
          checked={attachedTo.has(r.id)}
          onChange={(next) => toggle(r.id, next)}
        />
      ))}
      <Hint>
        A cross-component wire whose endpoints are both attached rides the shortest trunk path
        between them.
      </Hint>
    </Card>
  );
}

/** graph vars ("name:type") → editable AuthoredVar rows (init unknown from
 *  the read-model; edits re-emit the whole set, defaulting init to null). */
function toVarRows(vars: string[]): AuthoredVar[] {
  return vars.map((v) => {
    const idx = v.indexOf(':');
    return { name: v.slice(0, idx), type: v.slice(idx + 1), init: null };
  });
}

function VarsCard(props: {
  compId: string;
  vars: string[];
  editable: boolean;
  typeOptions: string[];
  onEdit(intent: EditIntent, undo?: UndoEntry): void;
}) {
  const { compId, vars, editable, typeOptions, onEdit } = props;
  const [name, setName] = useState('');
  const [type, setType] = useState('uint32_t');
  const [init, setInit] = useState('');

  const commit = (next: AuthoredVar[]) => {
    const prev = toVarRows(vars);
    onEdit(
      { kind: 'setVars', id: compId, vars: next },
      {
        undo: () => onEdit({ kind: 'setVars', id: compId, vars: prev }),
        redo: () => onEdit({ kind: 'setVars', id: compId, vars: next }),
      },
    );
  };

  const add = () => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    commit([...toVarRows(vars), { name, type: type.trim() || 'uint32_t', init: init || null }]);
    setName('');
    setInit('');
  };

  return (
    <Card id="vars" title="Variables" chip={vars.length} help={HELP.vars}>
      {vars.length === 0 && <Hint>none — block-owned state (pc, regs, …)</Hint>}
      {vars.map((v) => {
        const idx = v.indexOf(':');
        const varName = v.slice(0, idx);
        const varType = v.slice(idx + 1);
        return (
          <div key={v} className="insp-item">
            <span className="insp-id ins-var">{varName}</span>
            <span className="ins-vartype">{varType}</span>
            {editable && (
              <IconBtn
                icon="✕"
                label={`remove ${varName}`}
                danger
                onClick={() => commit(toVarRows(vars).filter((row) => row.name !== varName))}
              />
            )}
          </div>
        );
      })}
      {editable && (
        <>
          <div className="isa-add">
            <input
              placeholder="name (e.g. pc)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="ins-typein"
              placeholder="type"
              value={type}
              list="iss2-var-types"
              onChange={(e) => setType(e.target.value)}
            />
            <datalist id="iss2-var-types">
              {typeOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div className="isa-add">
            <input
              placeholder="init (optional, e.g. 0x80000000)"
              value={init}
              onChange={(e) => setInit(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)} onClick={add}>
              ＋
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

/** Wire width of the packet a port carries. The host derives it into the
 *  graph; the fallback keeps the panel honest against an older trace. */
function bitsOf(graph: Graph, message: string | null | undefined): number | null {
  if (!message) return null;
  const event = graph.events.find((e) => e.id === message);
  if (!event) return null;
  return event.bits ?? eventBits({ fields: event.fields });
}

function BitsChip({ bits }: { bits: number | null }) {
  if (bits === null) return null;
  return (
    <span
      className="insp-bits"
      title={`${bits} bits on the wire — what this packet charges a router's bandwidth budget`}
    >
      {formatBits(bits)}
    </span>
  );
}

/**
 * IN-PORTS — the half of a block's interface that had no home.
 *
 * `consumes` used to be one grey row at the bottom of the Out-ports card, which
 * said the quiet part out loud: outputs were first-class and inputs were a
 * footnote. They are the same kind of fact. This card gives each consumed
 * message the same treatment an out-port gets — who sends it, what it carries,
 * and (for authored blocks) the ability to add or drop one — because "what can
 * reach this block" is the first question anyone asks of a leaf.
 *
 * Senders are collected from three places, since a message can arrive by wire,
 * by fabric rule, or through a parent's in-pin.
 */
function InputsCard(props: {
  comp: GraphComponent;
  graph: Graph;
  editable: boolean;
  onEdit(intent: EditIntent, undo?: UndoEntry): void;
  onReveal(id: string): void;
  onRevealEvent(id: string): void;
}) {
  const { comp, graph, editable, onEdit, onReveal, onRevealEvent } = props;
  const [picked, setPicked] = useState('');

  const commit = (next: string[]) => {
    const prev = comp.consumes;
    onEdit(
      { kind: 'setConsumes', id: comp.id, consumes: next },
      {
        undo: () => onEdit({ kind: 'setConsumes', id: comp.id, consumes: prev }),
        redo: () => onEdit({ kind: 'setConsumes', id: comp.id, consumes: next }),
      },
    );
  };

  /** Every way `message` can arrive at this block, as human-readable origins. */
  const sendersOf = (message: string): Array<{ id: string; how: string }> => {
    const out: Array<{ id: string; how: string }> = [];
    for (const l of graph.links)
      if (l.to === comp.id && l.message === message)
        out.push({ id: l.from, how: l.status === 'inferred' ? 'inferred wire' : 'wire' });
    // Fabric: a routed port whose rules name this block's top-level unit.
    const top = comp.id.includes('.') ? comp.id.slice(0, comp.id.indexOf('.')) : comp.id;
    for (const edge of graph.derived ?? [])
      if (edge.toTop === top && (edge.message === null || edge.message === message))
        out.push({ id: edge.fromTop, how: `rule on ${edge.router}` });
    return out;
  };

  const candidates = graph.events.filter((e) => !comp.consumes.includes(e.id));

  return (
    <Card id="inputs" title="In-ports" chip={comp.consumes.length} help={HELP.consumes}>
      {comp.consumes.length === 0 && (
        <Hint>
          consumes nothing — nothing can be wired into this block until its handler takes a message
        </Hint>
      )}
      {comp.consumes.map((message) => {
        const fields = graph.events.find((e) => e.id === message)?.fields ?? [];
        const senders = sendersOf(message);
        return (
          <div key={message} className="insp-port">
            <div className="insp-item">
              <span className="insp-portname" title={`open ${message}`}>
                <a className="message-link" onClick={() => onRevealEvent(message)}>
                  {message}
                </a>
              </span>
              <BitsChip bits={bitsOf(graph, message)} />
              <span
                className="insp-ellip"
                title={
                  senders.length
                    ? senders.map((s) => `${s.id} (${s.how})`).join(', ')
                    : 'nothing sends this message to this block yet'
                }
              >
                {senders.length === 0 ? (
                  <span className="insp-orphan">← no sender</span>
                ) : (
                  senders.map((s, i) => (
                    <span key={`${s.id}-${i}`}>
                      {i > 0 && ', '}←{' '}
                      <a className="message-link" onClick={() => onReveal(s.id)}>
                        {s.id}
                      </a>
                    </span>
                  ))
                )}
              </span>
              {editable && (
                <IconBtn
                  icon="✕"
                  label={`stop consuming ${message}`}
                  danger
                  onClick={() => commit(comp.consumes.filter((m) => m !== message))}
                />
              )}
            </div>
            {fields.length > 0 && (
              <details className="ins-fields">
                <summary>
                  {fields.length} variable{fields.length === 1 ? '' : 's'}
                </summary>
                {fields.map((f) => {
                  const idx = f.indexOf(':');
                  return (
                    <div key={f} className="ins-row ins-field-row">
                      <span className="ins-key ins-var">{f.slice(0, idx)}</span>
                      <span className="ins-vartype">{f.slice(idx + 1)}</span>
                    </div>
                  );
                })}
              </details>
            )}
          </div>
        );
      })}
      {editable && candidates.length > 0 && (
        <div className="isa-add">
          <select
            value={picked}
            title="add a message this block's handler will receive"
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="">consume a message…</option>
            {candidates.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id}
              </option>
            ))}
          </select>
          <button
            disabled={!picked}
            title="add to this block's handler"
            onClick={() => {
              if (!picked) return;
              commit([...comp.consumes, picked]);
              setPicked('');
            }}
          >
            ＋
          </button>
        </div>
      )}
    </Card>
  );
}

/* ---------- panel ---------- */

export function Inspector({
  graph,
  authored,
  selection,
  spec,
  onEdit,
  onReveal,
  onRevealEvent,
  onDelete,
  onDeleteWire,
  onDrillIn,
  onDuplicate,
  onAddPin,
}: Props) {
  const { post } = useTransport();
  const selectedId = selection.nodes.size === 1 ? [...selection.nodes][0] : null;
  const comp = selectedId ? graph.components.find((c) => c.id === selectedId) : null;
  const wire = selection.wire ? graph.links.find((l) => l.id === selection.wire) : null;

  const [label, setLabel] = useState(comp?.label ?? '');
  useEffect(() => setLabel(comp?.label ?? ''), [comp?.id, comp?.label]);

  if (wire) {
    const editable = authored.components.has(wire.from);
    return (
      <div className="inspector">
        <Head
          glyph="⇢"
          glyphClass="wire"
          title={
            <span className="name">
              {wire.from.split('.').pop()}.{wire.fromPort}
            </span>
          }
          chip={<StatusChip status={wire.status} />}
          sub={`${wire.from}.${wire.fromPort} → ${wire.to ?? '∅ (unresolved)'}`}
          actions={
            editable ? (
              <>
                <span className="spacer" />
                <IconBtn icon="🗑" label="Delete wire" danger onClick={onDelete} />
              </>
            ) : undefined
          }
        />
        <Card id="wire-route" title="Route">
          <div className="insp-crow">
            <span className="insp-k">message</span>
            {wire.message ? (
              <a
                className="message-link"
                title={`open ${wire.message}`}
                onClick={() => onRevealEvent(wire.message)}
              >
                {wire.message}
              </a>
            ) : (
              <span>—</span>
            )}
          </div>
          <div className="insp-crow">
            <span className="insp-k">to</span>
            <span className="insp-ellip" title={wire.to ?? '∅ (unresolved)'}>
              {wire.to ?? '∅ (unresolved)'}
            </span>
          </div>
          {wire.fabricError && (
            <Hint error>
              {wire.fabricError} — cross-component traffic must ride a router; Run is blocked
              until this wire has a fabric route.
            </Hint>
          )}
          {!editable && <Hint>Source block is hand-written — edit its C++ directly.</Hint>}
        </Card>
        <Card id="wire-transport" title="Transport" chip={`${wire.latency ?? 1} cy`} help={HELP.latency}>
          <div className="insp-tiles">
            <Tile label="wire latency" unit="cy" help={HELP.latency}>
              <NumberField
                id={`${wire.id}:latency`}
                className="insp-tile-in"
                value={wire.latency ?? 1}
                min={0}
                disabled={!editable}
                onCommit={(next) => {
                  const latency = next as number;
                  const prev = wire.latency;
                  onEdit(
                    { kind: 'setLatency', from: wire.from, port: wire.fromPort, latency },
                    {
                      undo: () =>
                        onEdit({
                          kind: 'setLatency',
                          from: wire.from,
                          port: wire.fromPort,
                          latency: prev,
                        }),
                      redo: () =>
                        onEdit({ kind: 'setLatency', from: wire.from, port: wire.fromPort, latency }),
                    },
                  );
                }}
              />
            </Tile>
          </div>
          {wire.via && (
            <>
              <div className="insp-crow">
                <span className="insp-k">via</span>
                <span className="insp-ellip" title={`enters the fabric at ${wire.via.join(' → ')}`}>
                  ⇢ {wire.via.join(' → ')}
                </span>
              </div>
              <Hint>
                Destination and hop latency are owned by the ingress router's forwarding rules —
                edit them on ◈ {wire.via[0]}.
              </Hint>
            </>
          )}
        </Card>
      </div>
    );
  }

  if (comp && comp.kind === 'router') {
    const attached = (graph.fabric?.attachments ?? []).filter((a) => a.router === comp.id);
    const otherRouters = graph.components
      .filter((c) => c.kind === 'router' && c.id !== comp.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const trunked = new Set(
      (graph.fabric?.trunks ?? [])
        .filter((t) => t.a === comp.id || t.b === comp.id)
        .map((t) => (t.a === comp.id ? t.b : t.a)),
    );
    const latency = comp.routerLatency ?? 1;
    const arbitration = comp.arbitration ?? 'fifo';
    const bandwidth = comp.portBandwidthBits ?? DEFAULT_BANDWIDTH_BITS;
    const capacity = comp.queueCapacity ?? null;
    const fullPolicy = comp.fullPolicy ?? 'stall';
    const policies = comp.attachmentPolicy ?? {};
    const models = comp.latencyModels ?? [];
    const totalWeight = attached.reduce(
      (sum, a) => sum + (policies[a.component]?.weight ?? 1),
      0,
    );
    const modelUse = (m: string) =>
      graph.links.filter((l) => l.latencyModel === m && (l.via ?? []).includes(comp.id)).length;
    const setQueue = (nextCapacity: number | null, nextPolicy?: 'stall' | 'drop') =>
      onEdit(
        { kind: 'setRouterQueue', id: comp.id, capacity: nextCapacity, fullPolicy: nextPolicy },
        {
          undo: () =>
            onEdit({
              kind: 'setRouterQueue',
              id: comp.id,
              capacity,
              fullPolicy: capacity === null ? undefined : fullPolicy,
            }),
          redo: () =>
            onEdit({
              kind: 'setRouterQueue',
              id: comp.id,
              capacity: nextCapacity,
              fullPolicy: nextPolicy,
            }),
        },
      );
    const setWeight = (component: string, next: number) => {
      const prev = policies[component]?.weight ?? 1;
      if (next < 1 || next === prev) return;
      onEdit(
        { kind: 'setAttachmentPolicy', router: comp.id, component, weight: next },
        {
          undo: () =>
            onEdit({ kind: 'setAttachmentPolicy', router: comp.id, component, weight: prev }),
          redo: () =>
            onEdit({ kind: 'setAttachmentPolicy', router: comp.id, component, weight: next }),
        },
      );
    };
    return (
      <div className="inspector">
        <Head
          glyph="◈"
          glyphClass="router"
          title={<span className="name">{comp.label}</span>}
          chip={<span className="badge">router</span>}
          sub={`${attached.length} attached · ${trunked.size} trunk${trunked.size === 1 ? '' : 's'} · ${latency} cy/hop`}
          actions={
            <>
              <IconBtn icon="⧉" label={`open src/${comp.id}.cpp`} onClick={() => onReveal(comp.id)} />
              <span className="spacer" />
              <IconBtn icon="🗑" label="Delete router" danger onClick={onDelete} />
            </>
          }
        />

        <Card id="router-forwarding" title="Forwarding" chip={`${latency} cy`} help={HELP.arbitration}>
          <div className="insp-tiles">
            <Tile label="hop latency" unit="cy" help="Cycles a packet spends in this router on every forwarding hop.">
              <NumberField
                id={`${comp.id}:latency`}
                className="insp-tile-in"
                value={latency}
                min={0}
                title="cycles per forwarding hop through this router"
                onCommit={(nextVal) => {
                  const next = nextVal as number;
                  onEdit(
                    { kind: 'setRouterLatency', id: comp.id, latency: next },
                    {
                      undo: () => onEdit({ kind: 'setRouterLatency', id: comp.id, latency }),
                      redo: () => onEdit({ kind: 'setRouterLatency', id: comp.id, latency: next }),
                    },
                  );
                }}
              />
            </Tile>
            <Tile label="bandwidth" unit="b/cy" help={HELP.bandwidth}>
              <NumberField
                id={`${comp.id}:bandwidth`}
                className="insp-tile-in"
                value={bandwidth}
                min={1}
                title="bits forwarded per output port per cycle — a packet costs its own width, so wide payloads occupy the port for several cycles"
                onCommit={(nextVal) => {
                  const next = nextVal as number;
                  onEdit(
                    { kind: 'setRouterBandwidth', id: comp.id, bandwidthBits: next },
                    {
                      undo: () =>
                        onEdit({
                          kind: 'setRouterBandwidth',
                          id: comp.id,
                          bandwidthBits: bandwidth,
                        }),
                      redo: () =>
                        onEdit({ kind: 'setRouterBandwidth', id: comp.id, bandwidthBits: next }),
                    },
                  );
                }}
              />
            </Tile>
            <Tile label="queue / port" unit="pkt" help={HELP.queue}>
              <NumberField
                id={`${comp.id}:queue`}
                className="insp-tile-in"
                value={capacity}
                min={1}
                nullable
                placeholder="∞"
                title="max packets parked per output port — empty = unbounded"
                onCommit={(next) => setQueue(next, next === null ? undefined : fullPolicy)}
              />
            </Tile>
            <Tile label="arbitration" help={HELP.arbitration}>
              <select
                className="insp-tile-sel"
                value={arbitration}
                title="how contended output ports pick the next packet"
                onChange={(e) => {
                  const next = e.target.value as 'fifo' | 'roundrobin' | 'priority' | 'weighted';
                  onEdit(
                    { kind: 'setRouterArbitration', id: comp.id, policy: next },
                    {
                      undo: () =>
                        onEdit({ kind: 'setRouterArbitration', id: comp.id, policy: arbitration }),
                      redo: () => onEdit({ kind: 'setRouterArbitration', id: comp.id, policy: next }),
                    },
                  );
                }}
              >
                <option value="fifo">fifo</option>
                <option value="roundrobin">round-robin</option>
                <option value="priority">priority</option>
                <option value="weighted">weighted</option>
              </select>
            </Tile>
            {capacity !== null && (
              <Tile label="when queue full" wide help={HELP.queue}>
                <div
                  className="insp-seg"
                  title="stall: the packet waits on the wire and retries; drop: discard and report"
                >
                  <button
                    className={fullPolicy === 'stall' ? 'on' : ''}
                    onClick={() => fullPolicy !== 'stall' && setQueue(capacity, 'stall')}
                  >
                    stall
                  </button>
                  <button
                    className={fullPolicy === 'drop' ? 'on' : ''}
                    onClick={() => fullPolicy !== 'drop' && setQueue(capacity, 'drop')}
                  >
                    drop
                  </button>
                </div>
              </Tile>
            )}
          </div>
          {arbitration === 'weighted' && (
            <Hint>Contended ports drain by relative weight — set each component's share in Attached.</Hint>
          )}
          {arbitration === 'priority' && (
            <Hint>Contended ports drain by rank, lower first — set ranks in Attached.</Hint>
          )}
        </Card>

        <RulesCard comp={comp} graph={graph} onEdit={onEdit} />

        <Card id="router-attached" title="Attached" chip={attached.length}>
          {attached.length === 0 && (
            <Hint>
              none — drag from the router's ＋ to a top-level component, or pick this router in
              the component's Fabric card
            </Hint>
          )}
          {attached.map((a) => {
            const weight = policies[a.component]?.weight ?? 1;
            const priority = policies[a.component]?.priority ?? null;
            return (
              <div key={a.component} className="insp-item">
                <span className="insp-avatar">{a.component.charAt(0).toUpperCase()}</span>
                <span className="insp-id" title={a.component}>
                  {a.component}
                </span>
                {arbitration === 'weighted' && (
                  <>
                    <div
                      className="insp-stepper"
                      title={`${a.component}'s share of contended bandwidth (relative weight)`}
                    >
                      <button
                        disabled={weight <= 1}
                        aria-label={`decrease ${a.component}'s weight`}
                        onClick={() => setWeight(a.component, weight - 1)}
                      >
                        −
                      </button>
                      <span className="v">{weight}</span>
                      <button
                        aria-label={`increase ${a.component}'s weight`}
                        onClick={() => setWeight(a.component, weight + 1)}
                      >
                        ＋
                      </button>
                    </div>
                    <span className="insp-share" title="effective share of contended bandwidth">
                      {Math.round((weight / totalWeight) * 100)}%
                    </span>
                  </>
                )}
                {arbitration === 'priority' && (
                  <NumberField
                    id={`${comp.id}:${a.component}:priority`}
                    className="insp-num"
                    value={priority}
                    min={0}
                    nullable
                    placeholder="last"
                    title={`${a.component}'s drain rank — lower drains first; empty = last`}
                    onCommit={(next) => {
                      onEdit(
                        {
                          kind: 'setAttachmentPolicy',
                          router: comp.id,
                          component: a.component,
                          priority: next,
                        },
                        {
                          undo: () =>
                            onEdit({
                              kind: 'setAttachmentPolicy',
                              router: comp.id,
                              component: a.component,
                              priority,
                            }),
                          redo: () =>
                            onEdit({
                              kind: 'setAttachmentPolicy',
                              router: comp.id,
                              component: a.component,
                              priority: next,
                            }),
                        },
                      );
                    }}
                  />
                )}
                <IconBtn
                  icon="✕"
                  label={`detach ${a.component}`}
                  danger
                  onClick={() =>
                    onEdit(
                      { kind: 'attachRouter', id: a.component, router: comp.id, attach: false },
                      {
                        undo: () =>
                          onEdit({
                            kind: 'attachRouter',
                            id: a.component,
                            router: comp.id,
                            attach: true,
                          }),
                        redo: () =>
                          onEdit({
                            kind: 'attachRouter',
                            id: a.component,
                            router: comp.id,
                            attach: false,
                          }),
                      },
                    )
                  }
                />
              </div>
            );
          })}
        </Card>

        <Card id="router-trunks" title="Trunks" chip={trunked.size} help={HELP.trunks}>
          {otherRouters.length === 0 && <Hint>no other routers yet</Hint>}
          {otherRouters.map((r) => {
            const connected = trunked.has(r.id);
            return (
              <ToggleRow
                key={r.id}
                glyph="◈"
                label={r.label}
                title={`trunk ${comp.id} ↔ ${r.id}`}
                checked={connected}
                onChange={() =>
                  onEdit(
                    { kind: 'linkRouters', a: comp.id, b: r.id, connect: !connected },
                    {
                      undo: () =>
                        onEdit({ kind: 'linkRouters', a: comp.id, b: r.id, connect: connected }),
                      redo: () =>
                        onEdit({ kind: 'linkRouters', a: comp.id, b: r.id, connect: !connected }),
                    },
                  )
                }
              />
            );
          })}
        </Card>

        <Card id="router-models" title="Latency models" chip={models.length} help={HELP.latencyModel}>
          {models.map((m) => {
            const used = modelUse(m);
            return (
              <div key={m} className="insp-item">
                <span
                  className="insp-id insp-fn"
                  title={`${m}(event) — assignable to wires riding ${comp.id}`}
                >
                  ƒ {m}
                </span>
                <span className="badge">{used > 0 ? `${used} wire${used === 1 ? '' : 's'}` : 'unused'}</span>
              </div>
            );
          })}
          {models.length === 0 && <Hint>none parsed yet</Hint>}
          <Hint>
            Member functions of <code>src/{comp.id}.cpp</code> —{' '}
            <a className="message-link" onClick={() => onReveal(comp.id)}>
              open source ⧉
            </a>{' '}
            and write <code>microarch::Cycle name(const microarch::Event&amp;)</code> below the
            markers; assign one per routed wire in its wire panel.
          </Hint>
        </Card>
      </div>
    );
  }

  if (comp && comp.kind === 'composite') {
    const children = graph.components.filter((c) => c.parent === comp.id);
    const pins = children.filter((c) => c.io !== undefined);
    const editable = authored.components.has(comp.id);
    return (
      <div className="inspector">
        <Head
          glyph="▣"
          glyphClass="composite"
          title={<span className="name">{comp.label}</span>}
          chip={<span className="badge">composite</span>}
          sub={comp.id}
          actions={
            <>
              <IconBtn icon="⏎" label="Enter composite" onClick={() => onDrillIn(comp.id)} />
              {editable && (
                <IconBtn
                  icon="⎘"
                  label="Duplicate composite and everything inside it (independent copy)"
                  onClick={() => onDuplicate(comp.id)}
                />
              )}
              <span className="spacer" />
              {editable && (
                <IconBtn icon="🗑" label="Delete composite (with contents)" danger onClick={onDelete} />
              )}
            </>
          }
        />
        <Card id="composite-children" title="Children" chip={children.length}>
          {children.length === 0 ? (
            <Hint>empty — drill in and add blocks</Hint>
          ) : (
            <p className="insp-childlist">{children.map((c) => c.label).join(', ')}</p>
          )}
          <div className="insp-btnrow">
            <button onClick={() => onDrillIn(comp.id)}>Enter ⏎</button>
          </div>
        </Card>
        <Card id="composite-pins" title="Boundary pins" chip={pins.length} help={HELP.pins}>
          {pins.map((pin) => (
            <div key={pin.id} className="insp-item">
              <span className="insp-k">{pin.io === 'in' ? '⇥ in' : '↦ out'}</span>
              <span className="insp-id" title={pin.id}>
                {pin.label}
              </span>
            </div>
          ))}
          {pins.length === 0 && <Hint>none — the composite has no interface yet</Hint>}
          {editable && (
            <div className="insp-btnrow">
              <button
                title={`add an input pin inside ${comp.label} (a new I/O leaf child)`}
                onClick={() => onAddPin(comp.id, 'in')}
              >
                + Add input
              </button>
              <button
                title={`add an output pin inside ${comp.label} (a new I/O leaf child)`}
                onClick={() => onAddPin(comp.id, 'out')}
              >
                + Add output
              </button>
            </div>
          )}
        </Card>
        <FabricCard comp={comp} graph={graph} onEdit={onEdit} />
      </div>
    );
  }

  if (comp) {
    const editable = authored.components.has(comp.id);
    const isTraffic = comp.role === 'trafficgen';
    return (
      <div className="inspector">
        <Head
          glyph={isTraffic ? '⚡' : '▤'}
          glyphClass={isTraffic ? 'traffic' : ''}
          title={
            editable ? (
              <input
                className="insp-name"
                value={label}
                title="rename — commits on blur"
                onChange={(e) => setLabel(e.target.value)}
                onBlur={() => {
                  if (label !== comp.label && label.trim()) {
                    const prev = comp.label;
                    onEdit(
                      { kind: 'renameComponent', id: comp.id, label: label.trim() },
                      {
                        undo: () => onEdit({ kind: 'renameComponent', id: comp.id, label: prev }),
                        redo: () =>
                          onEdit({ kind: 'renameComponent', id: comp.id, label: label.trim() }),
                      },
                    );
                  }
                }}
              />
            ) : (
              <span className="name">{comp.id.split('.').pop()}</span>
            )
          }
          chip={!editable ? <span className="badge badge-hand">hand-written</span> : undefined}
          sub={comp.id.includes('.') ? comp.id : undefined}
          actions={
            <>
              <IconBtn icon="⧉" label="Open source" onClick={() => onReveal(comp.id)} />
              {editable && (
                <IconBtn icon="⎘" label="Duplicate block" onClick={() => onDuplicate(comp.id)} />
              )}
              <span className="spacer" />
              {editable && <IconBtn icon="🗑" label="Delete block" danger onClick={onDelete} />}
            </>
          }
        />
        {isTraffic && (
          <TrafficCard comp={comp} editable={editable} onEdit={onEdit} onReveal={onReveal} />
        )}
        {!isTraffic && (
          <Card id="impl" title="Implementation" chip={(comp.impl ?? 'cpp') === 'sv' ? 'SV' : 'C++'} help={HELP.impl}>
            <div className="insp-crow">
              <div className="impl-toggle">
                {(['cpp', 'sv'] as ImplChoice[]).map((impl) => (
                  <button
                    key={impl}
                    className={(comp.impl ?? 'cpp') === impl ? 'on' : ''}
                    disabled={!editable}
                    title={
                      impl === 'cpp'
                        ? 'run the C++ block'
                        : 'run the SystemVerilog twin (verilated + co-simulated on Run)'
                    }
                    onClick={() => {
                      const prev = comp.impl ?? 'cpp';
                      if (prev === impl) return;
                      onEdit(
                        { kind: 'setImpl', id: comp.id, impl },
                        {
                          undo: () => onEdit({ kind: 'setImpl', id: comp.id, impl: prev }),
                          redo: () => onEdit({ kind: 'setImpl', id: comp.id, impl }),
                        },
                      );
                    }}
                  >
                    {impl === 'cpp' ? 'C++' : 'SV'}
                  </button>
                ))}
              </div>
              <a
                className="message-link"
                title="open the SystemVerilog twin"
                onClick={() =>
                  post({ type: 'revealFile', path: `src/${comp.id.split('.').join('/')}.sv` })
                }
              >
                .sv ⧉
              </a>
            </div>
            {(comp.impl ?? 'cpp') === 'sv' && (
              <>
                <Hint>
                  SV twin selected — Run lints it, verilates it, and executes it in-engine through
                  a generated co-sim adapter (the C++ block is skipped).
                </Hint>
                <ToggleRow
                  label="⚖ check vs C++ (divergence)"
                  title="Run also executes the C++ block in shadow (its outputs never enter the design) and reports per-token output mismatches in PROBLEMS"
                  checked={comp.checkDivergence === true}
                  disabled={!editable}
                  onChange={(enabled) => {
                    onEdit(
                      { kind: 'setCheckDivergence', id: comp.id, enabled },
                      {
                        undo: () =>
                          onEdit({ kind: 'setCheckDivergence', id: comp.id, enabled: !enabled }),
                        redo: () => onEdit({ kind: 'setCheckDivergence', id: comp.id, enabled }),
                      },
                    );
                  }}
                />
              </>
            )}
          </Card>
        )}
        <FabricCard comp={comp} graph={graph} onEdit={onEdit} />
        <InputsCard
          comp={comp}
          graph={graph}
          editable={editable}
          onEdit={onEdit}
          onReveal={onReveal}
          onRevealEvent={onRevealEvent}
        />
        <Card id="ports" title="Out-ports" chip={comp.outPorts.length} help={HELP.outports}>
          {comp.outPorts.length === 0 && <Hint>none — drag from ＋ on the canvas to connect</Hint>}
          {comp.outPorts.map((port) => {
            const link = graph.links.find((l) => l.from === comp.id && l.fromPort === port.name);
            const fields = port.message
              ? (graph.events.find((e) => e.id === port.message)?.fields ?? [])
              : [];
            return (
              <div key={port.name} className="insp-port">
                <div className="insp-item">
                  <span className="insp-portname" title={port.name}>
                    {port.name}
                  </span>
                  <BitsChip bits={bitsOf(graph, port.message)} />
                  <span
                    className="insp-ellip"
                    title={`${port.message ?? '—'} → ${link?.to ?? '∅'}`}
                  >
                    {port.message ? (
                      <a
                        className="message-link"
                        title={`open ${port.message}`}
                        onClick={() => onRevealEvent(port.message!)}
                      >
                        {port.message}
                      </a>
                    ) : (
                      '—'
                    )}{' '}
                    → {link?.to ?? '∅'}
                  </span>
                  {editable && (
                    <IconBtn
                      icon="✕"
                      label={`delete wire ${comp.id}.${port.name}`}
                      danger
                      onClick={() => {
                        if (link) onDeleteWire(link.id);
                        else onEdit({ kind: 'deleteWire', from: comp.id, port: port.name });
                      }}
                    />
                  )}
                </div>
                {fields.length > 0 && (
                  <details className="ins-fields">
                    <summary>
                      {fields.length} variable{fields.length === 1 ? '' : 's'}
                    </summary>
                    {fields.map((f) => {
                      const idx = f.indexOf(':');
                      return (
                        <div key={f} className="ins-row ins-field-row">
                          <span className="ins-key ins-var">{f.slice(0, idx)}</span>
                          <span className="ins-vartype">{f.slice(idx + 1)}</span>
                        </div>
                      );
                    })}
                  </details>
                )}
              </div>
            );
          })}
        </Card>
        <VarsCard
          compId={comp.id}
          vars={comp.vars}
          editable={editable}
          typeOptions={availableTypes(spec)}
          onEdit={onEdit}
        />
      </div>
    );
  }

  const wireCounts = {
    wired: graph.links.filter((l) => l.status === 'wired').length,
    inferred: graph.links.filter((l) => l.status === 'inferred').length,
    unresolved: graph.links.filter((l) => l.status === 'unresolved').length,
  };
  return (
    <div className="inspector">
      <Head
        glyph="▦"
        title={<span className="name">Design</span>}
        sub={`${graph.components.filter((c) => c.kind === 'leaf').length} leaves · ${graph.components.filter((c) => c.kind === 'composite').length} composites · ${graph.links.length} wires`}
      />
      <Card id="design-contents" title="Contents">
        <div className="insp-crow">
          <span className="insp-k">wires</span>
          <span className="insp-chiprow">
            <StatusChip status="wired" count={wireCounts.wired} />
            <StatusChip status="inferred" count={wireCounts.inferred} />
            <StatusChip status="unresolved" count={wireCounts.unresolved} />
          </span>
        </div>
        <div className="insp-crow">
          <span className="insp-k">stubs</span>
          <span>{graph.stubs.length}</span>
        </div>
        <div className="insp-crow">
          <span className="insp-k">messages</span>
          <span>{graph.events.length}</span>
        </div>
        <Hint>
          Select a block or wire to edit it. Solid wires are explicit <code>configureOut</code> in
          the C++; dashed wires are inferred from message types; red means unresolved.
          Double-click a composite to drill in; Escape drills out.
        </Hint>
      </Card>
    </div>
  );
}
