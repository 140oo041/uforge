// SV↔C++ divergence checking (opt-in). Unit tests pin the generated shadow /
// capture / compare code and the intent + provenance plumbing; the e2es are
// the proof: a twin that deliberately differs from its C++ block produces
// 'cosim' divergences with the right tokens, and a twin that matches
// produces none.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPTY_MODEL, type AuthoringModel, type EditIntent } from '@iss/contracts/model';
import { EMPTY_GRAPH } from '@iss/contracts/graph';
import { applyIntent } from '@iss/host/writer/edits';
import { checkedLeaves, writeHarness, writeModel } from '@iss/host/writer/index';
import { emitHarness } from '@iss/host/writer/harness';
import { emitSvAdapters } from '@iss/host/writer/svadapter';
import { END_MARKER } from '@iss/host/writer/markers';
import { parseProject } from '@iss/host/parser/index';
import { parseTrace } from '@iss/host/trace/parse';
import { simulate } from '@iss/host/project/run';

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

const CHECKED = new Set(['U.Alpha']);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-cosimcheck-'));

// Deliberately differs from the C++ block (which answers EVERY request with
// value 0): emits on every 2nd request only, value = addr + 1.
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
  '                out_valid <= parity;',
  "                out_value <= ReqEvent_addr + 32'd1;",
  '            end',
  '        end',
  '    end',
  '',
  'endmodule',
  '',
].join('\n');

// Matches the C++ block exactly: one RespEvent per request, value 0.
const ECHO_BODY = [
  '',
  '    always_ff @(posedge clk) begin',
  '        if (rst) begin',
  "            out_valid <= 1'b0;",
  "            out_value <= '0;",
  '        end else begin',
  '            out_valid <= ReqEvent_valid;',
  "            out_value <= '0;",
  '        end',
  '    end',
  '',
  'endmodule',
  '',
].join('\n');

describe('setCheckDivergence intent', () => {
  it('sets, clears, and guards to leaves', () => {
    let m = cosimModel();
    m = applyIntent(m, { kind: 'setCheckDivergence', id: 'U.Alpha', enabled: true });
    expect(m.components.find((c) => c.id === 'U.Alpha')?.checkDivergence).toBe(true);
    m = applyIntent(m, { kind: 'setCheckDivergence', id: 'U.Alpha', enabled: false });
    expect(m.components.find((c) => c.id === 'U.Alpha')?.checkDivergence).toBeUndefined();
    expect(() =>
      applyIntent(m, { kind: 'setCheckDivergence', id: 'Nope', enabled: true }),
    ).toThrow();
  });

  it('checkedLeaves: per-block flag OR the run-config master switch', () => {
    const base = cosimModel();
    expect(checkedLeaves(base)).toEqual(new Set());
    const flagged = applyIntent(base, {
      kind: 'setCheckDivergence',
      id: 'U.Alpha',
      enabled: true,
    });
    expect(checkedLeaves(flagged)).toEqual(new Set(['U.Alpha']));
    const cfg = {
      entries: [],
      tokens: 8,
      cycles: 64,
      wavesEnabled: true,
      checkDivergence: true,
    };
    expect(checkedLeaves(base, cfg)).toEqual(new Set(['U.Alpha']));
    // The master switch only covers SV leaves — Sink (cpp) is never checked.
    expect(checkedLeaves(base, cfg).has('Sink')).toBe(false);
  });
});

describe('checked adapter emission', () => {
  it('shadow block, diverted capture links, per-field compare, dtor flush', () => {
    const text = emitSvAdapters(cosimModel(), { checked: CHECKED });
    // The C++ block instance + a capture link the shadow sends through.
    expect(text).toContain('U::Alpha shadow_;');
    expect(text).toContain('microarch::Link cap_out_;');
    expect(text).toContain('cap_out_.configureOut(&shadow_);');
    expect(text).toContain('cap_out_.divert(');
    // Every input event is replayed into the shadow during Dispatch.
    expect(text).toContain('shadow_.handler(ev);');
    // Generator-known per-field comparison, tagged "cosim".
    expect(text).toContain('check_out(*ev, token);');
    expect(text).toContain('"out: sv emitted RespEvent; c++ did not", "cosim"');
    expect(text).toContain('"out.value: sv="');
    // Dtor flush for tokens the twin never answered.
    expect(text).toContain('"out: c++ emitted RespEvent; sv never did", "cosim"');
  });

  it('unchecked adapters carry none of the shadow surface', () => {
    const text = emitSvAdapters(cosimModel());
    expect(text).not.toContain('shadow_');
    expect(text).not.toContain('divert');
    expect(text).not.toContain('cosim');
  });
});

