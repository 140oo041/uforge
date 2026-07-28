// Router source emission. Every authored router gets src/<R>.cpp — a real
// component file, like leaf blocks: the GENERATED marker region opens a
// subclass of microarch::Router (ctor + the flat default model); the class
// stays OPEN across the END marker and the hand-owned tail below it holds
// user-written latency models plus the closing brace — exactly the SV-twin
// trick, so custom models survive regeneration.
//
// A latency model is any member function of the shape
//     microarch::Cycle name(const microarch::Event& event)
// The parser surfaces them (GraphComponent.latencyModels) and the inspector
// assigns one per fabric-routed wire; the harness binds it with
// setRouteLatency. Wires without a model use the flat constant.

import { DEFAULT_BANDWIDTH_BITS } from '@iss/contracts/bits';
import type { AuthoredComponent, AuthoringModel } from '@iss/contracts/model';
import { descendantsOf, findComponent } from '@iss/contracts/model';

/** src-relative file for a router (routers are top-level: no directories). */
export function routerFileFor(id: string): string {
  return id + '.cpp';
}

export const ROUTER_PROLOGUE = [
  '#pragma once',
  '',
  '#include "microarch/engine.hpp"',
  '#include "iss_events.h"',
  '',
  '',
].join('\n');

/** Engine calls configuring one router's non-default arbitration, bandwidth
 *  and queue bound. Per-attachment weights/priorities expand to one call per
 *  contained leaf — packet origins are leaf ids, so a composite attachment
 *  covers every leaf under it. Deterministic (sorted) for stable diffs. */
function configLines(comp: AuthoredComponent, model: AuthoringModel): string[] {
  const lines: string[] = [];
  const arbitration = comp.arbitration ?? 'fifo';
  if (arbitration !== 'fifo') {
    const name = { roundrobin: 'RoundRobin', priority: 'FixedPriority', weighted: 'Weighted' }[
      arbitration
    ];
    lines.push(`setArbitration(Arbitration::${name});`);
  }
  if (comp.portBandwidthBits !== undefined && comp.portBandwidthBits !== DEFAULT_BANDWIDTH_BITS)
    lines.push(`setBandwidth(${comp.portBandwidthBits});  // bits per port per cycle`);
  if (comp.queueCapacity !== undefined) {
    lines.push(`setQueueCapacity(${comp.queueCapacity});`);
    if ((comp.fullPolicy ?? 'stall') === 'drop') lines.push('setFullPolicy(FullPolicy::Drop);');
  }
  const leavesUnder = (id: string): string[] => {
    const root = findComponent(model, id);
    if (!root) return [];
    if (root.kind === 'leaf') return [root.id];
    return descendantsOf(model, id)
      .filter((c) => c.kind === 'leaf')
      .map((c) => c.id);
  };
  for (const attachment of Object.keys(comp.attachmentPolicy ?? {}).sort()) {
    const policy = comp.attachmentPolicy![attachment];
    for (const leaf of leavesUnder(attachment).sort()) {
      if (policy.weight !== undefined) lines.push(`setSourceWeight("${leaf}", ${policy.weight});`);
      if (policy.priority !== undefined)
        lines.push(`setSourcePriority("${leaf}", ${policy.priority});`);
    }
  }
  return lines;
}

/** The generated marker-region body: class header, ctor (with any
 *  non-default arbitration/bandwidth/queue configuration), flat default. */
export function emitRouterBody(comp: AuthoredComponent, model: AuthoringModel): string {
  const latency = comp.routerLatency ?? 1;
  const config = configLines(comp, model);
  const ctor =
    config.length === 0
      ? [
          `    explicit ${comp.id}(microarch::Scheduler& scheduler)`,
          `        : microarch::Router("${comp.id}", scheduler, ${latency}) {}`,
        ]
      : [
          `    explicit ${comp.id}(microarch::Scheduler& scheduler)`,
          `        : microarch::Router("${comp.id}", scheduler, ${latency}) {`,
          ...config.map((line) => `        ${line}`),
          '    }',
        ];
  return [
    `class ${comp.id} : public microarch::Router {`,
    '  public:',
    ...ctor,
    '',
    '    // The default: every route without an assigned model forwards in a',
    '    // flat constant number of cycles (the latency in the inspector).',
    `    microarch::Cycle flat(const microarch::Event&) const { return ${latency}; }`,
  ].join('\n');
}

/** Fresh hand-owned tail (below the END marker): docs + the closing brace. */
export function routerTailFor(comp: AuthoredComponent): string {
  return [
    '',
    '    // Hand-written latency models live here and survive regeneration.',
    '    // Each model is a member function returning cycles for one packet:',
    '    //',
    '    //     microarch::Cycle congested(const microarch::Event& event) {',
    '    //         return event.token % 4 == 0 ? 6 : 2;',
    '    //     }',
    '    //',
    `    // Assign a model to a routed wire in the inspector (wire panel of a`,
    `    // connection riding ${comp.id}); unassigned wires use flat().`,
    '',
    '};',
    '',
  ].join('\n');
}
