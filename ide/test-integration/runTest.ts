// Real-VS-Code integration smoke: downloads a Linux VS Code build, boots an
// Extension Development Host on a generated fixture workspace, and runs
// suite.js inside it (executes iss2.runSimulation for real — g++, verilator,
// the engine, the works — then asserts the artifacts). Run with:
//
//   npx tsx test-integration/runTest.ts        (xvfb-run -a if no display)
//
// The fixture exercises all three v7 features at once: an SV-impl block with
// waves + divergence check on, fabric-routed through a router.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

import { EMPTY_MODEL, type AuthoringModel, type EditIntent } from '../src/shared/model';
import { applyIntent } from '../src/writer/edits';
import { writeModel } from '../src/writer';
import { END_MARKER } from '../src/writer/markers';
import { saveRunConfig } from '../src/host/runFile';

// The SV twin deliberately differs from the C++ echo (emits every 2nd
// request, value = addr + 1) so cosim divergences are guaranteed.
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

function buildFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-inthost-'));
  const intents: EditIntent[] = [
    { kind: 'addComponent', id: 'A' },
    { kind: 'addComponent', id: 'B' },
    { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
    { kind: 'addEvent', id: 'ReqEvent', fields: [{ name: 'addr', type: 'uint32_t' }] },
    { kind: 'addEvent', id: 'RespEvent', fields: [{ name: 'value', type: 'uint32_t' }] },
    { kind: 'addWire', from: 'A', port: 'out', message: 'RespEvent', to: 'B', latency: 1 },
    { kind: 'setConsumes', id: 'A', consumes: ['ReqEvent'] },
    { kind: 'setImpl', id: 'A', impl: 'sv' },
    { kind: 'setCheckDivergence', id: 'A', enabled: true },
    { kind: 'attachRouter', id: 'A', router: 'R0' },
    { kind: 'attachRouter', id: 'B', router: 'R0' },
  ];
  const model: AuthoringModel = intents.reduce(applyIntent, EMPTY_MODEL);
  writeModel(root, model);

  // Give the twin its divergent behavior (below the generated markers).
  const svFile = path.join(root, 'src', 'A.sv');
  const generated = fs.readFileSync(svFile, 'utf8');
  const cut = generated.indexOf(END_MARKER) + END_MARKER.length;
  fs.writeFileSync(svFile, generated.slice(0, cut) + '\n' + HALVER_BODY);

  saveRunConfig(root, {
    entries: [{ block: 'A', event: 'ReqEvent' }],
    tokens: 4,
    cycles: 32,
    wavesEnabled: true,
    checkDivergence: true,
  });
  return root;
}

async function main() {
  const fixture = buildFixture();
  console.log('[runTest] fixture workspace:', fixture);
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite.js');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        fixture,
        '--disable-gpu',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: { ISS2_FIXTURE: fixture },
    });
    console.log('[runTest] PASS');
  } catch (err) {
    console.error('[runTest] FAIL:', err);
    process.exit(1);
  }
}

main();