describe('harness with checked sv leaves', () => {
  it('re-includes the .cpp and passes the scheduler to the adapter', () => {
    const text = emitHarness(cosimModel(), { checked: CHECKED });
    expect(text).toContain('#include "U/Alpha.cpp"');
    expect(text).toContain('SvImpl_U_Alpha s_U_Alpha(scheduler, &link_U_Alpha_out);');
  });

  it('unchecked sv leaves keep the old shape', () => {
    const text = emitHarness(cosimModel());
    expect(text).not.toContain('#include "U/Alpha.cpp"');
    expect(text).toContain('SvImpl_U_Alpha s_U_Alpha(&link_U_Alpha_out);');
  });
});

describe('divergence provenance parsing', () => {
  it('kind:"cosim" → provenance cosim; absent kind stays architectural', () => {
    const jsonl = [
      '{"diverge":true,"cycle":4,"component":"U.Alpha","token":1,"detail":"out.value: sv=2 != cpp=3","kind":"cosim"}',
      '{"diverge":true,"cycle":5,"component":"EX","token":0,"detail":"x5 mismatch"}',
    ].join('\n');
    const trace = parseTrace(jsonl, EMPTY_GRAPH);
    expect(trace.divergences).toHaveLength(2);
    expect(trace.divergences[0].provenance).toBe('cosim');
    expect(trace.divergences[1].provenance).toBe('architectural');
  });
});

async function runProject(root: string, model: AuthoringModel, svBody: string) {
  writeModel(root, model);
  const svFile = path.join(root, 'src', 'U', 'Alpha.sv');
  const generated = fs.readFileSync(svFile, 'utf8');
  const cut = generated.indexOf(END_MARKER) + END_MARKER.length;
  fs.writeFileSync(svFile, generated.slice(0, cut) + '\n' + svBody);
  writeHarness(root, model, {
    entries: [{ block: 'U.Alpha', event: 'ReqEvent' }],
    tokens: 4,
    cycles: 32,
    wavesEnabled: false,
    checkDivergence: true,
  });
  const graph = parseProject([root]);
  return simulate(
    { projectRoot: root, enginePath: ENGINE, refModel: 'stub', log: () => {} },
    graph,
    [{ id: 'U.Alpha', svFile: path.join('src', 'U', 'Alpha.sv') }],
  );
}

describe('e2e: divergence check', () => {
  it(
    'a twin that differs from its C++ block produces cosim divergences',
    { timeout: 300_000 },
    async () => {
      const trace = await runProject(tmp(), cosimModel(), HALVER_BODY);
      const cosim = trace.divergences.filter((d) => d.provenance === 'cosim');
      expect(cosim.length).toBeGreaterThan(0);
      expect(cosim.every((d) => d.component === 'U.Alpha')).toBe(true);
      // The twin's value (addr+1 = 1) disagrees with the C++ default (0)…
      expect(cosim.some((d) => d.detail.includes('out.value: sv=1 != cpp=0'))).toBe(true);
      // …and the decimated tokens are flushed as never answered.
      expect(
        cosim.some((d) => d.detail.includes('c++ emitted RespEvent; sv never did')),
      ).toBe(true);
    },
  );

  it(
    'a twin that matches its C++ block produces zero divergences',
    { timeout: 300_000 },
    async () => {
      const trace = await runProject(tmp(), cosimModel(), ECHO_BODY);
      expect(trace.divergences).toEqual([]);
      // Sanity: the twin really ran and answered all 4 requests.
      expect(trace.hops.filter((h) => h.from === 'U.Alpha' && h.to === 'U.Sink')).toHaveLength(4);
    },
  );
});
