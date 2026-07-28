// Verilator co-simulation adapters — the piece that makes impl:'sv' real.
// For every leaf whose active implementation is the SV twin, we emit one
// microarch::Component subclass that owns the Verilated model (V_<id>) and
// translates between the engine's event world and the twin's port world:
//
//   handler(ev)  — dispatch phase: latch the event onto the twin's input
//                  ports (<Event>_valid + one signal per field); the twin
//                  samples them at the next posedge.
//   tick(cycle)  — clock-edge phase: drive one clk pulse, then read each
//                  out-port's <port>_valid and convert high strobes back
//                  into engine events on the block's Links. Sends during
//                  Tick land next cycle (Scheduler::deliveryCycle is
//                  phase-aware), so a twin can never re-enter the cycle
//                  that clocked it — real synchronous semantics.
//
// The emitted header lives in build/ (not src/): it is a derived artifact
// tied to the verilated output, and the project parser deliberately skips
// build/, so adapter classes can never masquerade as authored blocks.
//
// Field marshalling is type-agnostic: both directions cast through
// decltype of the destination, so spec aliases, signal enum classes and
// narrow Verilator storage types (CData/SData/IData/QData) all coerce
// without the writer knowing widths.
//
// Token attribution: input tokens queue in a FIFO; every tick that emits at
// least one output consumes the front token and stamps it on all events
// sent that tick. Exact for one-in/one-out-per-transaction twins (fan-out
// included); a heuristic for deeper reordering pipelines — documented, not
// hidden.
//
// Divergence check (opt-in, `checked` leaves): the adapter ALSO instantiates
// the real C++ block as a shadow. The shadow's out-links are diverted
// (Link::divert) into per-port expectation buffers keyed by token — nothing
// the shadow sends reaches the design or the hop trace. When the SV side
// emits, the same token's buffered C++ event is compared field by field;
// mismatches (and either-side-only emissions) surface as "cosim"
// divergences. Comparison is per-token, not per-cycle — the C++ handler
// fires in Dispatch while the twin fires at Tick, and pipeline depth may
// differ; like the token FIFO this is exact for in-order transaction flows
// and a documented heuristic for reordering ones. Two same-token emissions
// on one port keep the last (one expectation slot per token per port).

import { leafName, type AuthoredComponent, type AuthoringModel } from '@iss/contracts/model';
import { BEGIN_MARKER, END_MARKER } from './markers';

export const SV_ADAPTERS_FILE = 'iss_sv_adapters_gen.h';

/** Leaves whose active implementation is the SV twin. Traffic generators
 *  never have twins — their behavior is engine-clocked generation. */
export function svLeavesOf(model: AuthoringModel): AuthoredComponent[] {
  return model.components.filter(
    (c) => c.kind === 'leaf' && c.impl === 'sv' && c.role !== 'trafficgen',
  );
}

/** Verilator --prefix for a leaf (also the generated model class name). */
export const svPrefixOf = (id: string): string => 'V_' + id.split('.').join('_');

/** The adapter class name for a leaf. */
export const svAdapterOf = (id: string): string => 'SvImpl_' + id.split('.').join('_');

/** The C++ block's qualified type (dot-path → namespaces). */
const cppTypeOf = (id: string): string => id.split('.').join('::');

