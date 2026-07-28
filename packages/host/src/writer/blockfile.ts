// Per-block C++ emission. Pure: AuthoredComponent → the single-file body
// (marker-wrapped by the caller). ONE .cpp per leaf block — a fully-inline
// class (no .h), wrapped in nested namespaces mirroring the component's
// dot-path id ("CPU0.IF" → namespace CPU0 { class IF … }). Composites emit
// no code; they exist as namespace + directory.
//
// The v2 keystone is unchanged: configureOut IS emitted (in
// wire(Registry&)), so a drawn wire lives in the block's own source and comes
// back as a Tier-1 'wired' link — not inferred from message types, not lost.
//
// The Component("…") string is the ENGINE IDENTITY (the full dot-path id) so
// traces and the registry stay unambiguous across duplicated composites;
// display labels live in the model sidecar and are merged host-side.

import { eventBits } from '@iss/contracts/bits';
import { leafName, type AuthoredComponent, type AuthoredEvent, type AuthoringModel } from '@iss/contracts/model';
import { stateType, type SpecDocument } from '@iss/contracts/spec';

export function defaultFor(type: string, spec?: SpecDocument | null): string {
  let t = type.trim();
  // Resolve spec type aliases (`word` → `uint32_t`) before pattern-matching.
  for (let hops = 0; spec && hops < 8; hops++) {
    const alias = (spec.types ?? []).find((a) => a.name === t);
    if (!alias) break;
    t = alias.base.trim();
  }
  const signal = spec?.signals?.find((s) => s.name === t);
  if (signal) return signal.values.length > 0 ? ` = ${t}::${signal.values[0]}` : '';
  if (
    /^(std::)?u?int\d+_t$/.test(t) ||
    ['int', 'long', 'short', 'char', 'unsigned', 'size_t', 'uint64_t', 'uint32_t'].includes(t)
  )
    return ' = 0';
  if (t === 'bool') return ' = false';
  if (t === 'float' || t === 'double') return ' = 0';
  return '';
}

/**
 * The shared arch header body: spec types as aliases, signals as enum
 * classes, and the global state as one `ArchState` with an `inline` instance
 * (safe: only the generated harness TU compiles the design).
 */
export function emitArchHeaderBody(spec: SpecDocument | null): string {
  const parts: string[] = [];
  for (const t of spec?.types ?? []) parts.push(`using ${t.name} = ${t.base};`);
  for (const s of spec?.signals ?? []) {
    const values = s.values.map((v) => `    ${v},`).join('\n');
    parts.push(`enum class ${s.name} : ${s.underlying} {\n${values}\n};`);
  }
  const members = (spec?.state ?? []).map((el) => {
    const type = stateType(el);
    const array = el.count !== undefined && el.count > 1 ? `[${el.count}]` : '';
    const init =
      el.init !== undefined && el.init !== ''
        ? ` = ${el.init}`
        : array !== ''
          ? ' = {}'
          : defaultFor(type, spec);
    return `    ${type} ${el.name}${array}${init};  // ${el.label}`;
  });
  parts.push(
    members.length === 0
      ? `struct ArchState {\n};`
      : `struct ArchState {\n${members.join('\n')}\n};`,
  );
  parts.push(`inline ArchState arch;`);
  return parts.join('\n\n');
}

export function emitEventsHeaderBody(events: AuthoredEvent[], spec?: SpecDocument | null): string {
  const sorted = [...events].sort((a, b) => a.id.localeCompare(b.id));
  const parts = sorted.map((event) => {
    const fields = event.fields
      .map((f) => `    ${f.type} ${f.name}${defaultFor(f.type, spec)};`)
      .join('\n');
    // Wire width: routers meter bandwidth in bits, so every packet has to
    // arrive at the engine knowing what it costs. Derived from the declared
    // field types (or the authored override) on this side of the wall — the
    // engine never reasons about C++ type widths.
    const bits = eventBits(event, spec);
    return [
      `class ${event.id} : public Event {`,
      `  public:`,
      `    ${event.id}() : Event("${event.id}") { bits = ${bits}; }  // ${bits} bits on the wire`,
      fields,
      `};`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  });
  return parts.join('\n\n');
}

/** The whole marker-region body for one leaf block: namespaces + inline class. */
export function emitBlockBody(
  comp: AuthoredComponent,
  model: AuthoringModel,
  spec?: SpecDocument | null,
): string {
  const ports = [...comp.outPorts];
  const cls = leafName(comp.id);
  const namespaces = comp.id.split('.').slice(0, -1);

  const members: string[] = [];
  for (const p of ports) members.push(`    Link* ${p.name};`);
  for (const v of comp.vars)
    members.push(
      `    ${v.type} ${v.name}${v.init !== null ? ` = ${v.init}` : defaultFor(v.type, spec)};`,
    );

  // Constructor — Component("<full id>") is the engine identity.
  const ctorArgs = ports.map((p) => `Link* ${p.name} = nullptr`).join(', ');
  const inits = [`Component("${comp.id}")`, ...ports.map((p) => `${p.name}(${p.name})`)];
  const ctor =
    `    explicit ${cls}(${ctorArgs}) : ${inits.join(', ')} {\n` +
    `        configureLink();\n` +
    `    }`;

  // handler — consume guards, then build + send one event per wired port.
  const handlerLines: string[] = [];
  if (comp.consumes.length === 0) {
    handlerLines.push(`        (void)ev;`);
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
  }
  for (const p of ports) {
    handlerLines.push(
      `        if (${p.name} && ${p.name}->connected()) {`,
      `            auto ev_${p.name} = std::make_unique<${p.message}>();`,
      `            ${p.name}->send(std::move(ev_${p.name}));`,
      `        }`,
    );
  }
  const handler = `    void handler(Event& ev) override {\n${handlerLines.join('\n')}\n    }`;

  // setLink — the stable ABI harnesses use to inject links post-construction.
  const setLinkBody =
    ports.length === 0
      ? `        (void)port;\n        (void)link;`
      : ports
          .map((p) => `        if (std::strcmp(port, "${p.name}") == 0) this->${p.name} = link;`)
          .join('\n') + `\n        configureLink();`;
  const setLink = `    void setLink(const char* port, Link* link) {\n${setLinkBody}\n    }`;

  // configureLink — bind self as source, apply latency.
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

  // wire — THE emitted connection. One configureOut per port with a
  // destination; the parser reads these back as Tier-1 'wired' edges.
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

  const klass = [
    `class ${cls} : public Component {`,
    members.length > 0 ? `  private:\n${members.join('\n')}` : '',
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
    `};`,
  ]
    .filter((part) => part !== '')
    .join('\n');

  if (namespaces.length === 0) return klass;
  const open = namespaces.map((ns) => `namespace ${ns} {`).join('\n');
  const close = namespaces
    .slice()
    .reverse()
    .map((ns) => `} // namespace ${ns}`)
    .join('\n');
  return `${open}\n\n${klass}\n\n${close}`;
}

/** Prologue for a block .cpp — #pragma once so the harness can #include it. */
export const BLOCK_PROLOGUE = [
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
  '',
  '',
].join('\n');

export const EVENTS_PROLOGUE = [
  '#pragma once',
  '',
  '#include <cstdint>',
  '#include <string>',
  '',
  '#include "infra/event.h"',
  '#include "iss_arch.h"',
  '',
  '',
].join('\n');

/** Prologue for the shared arch header (types, signals, global state). */
export const ARCH_PROLOGUE = ['#pragma once', '', '#include <cstdint>', '', ''].join('\n');
