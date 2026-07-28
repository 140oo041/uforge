// Traffic-generator C++ emission. A generator is an ordinary leaf to the
// parser (class <G> : public Component, Link* ports, Tier-1 wires), but its
// behavior is a clocked tick() that ORIGINATES packets: it takes the
// Scheduler first (the checked-adapter precedent), mints a fresh token per
// packet (tick-phase sends have no in-flight token to inherit), and sends
// through its ordinary out-port Links so hop records, fabric routing and
// latency all apply unchanged.
//
// Two ownership modes (AuthoredComponent.trafficMode):
//  - 'generated' (default): the whole body lives inside the markers and is
//    regenerated from TrafficParams on every edit.
//  - 'custom': the file switches to the router/SV-twin head+tail layout —
//    the generated head (markers) owns everything structural, and tick()
//    below the END marker is hand-owned and survives regeneration. The tail
//    is seeded with the current generated tick() at detach time, so behavior
//    starts unchanged and the user edits from a working template.

import {
  DEFAULT_TRAFFIC,
  leafName,
  type AuthoredComponent,
  type AuthoringModel,
} from '@iss/contracts/model';
import { type SpecDocument } from '@iss/contracts/spec';
import { defaultFor } from './blockfile';

/** Prologue for a generator .cpp — the leaf-block shims (unqualified
 *  Component/Event/Link, matching the generated class body) plus the
 *  Scheduler for tick()/mintToken(). Self-contained: a gen may be the FIRST
 *  leaf the harness includes, so it cannot lean on another block's includes. */
export const TRAFFIC_PROLOGUE = [
  '#pragma once',
  '',
  '#include <cstring>',
  '#include <memory>',
  '',
  '#include "infra/component.h"',
  '#include "infra/event.h"',
  '#include "infra/link.h"',
  '#include "iss_events.h"',
  '#include "microarch/registry.hpp"',
  '#include "microarch/scheduler.hpp"',
  '',
  '',
].join('\n');