function emitAdapter(
  comp: AuthoredComponent,
  model: AuthoringModel,
  waves: boolean,
  checked: boolean,
): string {
  const fieldsOf = (event: string) => model.events.find((e) => e.id === event)?.fields ?? [];
  const cls = svAdapterOf(comp.id);
  const modelCls = svPrefixOf(comp.id);
  const ports = comp.outPorts;
  const lines: string[] = [];

  lines.push(`class ${cls} final : public microarch::Component {`);
  lines.push('  private:');
  for (const p of ports) lines.push(`    microarch::Link* p_${p.name};`);
  lines.push(`    std::unique_ptr<${modelCls}> model_;`);
  lines.push('    std::deque<microarch::TokenId> tokens_;');
  lines.push('    microarch::TokenId lastToken_ = microarch::no_token;');
  if (waves) lines.push('    std::unique_ptr<VerilatedVcdC> vcd_;');
  if (checked) {
    lines.push('    // Divergence check: the C++ block runs in shadow; its out-links are');
    lines.push('    // diverted into per-token expectation buffers (never delivered).');
    lines.push('    microarch::Scheduler& sched_;');
    for (const p of ports) lines.push(`    microarch::Link cap_${p.name}_;`);
    lines.push(`    ${cppTypeOf(comp.id)} shadow_;`);
    for (const p of ports)
      lines.push(
        `    std::map<microarch::TokenId, std::unique_ptr<${p.message}>> exp_${p.name}_;`,
      );
  }
  lines.push('  public:');

  // ctor — same positional Link* surface as the C++ block (checked adapters
  // additionally take the Scheduler first, for capture links and reporting),
  // then a reset pulse so the twin enters cycle 0 out of reset.
  const portParams = ports.map((p) => `microarch::Link* ${p.name} = nullptr`);
  const params = (checked ? ['microarch::Scheduler& sched', ...portParams] : portParams).join(', ');
  const inits = ports
    .map((p) => `p_${p.name}(${p.name})`)
    .concat(`model_(std::make_unique<${modelCls}>())`);
  if (checked) {
    inits.push('sched_(sched)');
    for (const p of ports) inits.push(`cap_${p.name}_(sched, 1)`);
    inits.push(`shadow_(${ports.map((p) => `&cap_${p.name}_`).join(', ')})`);
  }
  lines.push(`    explicit ${cls}(${params})`);
  lines.push(`        : microarch::Component("${comp.id}"), ${inits.join(', ')} {`);
  for (const p of ports) {
    lines.push(`        if (p_${p.name}) {`);
    lines.push(`            p_${p.name}->configureIn(this);`);
    lines.push(`            p_${p.name}->latency = ${p.latency ?? 1};`);
    lines.push('        }');
  }
  if (checked) {
    for (const p of ports) {
      // Non-null destination so the shadow's `if (port && port->connected())`
      // guard passes; the divert tap consumes the event before delivery.
      lines.push(`        cap_${p.name}_.configureOut(&shadow_);`);
      lines.push(`        cap_${p.name}_.divert([this](std::unique_ptr<microarch::Event> ev) {`);
      lines.push(`            if (ev->type() != "${p.message}") return;`);
      // Token read BEFORE release(): C++17 sequences an assignment's RHS
      // first, so exp_[ev->token] = …ev.release()… would deref a null ev.
      lines.push('            const microarch::TokenId token = ev->token;');
      lines.push(`            exp_${p.name}_[token] = std::unique_ptr<${p.message}>(`);
      lines.push(`                static_cast<${p.message}*>(ev.release()));`);
      lines.push('        });');
    }
  }
  lines.push('        model_->rst = 1;');
  lines.push('        model_->clk = 0; model_->eval();');
  lines.push('        model_->clk = 1; model_->eval();');
  lines.push('        model_->clk = 0; model_->eval();');
  lines.push('        model_->rst = 0;');
  if (waves) {
    // The reset pulse above happens "before cycle 0" and is deliberately not
    // dumped — VCD time starts at 2*cycle (posedge) / 2*cycle+1 (negedge).
    lines.push('        Verilated::traceEverOn(true);');
    lines.push('        vcd_ = std::make_unique<VerilatedVcdC>();');
    lines.push('        model_->trace(vcd_.get(), 99);');
    lines.push(`        vcd_->open("build/waves/${comp.id.split('.').join('_')}.vcd");`);
  }
  lines.push('    }');
  if (waves || checked) {
    lines.push(`    ~${cls}() override {`);
    if (checked) {
      lines.push('        // Flush: tokens the C++ shadow answered but the SV twin never did.');
      for (const p of ports) {
        lines.push(`        for (const auto& kv : exp_${p.name}_)`);
        lines.push(
          `            sched_.reportDivergence(*this, kv.first, ` +
            `"${p.name}: c++ emitted ${p.message}; sv never did", "cosim");`,
        );
      }
    }
    if (waves) lines.push('        if (vcd_) vcd_->close();');
    lines.push('        model_->final();');
    lines.push('    }');
  } else {
    lines.push(`    ~${cls}() override { model_->final(); }`);
  }
  lines.push('');

  // handler — latch the event onto the twin's inputs. Two same-type events
  // in one cycle overwrite (a wire carries one value per cycle): honest RTL
  // semantics, not a bug.
  lines.push('    void handler(microarch::Event& ev) override {');
  lines.push('        if (ev.token != microarch::no_token) {');
  lines.push('            tokens_.push_back(ev.token);');
  lines.push('            lastToken_ = ev.token;');
  lines.push('        }');
  for (const message of comp.consumes) {
    lines.push(`        if (ev.type() == "${message}") {`);
    const fields = fieldsOf(message);
    if (fields.length > 0) {
      lines.push(`            auto& msg = static_cast<${message}&>(ev);`);
      for (const f of fields)
        lines.push(
          `            model_->${message}_${f.name} = ` +
            `static_cast<decltype(model_->${message}_${f.name})>(msg.${f.name});`,
        );
    }
    lines.push(`            model_->${message}_valid = 1;`);
    lines.push('        }');
  }
  if (checked) {
    lines.push('        // Shadow execution: the C++ block sees the same event; its outputs');
    lines.push('        // land in the expectation buffers via the diverted capture links.');
    lines.push('        shadow_.handler(ev);');
  }
  lines.push('    }');
  lines.push('');

  // tick — one clock pulse, then out_valid strobes → engine events.
  lines.push(`    void tick(microarch::Cycle${waves ? ' cycle' : ''}) override {`);
  lines.push('        model_->clk = 1; model_->eval();  // posedge: the twin samples its inputs');
  if (waves) lines.push('        vcd_->dump(2 * cycle);  // VCD time 2c = posedge of engine cycle c');
  if (ports.length > 0) {
    lines.push('        const microarch::TokenId token = tokens_.empty() ? lastToken_ : tokens_.front();');
    lines.push('        bool emitted = false;');
    for (const p of ports) {
      lines.push(`        if (model_->${p.name}_valid && p_${p.name} && p_${p.name}->connected()) {`);
      lines.push(`            auto ev = std::make_unique<${p.message}>();`);
      for (const f of fieldsOf(p.message))
        lines.push(
          `            ev->${f.name} = static_cast<decltype(ev->${f.name})>(model_->${p.name}_${f.name});`,
        );
      lines.push('            ev->token = token;');
      if (checked) lines.push(`            check_${p.name}(*ev, token);`);
      lines.push(`            p_${p.name}->send(std::move(ev));`);
      lines.push('            emitted = true;');
      lines.push('        }');
    }
    lines.push('        if (emitted && !tokens_.empty()) tokens_.pop_front();');
  }
  lines.push('        model_->clk = 0; model_->eval();');
  for (const message of comp.consumes)
    lines.push(`        model_->${message}_valid = 0;  // each delivered event is one-cycle valid`);
  if (waves) {
    lines.push('        model_->eval();  // settle cleared strobes so the dump shows them low');
    lines.push('        vcd_->dump(2 * cycle + 1);  // VCD time 2c+1 = negedge of engine cycle c');
  }
  lines.push('    }');
  lines.push('');

  // Per-port divergence checks: the generator knows the event fields, so the
  // comparison is emitted field by field — no runtime reflection. Values are
  // widened through unsigned long long for printing (integral/enum fields).
  if (checked) {
    for (const p of ports) {
      lines.push(`    void check_${p.name}(const ${p.message}& svEv, microarch::TokenId token) {`);
      lines.push(`        auto exp = exp_${p.name}_.find(token);`);
      lines.push(`        if (exp == exp_${p.name}_.end()) {`);
      lines.push(
        `            sched_.reportDivergence(*this, token, ` +
          `"${p.name}: sv emitted ${p.message}; c++ did not", "cosim");`,
      );
      lines.push('            return;');
      lines.push('        }');
      for (const f of fieldsOf(p.message)) {
        lines.push(
          `        if (static_cast<unsigned long long>(exp->second->${f.name}) != ` +
            `static_cast<unsigned long long>(svEv.${f.name}))`,
        );
        lines.push(
          `            sched_.reportDivergence(*this, token, "${p.name}.${f.name}: sv=" + ` +
            `std::to_string(static_cast<unsigned long long>(svEv.${f.name})) + " != cpp=" + ` +
            `std::to_string(static_cast<unsigned long long>(exp->second->${f.name})), "cosim");`,
        );
      }
      lines.push(`        exp_${p.name}_.erase(exp);`);
      lines.push('    }');
      lines.push('');
    }
  }

  // wire — identical contract to the C++ block, so the harness treats both
  // implementations uniformly.
  const wired = ports.filter((p) => p.to);
  lines.push('    void wire(microarch::Registry& registry) {');
  if (wired.length === 0) lines.push('        (void)registry;  // no wired out-ports');
  for (const p of wired)
    lines.push(
      `        if (p_${p.name}) p_${p.name}->configureOut(registry.find("${p.to}"));` +
        `  // wire: ${comp.id}.${p.name} -> ${p.to} (${p.message})`,
    );
  lines.push('    }');
  lines.push('};');
  return lines.join('\n');
}

