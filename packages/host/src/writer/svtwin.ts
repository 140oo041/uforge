// SystemVerilog twin emission. Every authored leaf gets src/<path>/<Leaf>.sv
// alongside its .cpp: the GENERATED marker region holds the module header +
// port list (derived from the block's event interface — one valid strobe per
// consumed event / out-port, plus one signal per event field); the behavioral
// body below the markers is hand-written and survives regeneration, exactly
// like hand edits in .cpp blocks. When a block's impl is 'sv', Run verilates
// this twin and executes it through a generated co-sim adapter (svadapter.ts).

import * as path from 'path';

import { leafName, type AuthoredComponent, type AuthoringModel } from '@iss/contracts/model';
import type { SpecDocument } from '@iss/contracts/spec';

/** src-relative twin file for a leaf block: dot-path → directories. */
export function svFileFor(id: string): string {
  return path.join(...id.split('.')) + '.sv';
}

/** C++/spec type → SV net declaration ("logic" or "logic [N-1:0]"). */
export function svType(type: string, spec?: SpecDocument | null): string {
  let t = type.trim();
  for (let hops = 0; spec && hops < 8; hops++) {
    const alias = (spec.types ?? []).find((a) => a.name === t);
    if (!alias) break;
    t = alias.base.trim();
  }
  const signal = spec?.signals?.find((s) => s.name === t);
  if (signal) {
    const width = Math.max(1, Math.ceil(Math.log2(Math.max(2, signal.values.length))));
    return width === 1 ? `logic /* ${t} */` : `logic [${width - 1}:0] /* ${t} */`;
  }
  const sized = /^(std::)?(u)?int(\d+)_t$/.exec(t);
  if (sized) {
    const bits = Number(sized[3]);
    return bits === 1 ? 'logic' : `logic [${bits - 1}:0]`;
  }
  if (t === 'bool') return 'logic';
  if (['int', 'unsigned', 'long', 'size_t'].includes(t)) return 'logic [31:0]';
  return 'logic [31:0] /* TODO width for ' + t + ' */';
}

/** The marker-region body: module header + derived port list (no endmodule —
 *  the hand-editable body below the markers closes the module). */
export function emitSvTwinBody(
  comp: AuthoredComponent,
  model: AuthoringModel,
  spec?: SpecDocument | null,
): string {
  const fieldsOf = (event: string) => model.events.find((e) => e.id === event)?.fields ?? [];
  const ports: string[] = ['    input  logic clk,', '    input  logic rst,'];

  for (const message of comp.consumes) {
    ports.push(`    // in: ${message}`);
    ports.push(`    input  logic ${message}_valid,`);
    for (const f of fieldsOf(message))
      ports.push(`    input  ${svType(f.type, spec)} ${message}_${f.name},`);
  }
  for (const p of comp.outPorts) {
    ports.push(`    // out ${p.name}: ${p.message}${p.to ? ` → ${p.to}` : ''}`);
    ports.push(`    output logic ${p.name}_valid,`);
    for (const f of fieldsOf(p.message))
      ports.push(`    output ${svType(f.type, spec)} ${p.name}_${f.name},`);
  }
  // Strip the trailing comma off the final port line (comments excluded).
  for (let i = ports.length - 1; i >= 0; i--) {
    if (ports[i].trimStart().startsWith('//')) continue;
    ports[i] = ports[i].replace(/,$/, '');
    break;
  }

  // A fresh skeleton legitimately hasn't used its inputs yet — waive
  // UNUSEDSIGNAL for the generated port list only (hand code below the
  // markers still gets the full -Wall treatment).
  return [
    `module ${leafName(comp.id)} (`,
    '    /* verilator lint_off UNUSEDSIGNAL */',
    ...ports,
    '    /* verilator lint_on UNUSEDSIGNAL */',
    ');',
  ].join('\n');
}

/** Prologue above the marker region of a fresh twin. */
export const SV_PROLOGUE = [
  '// SystemVerilog twin — the co-simulation contract for this block.',
  '// Ports mirror the block’s event interface; write the behavior below the',
  '// generated region (hand edits there survive regeneration).',
  '',
].join('\n');

/** Initial hand-editable body + endmodule for a fresh twin: every output is
 *  driven (placeholder zeros) so a brand-new skeleton lints clean under
 *  -Wall — warnings appear only once real behavior is being written. */
export function svTailFor(comp: AuthoredComponent, model: AuthoringModel): string {
  const fieldsOf = (event: string) => model.events.find((e) => e.id === event)?.fields ?? [];
  const drives: string[] = [];
  for (const p of comp.outPorts) {
    drives.push(`            ${p.name}_valid <= 1'b0;`);
    for (const f of fieldsOf(p.message)) drives.push(`            ${p.name}_${f.name} <= '0;`);
  }
  return [
    '',
    '    // TODO: behavioral twin of the C++ block. Replace the placeholder',
    '    // drives with real behavior; this body survives regeneration.',
    '    always_ff @(posedge clk) begin',
    '        if (rst) begin',
    ...drives,
    '        end',
    '    end',
    '',
    'endmodule',
    '',
  ].join('\n');
}
