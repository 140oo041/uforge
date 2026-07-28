// Run-harness generator: AuthoringModel → a complete main() that builds the
// design against the micro_arch_ide2 engine, wires every drawn connection via
// the Registry, installs the JSONL hop/divergence trace sinks, seeds entry
// tokens, and runs. The whole file is generated (marker-wrapped).
//
// Blocks are single-file inline classes guarded by #pragma once, so the
// harness includes the .cpp directly ("CPU0/IF.cpp") and instantiates the
// qualified type (CPU0::IF). Only leaves are instantiated; composites are
// namespaces.

import { deriveFabric } from '@iss/contracts/fabric';
import type { AuthoredComponent, AuthoringModel } from '@iss/contracts/model';
import type { SeedSpec } from '@iss/contracts/runConfig';
import { BEGIN_MARKER, END_MARKER } from './markers';
import { SV_ADAPTERS_FILE, svAdapterOf } from './svadapter';

export const HARNESS_FILE = 'iss_main_gen.cpp';

const includeOf = (id: string): string => id.split('.').join('/') + '.cpp';
const typeOf = (id: string): string => id.split('.').join('::');
const instanceOf = (id: string): string => 's_' + id.split('.').join('_');
const linkOf = (id: string, port: string): string =>
  'link_' + id.split('.').join('_') + '_' + port;
const routerOf = (id: string): string => 'r_' + id;

function entryLeaves(
  leaves: AuthoredComponent[],
  ruleDestLeaves: Set<string>,
): AuthoredComponent[] {
  // Traffic generators are never seed targets: they are clocked and mint
  // their own tokens — seeding one would double-drive it.
  const candidates = leaves.filter((c) => c.role !== 'trafficgen');
  const targets = new Set<string>(ruleDestLeaves);
  for (const c of leaves) for (const p of c.outPorts) if (p.to) targets.add(p.to);
  const entries = candidates.filter((c) => !targets.has(c.id));
  if (entries.length > 0) return entries;
  // Every candidate is downstream of something. With a generator in the
  // design the traffic is already driven — don't force-seed a consumer.
  if (candidates.length !== leaves.length) return [];
  return candidates.slice(0, 1);
}

