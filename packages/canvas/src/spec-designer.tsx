// The SPEC tab — Layer 1 as a universal architectural contract for any
// accelerator: meta (name/kind/xlen/harts), type aliases, signal enums,
// global state (generated into inc/iss_arch.h as `arch.*`), design-level
// I/O, and the operation vocabulary. Operations the oracle grades carry
// ✓oracle; everything else is honestly "spec-only". No spec yet → templates.

import { useState, type ReactNode } from 'react';

import {
  FORMAT_FIELDS,
  SPEC_KIND_SUGGESTIONS,
  SPEC_TEMPLATES,
  availableTypes,
  stateType,
  type Operation,
  type SpecDocument,
  type SpecEdit,
} from '@iss/contracts/spec';

interface Props {
  spec: SpecDocument | null;
  onEdit(edit: SpecEdit): void;
  onCreate(templateId: string): void;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function EncodingStrip({ format }: { format?: string }) {
  const fields = format ? FORMAT_FIELDS[format] : undefined;
  if (!fields) return null;
  const total = fields.reduce((s, f) => s + f.bits, 0);
  return (
    <div className="enc-strip" title={`${format}-type encoding (${total} bits)`}>
      {fields.map((f, i) => (
        <span key={i} className="enc-field" style={{ flexGrow: f.bits }}>
          <span className="enc-name">{f.name}</span>
          <span className="enc-bits">{f.bits}</span>
        </span>
      ))}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="spec-section">
      <h4>{title}</h4>
      {note && <p className="ins-note">{note}</p>}
      {children}
    </section>
  );
}

const SPACES = ['reg', 'pc', 'mem', 'custom'];

function MetaSection({ spec, onEdit }: { spec: SpecDocument; onEdit(edit: SpecEdit): void }) {
  const oracleChecked = spec.operations.filter((o) => o.oracle).length;
  return (
    <Section title="Architecture">
      <label className="ins-row">
        <span className="ins-key">name</span>
        <input
          defaultValue={spec.name}
          key={`name:${spec.name}`}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== spec.name) onEdit({ kind: 'setMeta', name });
          }}
        />
      </label>
      <div className="ins-row">
        <span className="ins-key">kind</span>
        <input
          list="spec-kinds"
          defaultValue={spec.kind}
          key={`kind:${spec.kind}`}
          onBlur={(e) => {
            const kind = e.target.value.trim();
            if (kind && kind !== spec.kind) onEdit({ kind: 'setMeta', specKind: kind });
          }}
        />
        <datalist id="spec-kinds">
          {SPEC_KIND_SUGGESTIONS.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <span className="ins-key" style={{ minWidth: 0 }}>
          xlen
        </span>
        <input
          className="spec-num"
          type="number"
          min={1}
          defaultValue={spec.xlen ?? 32}
          key={`xlen:${spec.xlen}`}
          onBlur={(e) => onEdit({ kind: 'setMeta', xlen: Math.max(1, Number(e.target.value) || 32) })}
        />
        <span className="ins-key" style={{ minWidth: 0 }}>
          harts
        </span>
        <input
          className="spec-num"
          type="number"
          min={1}
          defaultValue={spec.lanes?.harts ?? 1}
          key={`harts:${spec.lanes?.harts}`}
          onBlur={(e) => onEdit({ kind: 'setMeta', harts: Math.max(1, Number(e.target.value) || 1) })}
        />
      </div>
      <p className="ins-note">
        Runs are graded against this contract — {oracleChecked}/{spec.operations.length} operations
        oracle-checked. Persists to <code>iss_spec.json</code>; types, signals and state generate{' '}
        <code>inc/iss_arch.h</code>.
      </p>
    </Section>
  );
}