/** The generated tick() body — also the seed for a fresh hand-owned tail. */
export function emitTrafficTick(comp: AuthoredComponent, indent = '    '): string {
  const t = comp.traffic ?? DEFAULT_TRAFFIC;
  const ports = comp.outPorts;
  const lines: string[] = [];
  lines.push(`${indent}void tick(microarch::Cycle cycle) override {`);
  if (ports.length === 0) {
    lines.push(`${indent}    (void)cycle;  // no out-ports yet — draw a wire to generate`);
    lines.push(`${indent}}`);
    return lines.join('\n');
  }
  lines.push(`${indent}    if (cycle < ${t.start}) return;`);
  if (t.count > 0) lines.push(`${indent}    if (sent_ >= ${t.count}) return;`);
  if (t.period > 1) lines.push(`${indent}    if ((cycle - ${t.start}) % ${t.period} != 0) return;`);
  lines.push(`${indent}    for (uint64_t b = 0; b < ${t.burst}; ++b) {`);
  if (t.count > 0) lines.push(`${indent}        if (sent_ >= ${t.count}) break;`);
  // Destination pick among the block's out-ports, in authored order.
  if (t.pattern === 'random') {
    lines.push(`${indent}        lfsr_ ^= lfsr_ << 13;`);
    lines.push(`${indent}        lfsr_ ^= lfsr_ >> 7;`);
    lines.push(`${indent}        lfsr_ ^= lfsr_ << 17;`);
    lines.push(`${indent}        const uint64_t pick = lfsr_ % ${ports.length};`);
  } else if (t.pattern === 'roundrobin') {
    lines.push(`${indent}        const uint64_t pick = rr_++ % ${ports.length};`);
  } else {
    lines.push(`${indent}        const uint64_t pick = 0;  // fixed: always the first port`);
  }
  // Per-packet address within [addrLo, addrHi]. span 0 == the full 2^64
  // range. The extra lfsr advance keeps the address decorrelated from a
  // 'random' destination pick.
  const wantsAddr =
    t.addrPattern !== undefined && t.addrLo !== undefined && t.addrHi !== undefined;
  if (wantsAddr) {
    const lo = BigInt(t.addrLo!);
    const span = BigInt(t.addrHi!) - lo + 1n;
    const spanLiteral = span <= 0xffffffffffffffffn ? `0x${span.toString(16)}ULL` : '0ULL';
    lines.push(
      `${indent}        // address emission: ${t.addrPattern} in [${t.addrLo}, ${t.addrHi}]`,
    );
    if (t.addrPattern === 'random') {
      lines.push(`${indent}        lfsr_ ^= lfsr_ << 13;`);
      lines.push(`${indent}        lfsr_ ^= lfsr_ >> 7;`);
      lines.push(`${indent}        lfsr_ ^= lfsr_ << 17;`);
      lines.push(
        `${indent}        const uint64_t iss_addr = ${t.addrLo}ULL + ` +
          `(${spanLiteral} ? (lfsr_ % ${spanLiteral}) : lfsr_);`,
      );
    } else {
      lines.push(
        `${indent}        const uint64_t iss_addr = ${t.addrLo}ULL + ` +
          `(${spanLiteral} ? (addrSeq_ % ${spanLiteral}) : addrSeq_);`,
      );
      lines.push(`${indent}        ++addrSeq_;`);
    }
  }
  ports.forEach((p, i) => {
    lines.push(`${indent}        if (pick == ${i} && ${p.name} && ${p.name}->connected()) {`);
    lines.push(`${indent}            auto ev_${p.name} = std::make_unique<${p.message}>();`);
    lines.push(`${indent}            ev_${p.name}->token = scheduler_.mintToken();`);
    if (wantsAddr) lines.push(`${indent}            ev_${p.name}->addr = iss_addr;`);
    lines.push(`${indent}            ${p.name}->send(std::move(ev_${p.name}));`);
    lines.push(`${indent}            ++sent_;`);
    lines.push(`${indent}        }`);
  });
  lines.push(`${indent}    }`);
  lines.push(`${indent}}`);
  return lines.join('\n');
}

/**
 * Everything structural: namespaces, class opening, members (ports, traffic
 * state, authored vars, the scheduler ref), ctor (scheduler FIRST, then the
 * out-links positionally), consume-only handler, setLink, configureLink,
 * wire. Shared by both modes — 'generated' appends tick() + closers inside
 * the markers, 'custom' leaves the class open across the END marker.
 */