export interface SvAdapterOpts {
  /** Emit VCD dump code (build/waves/<id>.vcd, time = 2*cycle + phase). */
  waves?: boolean;
  /** Leaf ids with the SV↔C++ divergence check enabled (C++ shadow runs). */
  checked?: Set<string>;
}

/** The whole adapters header (build/iss_sv_adapters_gen.h) — fully generated. */
export function emitSvAdapters(model: AuthoringModel, opts: SvAdapterOpts = {}): string {
  const waves = opts.waves === true;
  const checked = opts.checked ?? new Set<string>();
  const leaves = svLeavesOf(model).sort((a, b) => a.id.localeCompare(b.id));
  const anyChecked = leaves.some((c) => checked.has(c.id));
  const lines: string[] = [];
  lines.push(BEGIN_MARKER);
  lines.push('#pragma once');
  lines.push('');
  lines.push('#include <deque>');
  if (anyChecked) lines.push('#include <map>');
  lines.push('#include <memory>');
  if (anyChecked) lines.push('#include <string>');
  lines.push('');
  lines.push('#include "microarch/engine.hpp"');
  lines.push('#include "iss_events.h"');
  if (waves) lines.push('#include "verilated_vcd_c.h"');
  lines.push('');
  for (const c of leaves) lines.push(`#include "${svPrefixOf(c.id)}.h"  // verilated ${leafName(c.id)}.sv`);
  for (const c of leaves) {
    lines.push('');
    lines.push(emitAdapter(c, model, waves, checked.has(c.id)));
  }
  lines.push(END_MARKER);
  lines.push('');
  return lines.join('\n');
}