function TypesSection({ spec, onEdit }: { spec: SpecDocument; onEdit(edit: SpecEdit): void }) {
  const [name, setName] = useState('');
  const [base, setBase] = useState('uint32_t');
  const ok = IDENT.test(name) && base.trim() !== '';
  const add = () => {
    if (!ok) return;
    onEdit({ kind: 'addType', type: { name, base: base.trim() } });
    setName('');
  };
  return (
    <Section
      title="Types"
      note="Named aliases usable anywhere in the design (block vars, event fields, state)."
    >
      {(spec.types ?? []).map((t) => (
        <div key={t.name} className="isa-row">
          <span className="isa-mnemonic">{t.name}</span>
          <span className="isa-summary">= {t.base}</span>
          <button
            className="isa-remove"
            title="remove"
            onClick={() => onEdit({ kind: 'removeType', name: t.name })}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="isa-add">
        <input placeholder="name (e.g. word)" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="base type"
          list="spec-type-list"
          value={base}
          onChange={(e) => setBase(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button disabled={!ok} onClick={add}>
          ＋ type
        </button>
      </div>
    </Section>
  );
}

function SignalsSection({ spec, onEdit }: { spec: SpecDocument; onEdit(edit: SpecEdit): void }) {
  const [name, setName] = useState('');
  const [underlying, setUnderlying] = useState('uint8_t');
  const [valueDraft, setValueDraft] = useState<Record<string, string>>({});
  const ok = IDENT.test(name);
  const add = () => {
    if (!ok) return;
    onEdit({ kind: 'addSignal', signal: { name, underlying: underlying.trim() || 'uint8_t', values: [] } });
    setName('');
  };
  const addValue = (signalName: string, values: string[]) => {
    const v = (valueDraft[signalName] ?? '').trim();
    if (!IDENT.test(v) || values.includes(v)) return;
    onEdit({ kind: 'editSignal', name: signalName, signal: { values: [...values, v] } });
    setValueDraft((d) => ({ ...d, [signalName]: '' }));
  };
  return (
    <Section
      title="Signals"
      note="Named enums (enum class) usable as types throughout the design."
    >
      {(spec.signals ?? []).map((s) => (
        <div key={s.name} className="spec-signal">
          <div className="isa-row">
            <span className="isa-mnemonic">{s.name}</span>
            <span className="isa-summary">: {s.underlying}</span>
            <button
              className="isa-remove"
              title="remove"
              onClick={() => onEdit({ kind: 'removeSignal', name: s.name })}
            >
              ✕
            </button>
          </div>
          <div className="spec-chips">
            {s.values.map((v) => (
              <span key={v} className="spec-chip">
                {v}
                <button
                  title="remove value"
                  onClick={() =>
                    onEdit({
                      kind: 'editSignal',
                      name: s.name,
                      signal: { values: s.values.filter((x) => x !== v) },
                    })
                  }
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              className="spec-chip-input"
              placeholder="+ value"
              value={valueDraft[s.name] ?? ''}
              onChange={(e) => setValueDraft((d) => ({ ...d, [s.name]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && addValue(s.name, s.values)}
              onBlur={() => addValue(s.name, s.values)}
            />
          </div>
        </div>
      ))}
      <div className="isa-add">
        <input
          placeholder="signal (e.g. OpKind)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="isa-bits"
          placeholder="underlying"
          title="underlying type"
          value={underlying}
          onChange={(e) => setUnderlying(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button disabled={!ok} onClick={add}>
          ＋ signal
        </button>
      </div>
    </Section>
  );
}

function StateSection({ spec, onEdit }: { spec: SpecDocument; onEdit(edit: SpecEdit): void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [bits, setBits] = useState(32);
  const [count, setCount] = useState<string>('');
  const [init, setInit] = useState('');
  const [space, setSpace] = useState('reg');
  const ok = IDENT.test(name) && bits > 0;
  const add = () => {
    if (!ok) return;
    const n = Number(count);
    onEdit({
      kind: 'addState',
      element: {
        name,
        label: name,
        bits,
        count: Number.isFinite(n) && n > 1 ? n : undefined,
        space,
        type: type.trim() || undefined,
        init: init.trim() || undefined,
      },
    });
    setName('');
    setCount('');
    setInit('');
  };
  return (
    <Section
      title="Global state"
      note="General variables (pc, counters, masks…) every block can read/write — generated into inc/iss_arch.h as arch.<name>."
    >
      {spec.state.map((s) => (
        <div key={s.name} className="isa-row">
          <span className="isa-mnemonic">{s.name}</span>
          <span className="isa-summary">
            {stateType(s)}
            {s.count && s.count > 1 ? `[${s.count}]` : ''}
            {s.init ? ` = ${s.init}` : ''} — {s.label}
            {s.space ? ` [${s.space}]` : ''}
          </span>
          <button
            className="isa-remove"
            title="remove"
            onClick={() => onEdit({ kind: 'removeState', name: s.name })}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="isa-add">
        <input placeholder="name (e.g. pc)" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="type (or blank → bits)"
          list="spec-type-list"
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
        <input
          className="isa-bits"
          type="number"
          min={1}
          title="bits"
          value={bits}
          onChange={(e) => setBits(Math.max(1, Number(e.target.value) || 32))}
        />
      </div>
      <div className="isa-add">
        <input
          className="isa-bits"
          placeholder="count"
          title="count (optional, e.g. 32 registers)"
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
        <input
          placeholder="init (e.g. 0x80000000)"
          value={init}
          onChange={(e) => setInit(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <select value={space} onChange={(e) => setSpace(e.target.value)} title="commit-record space">
          {SPACES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button disabled={!ok} onClick={add}>
          ＋ state
        </button>
      </div>
    </Section>
  );
}

function OperationsSection({ spec, onEdit }: { spec: SpecDocument; onEdit(edit: SpecEdit): void }) {
  const [mnemonic, setMnemonic] = useState('');
  const [format, setFormat] = useState('');
  const [summary, setSummary] = useState('');
  const [semantics, setSemantics] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const mnemonicOk = /^[a-z][a-z0-9._]*$/.test(mnemonic);

  const addOp = () => {
    if (!mnemonicOk) return;
    const op: Operation = {
      mnemonic,
      format: format || undefined,
      summary,
      semantics: semantics || undefined,
      oracle: false,
    };
    onEdit({ kind: 'addOp', op });
    setMnemonic('');
    setSummary('');
    setSemantics('');
  };

  return (
    <Section title="Operations">
      {spec.operations.map((o) => (
        <div key={o.mnemonic} className="isa-instr">
          <div
            className="isa-row isa-row-click"
            onClick={() => setExpanded(expanded === o.mnemonic ? null : o.mnemonic)}
          >
            <span className="isa-mnemonic">{o.oracle ? o.mnemonic : `★ ${o.mnemonic}`}</span>
            {o.format && <span className="isa-type">{o.format}</span>}
            <span className="isa-summary">{o.summary}</span>
            <span className={`badge ${o.oracle ? 'badge-wired' : 'badge-hand'}`}>
              {o.oracle ? '✓oracle' : 'spec-only'}
            </span>
            {!o.oracle && (
              <button
                className="isa-remove"
                title="remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit({ kind: 'removeOp', mnemonic: o.mnemonic });
                }}
              >
                ✕
              </button>
            )}
          </div>
          {expanded === o.mnemonic && (
            <>
              {o.semantics && <p className="ins-note spec-semantics">{o.semantics}</p>}
              <EncodingStrip format={o.format} />
            </>
          )}
        </div>
      ))}
      <div className="isa-add">
        <input
          placeholder="mnemonic (e.g. mac / v_fma)"
          value={mnemonic}
          onChange={(e) => setMnemonic(e.target.value)}
        />
        <select value={format} onChange={(e) => setFormat(e.target.value)} title="encoding format">
          <option value="">no fmt</option>
          {Object.keys(FORMAT_FIELDS).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="isa-add">
        <input
          placeholder="summary (e.g. rd = rs1 * rs2 + rd)"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="isa-add">
        <input
          placeholder="semantics (optional pseudocode)"
          value={semantics}
          onChange={(e) => setSemantics(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addOp()}
        />
        <button disabled={!mnemonicOk} onClick={addOp}>
          ＋ op
        </button>
      </div>
      <p className="ins-note">
        Folding spec-only operations into the Sail oracle build is the engine-owned “Regenerate
        Oracle” step (not yet wired — honestly labeled).
      </p>
    </Section>
  );
}

export function SpecDesigner({ spec, onEdit, onCreate }: Props) {
  if (!spec) {
    return (
      <div className="spec-tab spec-empty">
        <h3>Architecture SPEC</h3>
        <p className="ins-note">
          No spec yet. The spec is the architectural contract your design is graded against — a
          multicore CPU, a GPU, a DSP, or any custom accelerator.
        </p>
        <h4>Start from a template</h4>
        {SPEC_TEMPLATES.map((t) => (
          <button key={t.id} className="spec-template" onClick={() => onCreate(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="spec-tab">
      <datalist id="spec-type-list">
        {availableTypes(spec).map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="spec-columns">
        <div className="spec-col">
          <MetaSection spec={spec} onEdit={onEdit} />
          <TypesSection spec={spec} onEdit={onEdit} />
          <SignalsSection spec={spec} onEdit={onEdit} />
        </div>
        <div className="spec-col">
          <StateSection spec={spec} onEdit={onEdit} />
          <Section
            title="I/O"
            note="Design and composite I/O are blocks now: drag an Input/Output pin from the palette onto the canvas (top level = the design's interface; inside a composite = its boundary pins)."
          >
            <></>
          </Section>
        </div>
        <div className="spec-col">
          <OperationsSection spec={spec} onEdit={onEdit} />
        </div>
      </div>
    </div>
  );
}