function emitStructure(
  comp: AuthoredComponent,
  model: AuthoringModel,
  spec?: SpecDocument | null,
): { open: string; close: string } {
  const ports = [...comp.outPorts];
  const cls = leafName(comp.id);
  const namespaces = comp.id.split('.').slice(0, -1);

  const members: string[] = [];
  for (const p of ports) members.push(`    Link* ${p.name};`);
  members.push('    uint64_t sent_ = 0;');
  members.push('    uint64_t rr_ = 0;');
  members.push('    uint64_t lfsr_ = 0x2545F4914F6CDD1DULL;');
  members.push('    uint64_t addrSeq_ = 0;');
  members.push('    microarch::Scheduler& scheduler_;');
  for (const v of comp.vars)
    members.push(
      `    ${v.type} ${v.name}${v.init !== null ? ` = ${v.init}` : defaultFor(v.type, spec)};`,
    );

  const ctorArgs = [
    'microarch::Scheduler& scheduler',
    ...ports.map((p) => `Link* ${p.name} = nullptr`),
  ].join(', ');
  const inits = [
    `Component("${comp.id}")`,
    ...ports.map((p) => `${p.name}(${p.name})`),
    'scheduler_(scheduler)',
  ];
  const ctor =
    `    explicit ${cls}(${ctorArgs}) : ${inits.join(', ')} {\n` +
    `        configureLink();\n` +
    `    }`;

  // Generators consume responses if wired to, but never auto-emit from the
  // handler — origination lives in tick().
  const handlerLines: string[] = [];
  if (comp.consumes.length === 0) {
    handlerLines.push('        (void)ev;');
  } else {
    for (const message of comp.consumes) {
      if (!model.events.some((e) => e.id === message)) continue;
      handlerLines.push(
        `        if (ev.type() == "${message}") {`,
        `            auto& msg_${message} = static_cast<${message}&>(ev);`,
        `            (void)msg_${message};`,
        `        }`,
      );
    }
    if (handlerLines.length === 0) handlerLines.push('        (void)ev;');
  }
  const handler = `    void handler(Event& ev) override {\n${handlerLines.join('\n')}\n    }`;

  const setLinkBody =
    ports.length === 0
      ? `        (void)port;\n        (void)link;`
      : ports
          .map((p) => `        if (std::strcmp(port, "${p.name}") == 0) this->${p.name} = link;`)
          .join('\n') + `\n        configureLink();`;
  const setLink = `    void setLink(const char* port, Link* link) {\n${setLinkBody}\n    }`;

  const cfg = ports
    .map(
      (p) =>
        `        if (${p.name}) {\n` +
        `            ${p.name}->configureIn(this);\n` +
        `            ${p.name}->latency = ${p.latency ?? 1};\n` +
        `        }`,
    )
    .join('\n');
  const configureLink = `    void configureLink() {\n${cfg === '' ? '' : cfg + '\n'}    }`;

  const wired = ports.filter((p) => p.to !== null);
  const wireBody =
    wired.length === 0
      ? `        (void)registry;`
      : wired
          .map(
            (p) =>
              `        if (${p.name}) ${p.name}->configureOut(registry.find("${p.to}"));  // wire: ${comp.id}.${p.name} -> ${p.to} (${p.message})`,
          )
          .join('\n');
  const wire = `    void wire(microarch::Registry& registry) {\n${wireBody}\n    }`;

  const open = [
    ...(namespaces.length > 0 ? [namespaces.map((ns) => `namespace ${ns} {`).join('\n'), ''] : []),
    `class ${cls} : public Component {`,
    `  private:\n${members.join('\n')}`,
    `  public:`,
    ctor,
    '',
    handler,
    '',
    setLink,
    '',
    configureLink,
    '',
    wire,
  ].join('\n');

  const close = [
    '};',
    ...(namespaces.length > 0
      ? [
          '',
          namespaces
            .slice()
            .reverse()
            .map((ns) => `} // namespace ${ns}`)
            .join('\n'),
        ]
      : []),
  ].join('\n');

  return { open, close };
}

/** 'generated' mode: the whole class inside the markers. */
export function emitTrafficGenBody(
  comp: AuthoredComponent,
  model: AuthoringModel,
  spec?: SpecDocument | null,
): string {
  const { open, close } = emitStructure(comp, model, spec);
  return `${open}\n\n${emitTrafficTick(comp)}\n${close}`;
}

/** 'custom' mode head: the class stays OPEN across the END marker. */
export function emitTrafficGenHead(
  comp: AuthoredComponent,
  model: AuthoringModel,
  spec?: SpecDocument | null,
): string {
  return emitStructure(comp, model, spec).open;
}

/** Fresh hand-owned tail: the current generated tick() + the closers. */
export function trafficTailFor(
  comp: AuthoredComponent,
  model: AuthoringModel,
  spec?: SpecDocument | null,
): string {
  const { close } = emitStructure(comp, model, spec);
  return [
    '',
    '    // Hand-owned generation logic — this tick() survives regeneration.',
    '    // Params in the inspector are inert while detached; "Regenerate from',
    '    // params" rewrites this file from them again (destructive).',
    emitTrafficTick(comp),
    close,
    '',
  ].join('\n');
}
