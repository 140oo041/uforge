// SV co-simulation acceptance. The unit tests pin the generated adapter and
// harness shapes; the e2e is the proof-of-execution: the SV twin's behavior
// deliberately DIFFERS from the C++ block (it emits on every 2nd request,
// where the C++ echoes every request), so the hop count in the real trace
// tells us which implementation actually ran — no trust required.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPTY_MODEL, type AuthoringModel, type EditIntent } from '@iss/contracts/model';
import { applyIntent } from '@iss/host/writer/edits';
import { writeHarness, writeModel } from '@iss/host/writer/index';
import { emitHarness } from '@iss/host/writer/harness';
import { END_MARKER } from '@iss/host/writer/markers';
import { SV_ADAPTERS_FILE, emitSvAdapters, svLeavesOf } from '@iss/host/writer/svadapter';
import { parseProject } from '@iss/host/parser/index';
import { simulate } from '@iss/host/project/run';
import { parseVcd } from '@iss/host/trace/vcd';

const ENGINE = path.resolve(__dirname, '..', '..', 'engine');

function buildModel(intents: EditIntent[]): AuthoringModel {
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

/** Alpha (sv) --RespEvent--> Sink (cpp); Alpha consumes seeded ReqEvents. */
function cosimModel(): AuthoringModel {
  return buildModel([
    { kind: 'addComponent', id: 'U', nodeKind: 'composite' },
    { kind: 'addComponent', id: 'U.Alpha' },
    { kind: 'addComponent', id: 'U.Sink' },
    { kind: 'addEvent', id: 'ReqEvent', fields: [{ name: 'addr', type: 'uint32_t' }] },
    { kind: 'addEvent', id: 'RespEvent', fields: [{ name: 'value', type: 'uint32_t' }] },
    { kind: 'addWire', from: 'U.Alpha', port: 'out', message: 'RespEvent', to: 'U.Sink', latency: 1 },
    { kind: 'setConsumes', id: 'U.Alpha', consumes: ['ReqEvent'] },
    { kind: 'setImpl', id: 'U.Alpha', impl: 'sv' },
  ]);
}

// A behavioral twin that provably differs from the C++ echo: it forwards
// only every SECOND request (a decimator), value = addr + 1.
const HALVER_BODY = [
  '',
  '    logic parity;',
  '    always_ff @(posedge clk) begin',
  '        if (rst) begin',
  "            out_valid <= 1'b0;",
  "            out_value <= '0;",
  "            parity    <= 1'b0;",
  '        end else begin',
  "            out_valid <= 1'b0;",
  '            if (ReqEvent_valid) begin',
  '                parity    <= ~parity;',
  '                out_valid <= parity;  // every 2nd request emits',
  "                out_value <= ReqEvent_addr + 32'd1;",
  '            end',
  '        end',
  '    end',
  '',
  'endmodule',
  '',
].join('\n');

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-svcosim-'));
}

describe('co-sim adapter emission', () => {
  it('emits one adapter per sv leaf with latch, clock, marshal and wire', () => {
    const text = emitSvAdapters(cosimModel());
    expect(text).toContain('#include "V_U_Alpha.h"');
    expect(text).toContain('class SvImpl_U_Alpha final : public microarch::Component');
    expect(text).toContain('microarch::Component("U.Alpha")');
    // handler latches the event onto the twin's inputs, with a decltype cast.
    expect(text).toContain('if (ev.type() == "ReqEvent")');
    expect(text).toContain(
      'model_->ReqEvent_addr = static_cast<decltype(model_->ReqEvent_addr)>(msg.addr);',
    );
    expect(text).toContain('model_->ReqEvent_valid = 1;');
    // tick clocks the twin and converts out strobes back into events.
    expect(text).toContain('model_->clk = 1; model_->eval();');
    expect(text).toContain('if (model_->out_valid && p_out && p_out->connected())');
    expect(text).toContain('ev->value = static_cast<decltype(ev->value)>(model_->out_value);');
    expect(text).toContain('model_->ReqEvent_valid = 0;');
    // reset pulse in the ctor; same wire() contract as the C++ block.
    expect(text).toContain('model_->rst = 1;');
    expect(text).toContain('p_out->configureOut(registry.find("U.Sink"));');
    // Only the sv leaf gets an adapter.
    expect(text).not.toContain('SvImpl_U_Sink');
  });

  it('cpp-only models emit no adapters and svLeavesOf is empty', () => {
    const model = buildModel([
      { kind: 'addComponent', id: 'A' },
      { kind: 'addEvent', id: 'E' },
      { kind: 'addWire', from: 'A', port: 'out', message: 'E' },
    ]);
    expect(svLeavesOf(model)).toHaveLength(0);
  });

  it('waves on: adapters open a VCD and dump both clock phases', () => {
    const text = emitSvAdapters(cosimModel(), { waves: true });
    expect(text).toContain('#include "verilated_vcd_c.h"');
    // traceEverOn must precede trace()/open() — order pinned by index.
    const on = text.indexOf('Verilated::traceEverOn(true);');
    const tr = text.indexOf('model_->trace(vcd_.get(), 99);');
    const open = text.indexOf('vcd_->open("build/waves/U_Alpha.vcd");');
    expect(on).toBeGreaterThan(-1);
    expect(tr).toBeGreaterThan(on);
    expect(open).toBeGreaterThan(tr);
    expect(text).toContain('vcd_->dump(2 * cycle);');
    expect(text).toContain('vcd_->dump(2 * cycle + 1);');
    expect(text).toContain('if (vcd_) vcd_->close();');
  });

  it('waves off (and by default): no VCD surface at all', () => {
    for (const text of [emitSvAdapters(cosimModel()), emitSvAdapters(cosimModel(), { waves: false })]) {
      expect(text).not.toContain('verilated_vcd_c.h');
      expect(text).not.toContain('vcd_');
      expect(text).not.toContain('traceEverOn');
    }
  });
});