export function emitHarness(
  model: AuthoringModel,
  opts?: { tokens?: number; cycles?: number; entries?: SeedSpec[]; checked?: Set<string> },
): string {
  const tokens = opts?.tokens ?? 8;
  const cycles = opts?.cycles ?? 64;
  const leaves = model.components
    .filter((c) => c.kind === 'leaf')
    .sort((a, b) => a.id.localeCompare(b.id));
  const isSv = (c: AuthoredComponent) => c.impl === 'sv';
  const svLeaves = leaves.filter(isSv);
  // Divergence-checked sv leaves: their adapter runs the C++ block in shadow,
  // so the .cpp comes back into the build and the adapter takes the scheduler.
  const checked = opts?.checked ?? new Set<string>();
  const isChecked = (c: AuthoredComponent) => isSv(c) && checked.has(c.id);
  const fabric = deriveFabric(model);
  const lines: string[] = [];

  lines.push('#include <cstdlib>');
  lines.push('#include <fstream>');
  lines.push('#include <iostream>');
  lines.push('#include <memory>');
  lines.push('');
  lines.push('#include "microarch/engine.hpp"');
  // sv-impl blocks skip their .cpp: the Verilated twin executes instead
  // (the adapter header is generated into build/ alongside the model).
  for (const c of leaves) {
    if (isChecked(c))
      lines.push(`#include "${includeOf(c.id)}"  // SV twin executes; C++ runs in shadow (divergence check)`);
    else if (isSv(c))
      lines.push(`// ${includeOf(c.id)} — SV twin executes (see ${SV_ADAPTERS_FILE})`);
    else lines.push(`#include "${includeOf(c.id)}"`);
  }
  for (const r of fabric.routers)
    lines.push(`#include "${includeOf(r.id)}"  // fabric router (latency models live here)`);
  lines.push('#include "iss_events.h"');
  if (svLeaves.length > 0) lines.push(`#include "${SV_ADAPTERS_FILE}"`);
  lines.push('');
  lines.push(BEGIN_MARKER);
  lines.push('int main(int argc, char** argv) {');
  lines.push(
    `    const uint64_t maxCycles = argc > 1 ? std::strtoull(argv[1], nullptr, 10) : ${cycles};`,
  );
  lines.push('    std::ofstream traceFile("iss_trace.jsonl");');
  lines.push('    microarch::Scheduler scheduler;');
  lines.push('    microarch::JsonlTraceWriter trace(traceFile);');
  lines.push('    scheduler.setHopSink(trace.hopSink());');
  lines.push('    scheduler.setDivergenceSink(trace.divergenceSink());');
  lines.push('    scheduler.setMetricSink(trace.metricSink());');
  lines.push('');
  if (fabric.routers.length > 0) {
    lines.push('    // Fabric routers — instances of their generated src/<R>.cpp classes');
    lines.push('    // (clocked: each tick forwards what the port\'s bit budget pays for).');
    for (const r of fabric.routers) {
      lines.push(`    ${r.id} ${routerOf(r.id)}(scheduler);`);
      lines.push(`    scheduler.addClocked(${routerOf(r.id)});`);
    }
    lines.push('');
  }
  lines.push('    // One link per authored out-port.');
  for (const c of leaves)
    for (const p of c.outPorts)
      lines.push(`    microarch::Link ${linkOf(c.id, p.name)}(scheduler, ${p.latency ?? 1});`);
  lines.push('');
  lines.push('    // Blocks receive their out-links positionally (writer ctor order).');
  lines.push('    // sv-impl blocks instantiate their co-sim adapter, not the C++ class.');
  for (const c of leaves) {
    const portArgs = c.outPorts.map((p) => `&${linkOf(c.id, p.name)}`);
    // Checked adapters and traffic generators take the scheduler first
    // (adapters for capture + reporting, generators for token minting).
    const takesScheduler = isChecked(c) || c.role === 'trafficgen';
    const args = (takesScheduler ? ['scheduler', ...portArgs] : portArgs).join(', ');
    const type = isSv(c) ? svAdapterOf(c.id) : typeOf(c.id);
    // No args → no parens (a `WB s_WB();` would be a function declaration).
    lines.push(
      args
        ? `    ${type} ${instanceOf(c.id)}(${args});`
        : `    ${type} ${instanceOf(c.id)};`,
    );
  }
  lines.push('');
  lines.push('    // Registry + per-block wire(): every drawn connection, in code.');
  lines.push('    microarch::Registry registry;');
  for (const c of leaves) lines.push(`    registry.add("${c.id}", ${instanceOf(c.id)});`);
  for (const c of leaves) lines.push(`    ${instanceOf(c.id)}.wire(registry);`);
  const crossTop = fabric.diagnostics.filter((d) => d.kind === 'crossTopWire');
  if (fabric.ruleRoutes.length > 0 || fabric.ingress.length > 0 || crossTop.length > 0) {
    lines.push('');
    lines.push('    // Fabric transport: inter-composite dataflow is authored as ordered');
    lines.push("    // forwarding rules on the routers. A fabric-bound port enters its top's");
    lines.push('    // attachment router destination-less; the ingress router matches');
    lines.push('    // (message type, address) in rule order, stamps the destination, and');
    lines.push('    // the dest-keyed hop tables carry it. Unmatched packets drop + report.');
    // Ordered match rules, per router in authored-rule order (an any-message
    // rule expands to one line per statically-known message, contiguous).
    for (const r of fabric.routers)
      for (const rr of fabric.ruleRoutes.filter((x) => x.router === r.id)) {
        const lo = `${rr.addrLo ?? '0x0'}ULL`;
        const hi = `${rr.addrHi ?? '0xffffffffffffffff'}ULL`;
        const range =
          rr.addrLo !== undefined || rr.addrHi !== undefined
            ? ` [${rr.addrLo ?? '0x0'}..${rr.addrHi ?? 'max'}]`
            : '';
        lines.push(
          `    ${routerOf(r.id)}.addMatchRule("${rr.message}", ${lo}, ${hi}, "${rr.destLeaf}");` +
            `  // rule ${rr.ruleIndex + 1}: ${rr.message}${range} -> ${rr.destTop}`,
        );
      }
    // Dest-keyed hop tables + per-destination latency models along each path.
    const routeLines = new Set<string>();
    for (const route of fabric.ruleRoutes) {
      for (let i = 0; i < route.path.length; i++) {
        const next =
          i + 1 < route.path.length
            ? routerOf(route.path[i + 1])
            : instanceOf(route.destLeaf);
        routeLines.add(`    ${routerOf(route.path[i])}.addRoute("${route.destLeaf}", ${next});`);
        if (route.model)
          routeLines.add(
            `    ${routerOf(route.path[i])}.setRouteLatency("${route.destLeaf}", ` +
              `[&](const microarch::Event& ev) { return ${routerOf(route.path[i])}.${route.model}(ev); });` +
              `  // latency model: ${route.model}`,
          );
      }
    }
    for (const line of [...routeLines].sort()) lines.push(line);
    // Fabric ingress: every fabric-bound port enters its attachment router.
    for (const b of fabric.ingress)
      lines.push(
        `    ${linkOf(b.from, b.port)}.routeVia(${routerOf(b.router)});` +
          `  // fabric ingress: ${b.from}.${b.port} (${b.message}) -> ${b.router}` +
          (b.matched ? '' : ' — no matching rule: packets drop + report'),
      );
    // Cross-top wires are design errors. They still deliver point-to-point so
    // a half-edited design stays buildable, but the IDE refuses to Run.
    for (const d of crossTop)
      lines.push(`    // FABRIC ERROR: ${d.detail} — the IDE will not Run this design.`);
  }
  if (svLeaves.length > 0) {
    lines.push('');
    lines.push('    // Verilated twins are clocked: tick() drives their clk each cycle.');
    for (const c of svLeaves) lines.push(`    scheduler.addClocked(${instanceOf(c.id)});`);
  }
  const gens = leaves.filter((c) => c.role === 'trafficgen');
  if (gens.length > 0) {
    lines.push('');
    lines.push('    // Traffic generators are clocked: tick() originates their packets.');
    for (const c of gens) lines.push(`    scheduler.addClocked(${instanceOf(c.id)});`);
  }
  lines.push('');
  // Entry points: the run config's explicit entries when set (iss_run.json),
  // otherwise the auto heuristic (leaves nobody sends to).
  const manual = opts?.entries ?? [];
  const seeds: Array<{ comp: AuthoredComponent; event: string | null }> =
    manual.length > 0
      ? manual.flatMap((s) => {
          const comp = leaves.find((c) => c.id === s.block);
          if (!comp) {
            lines.push(`    // run-config entry '${s.block}' not found — skipped.`);
            return [];
          }
          if (comp.role === 'trafficgen') {
            lines.push(
              `    // run-config entry '${s.block}' is a traffic generator (self-driving) — skipped.`,
            );
            return [];
          }
          return [{ comp, event: s.event }];
        })
      : entryLeaves(leaves, new Set(fabric.ruleRoutes.map((r) => r.destLeaf))).map((comp) => ({
          comp,
          event: null,
        }));
  lines.push(
    `    // Seed ${tokens} tokens, one per cycle, into the entry block(s)` +
      `${manual.length > 0 ? ' (from iss_run.json)' : ' (auto-detected)'}.`,
  );
  for (const { comp, event } of seeds) {
    const seedEvent =
      event && model.events.some((e) => e.id === event) ? event : comp.consumes[0];
    const make = seedEvent
      ? `std::make_unique<${seedEvent}>()`
      : `std::make_unique<microarch::Event>("Event")`;
    lines.push(`    for (uint64_t c = 0; c < ${tokens}; ++c)`);
    lines.push(`        scheduler.seed(${make}, ${instanceOf(comp.id)}, c);`);
  }
  lines.push('');
  lines.push('    scheduler.runFor(maxCycles);');
  for (const r of fabric.routers) {
    lines.push(`    if (${routerOf(r.id)}.pendingCount() > 0)`);
    lines.push(
      `        std::cout << "router ${r.id}: " << ${routerOf(r.id)}.pendingCount()` +
        ' << " event(s) still queued at clock stop\\n";',
    );
  }
  lines.push(
    '    std::cout << "ran " << scheduler.currentCycle() << " cycles; trace: iss_trace.jsonl\\n";',
  );
  lines.push('    return 0;');
  lines.push('}');
  lines.push(END_MARKER);
  lines.push('');
  return lines.join('\n');
}