describe('harness with sv-impl blocks', () => {
  it('instantiates the adapter, registers it clocked, skips the .cpp include', () => {
    const text = emitHarness(cosimModel());
    expect(text).toContain(`#include "${SV_ADAPTERS_FILE}"`);
    expect(text).toContain('SvImpl_U_Alpha s_U_Alpha(&link_U_Alpha_out);');
    expect(text).toContain('scheduler.addClocked(s_U_Alpha);');
    expect(text).not.toContain('#include "U/Alpha.cpp"');
    // The cpp block is untouched: normal include, no addClocked.
    expect(text).toContain('#include "U/Sink.cpp"');
    expect(text).not.toContain('scheduler.addClocked(s_U_Sink);');
  });

  it('cpp-only harness has no co-sim surface at all', () => {
    const model = cosimModel();
    const cppOnly = applyIntent(model, { kind: 'setImpl', id: 'U.Alpha', impl: 'cpp' });
    const text = emitHarness(cppOnly);
    expect(text).not.toContain(SV_ADAPTERS_FILE);
    expect(text).not.toContain('addClocked');
    expect(text).toContain('#include "U/Alpha.cpp"');
  });

  it('writeHarness materializes build/iss_sv_adapters_gen.h and retires it', () => {
    const root = tmpProject();
    const model = cosimModel();
    writeModel(root, model);
    writeHarness(root, model);
    const adapters = path.join(root, 'build', SV_ADAPTERS_FILE);
    expect(fs.existsSync(adapters)).toBe(true);
    expect(fs.readFileSync(adapters, 'utf8')).toContain('SvImpl_U_Alpha');

    const cppOnly = applyIntent(model, { kind: 'setImpl', id: 'U.Alpha', impl: 'cpp' });
    writeHarness(root, cppOnly);
    expect(fs.existsSync(adapters)).toBe(false);
  });
});

describe('e2e: the Verilated twin executes, not the C++', () => {
  it(
    'a decimating SV twin halves the token stream in the real trace',
    { timeout: 300_000 },
    async () => {
      const root = tmpProject();
      const model = cosimModel();
      writeModel(root, model);

      // Give the twin its behavior: replace the placeholder tail below the
      // generated marker region, exactly like a user editing the .sv.
      const svFile = path.join(root, 'src', 'U', 'Alpha.sv');
      const generated = fs.readFileSync(svFile, 'utf8');
      const cut = generated.indexOf(END_MARKER) + END_MARKER.length;
      fs.writeFileSync(svFile, generated.slice(0, cut) + '\n' + HALVER_BODY);

      writeHarness(root, model, {
        entries: [{ block: 'U.Alpha', event: 'ReqEvent' }],
        tokens: 4,
        cycles: 32,
        wavesEnabled: true,
        checkDivergence: false,
      });

      const graph = parseProject([root]);
      const log: string[] = [];
      const trace = await simulate(
        { projectRoot: root, enginePath: ENGINE, refModel: 'stub', log: (l) => log.push(l) },
        graph,
        [{ id: 'U.Alpha', svFile: path.join('src', 'U', 'Alpha.sv') }],
      );

      // 4 seeded requests → exactly 2 Alpha→Sink hops. The C++ echo block
      // would produce 4; only the SV decimator produces 2.
      const alphaHops = trace.hops.filter((h) => h.from === 'U.Alpha' && h.to === 'U.Sink');
      expect(alphaHops).toHaveLength(2);
      // Token attribution: distinct tokens from the input FIFO, not one
      // smeared token.
      expect(new Set(alphaHops.map((h) => h.token)).size).toBe(2);
      // The run was honest about what executed.
      expect(log.some((l) => l.includes('execute their SystemVerilog twin'))).toBe(true);

      // Waves: the adapter dumped a real VCD with the twin's port signals.
      const vcdFile = path.join(root, 'build', 'waves', 'U_Alpha.vcd');
      expect(fs.existsSync(vcdFile)).toBe(true);
      const doc = parseVcd(fs.readFileSync(vcdFile, 'utf8'), 'U.Alpha');
      expect(doc.maxTime).toBeGreaterThan(0);
      const names = doc.signals.map((s) => s.name);
      expect(names.some((n) => n.endsWith('ReqEvent_valid'))).toBe(true);
      expect(names.some((n) => n.endsWith('out_valid'))).toBe(true);
    },
  );
});
