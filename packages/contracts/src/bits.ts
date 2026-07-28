// HOW WIDE A PACKET IS.
//
// Bandwidth used to be counted in packets per cycle, which quietly assumed
// every packet costs the same. It doesn't: a `CreditEvent { uint8_t credits }`
// and a `FillEvent { uint64_t data[8] }` are two orders of magnitude apart on
// the same wire, and an interconnect study whose whole point is contention
// cannot pretend otherwise. So a router's bandwidth is bits per cycle, and a
// packet's cost is the width of what it carries.
//
// Width comes from the event's own declared fields — the design already says
// what a message contains, so nothing new has to be authored for the common
// case. An explicit `bits` on the event overrides the derivation for the cases
// the field list can't express (a compressed payload, a header the model
// doesn't name, a burst that is one logical packet).
//
// This module is the single source of truth: the host derives the number here,
// codegen bakes it into the generated event class, and the engine only ever
// reads it back. There is no C++-side type-width logic to keep in sync.

import type { SpecDocument } from './spec';

/** A packet with no declared payload still occupies a word on the wire. */
export const DEFAULT_EVENT_BITS = 32;

/**
 * Default router bandwidth, in bits per output port per cycle. Deliberately
 * equal to DEFAULT_EVENT_BITS: a design that configures nothing forwards one
 * ordinary packet per port per cycle, which is what the packet-counting model
 * did before.
 */
export const DEFAULT_BANDWIDTH_BITS = 32;

/** Widths of the C++ types the type pickers offer. */
const TYPE_BITS: Record<string, number> = {
  bool: 1,
  char: 8,
  int8_t: 8,
  uint8_t: 8,
  int16_t: 16,
  uint16_t: 16,
  int: 32,
  unsigned: 32,
  int32_t: 32,
  uint32_t: 32,
  float: 32,
  int64_t: 64,
  uint64_t: 64,
  size_t: 64,
  double: 64,
};

/** Resolve a spec alias / signal enum down to a builtin, then to a width.
 *  Alias chains are followed, with a depth bound so a cyclic spec can't hang
 *  the parse. Anything still unknown is charged the default word. */
export function typeBits(type: string, spec?: SpecDocument | null): number {
  let name = type.trim();
  // `uint32_t[4]` — an array field costs its element width times its length.
  const array = /^(.*?)\s*\[\s*(\d+)\s*\]$/.exec(name);
  if (array) return typeBits(array[1], spec) * Number(array[2]);
  name = name.replace(/^(const|volatile)\s+/, '').replace(/[&*]\s*$/, '').trim();

  for (let depth = 0; depth < 8; depth++) {
    const direct = TYPE_BITS[name];
    if (direct !== undefined) return direct;
    const alias = spec?.types?.find((t) => t.name === name);
    if (alias) {
      name = alias.base;
      continue;
    }
    const signal = spec?.signals?.find((s) => s.name === name);
    if (signal) {
      name = signal.underlying;
      continue;
    }
    break;
  }
  return DEFAULT_EVENT_BITS;
}

/**
 * The wire width of one event: its explicit override, else the sum of its
 * field widths, else the default word for a payload-free notification.
 *
 * Accepts both the authored shape (`{name, type}` fields) and the read-model
 * shape (`"name:type"` strings) so callers on either side of the parse don't
 * have to convert first.
 */
export function eventBits(
  event: { fields?: Array<{ type: string; name?: string } | string>; bits?: number },
  spec?: SpecDocument | null,
): number {
  if (event.bits !== undefined && event.bits > 0) return Math.floor(event.bits);
  const fields = event.fields ?? [];
  if (fields.length === 0) return DEFAULT_EVENT_BITS;
  let total = 0;
  for (const field of fields) {
    const type = typeof field === 'string' ? field.slice(field.indexOf(':') + 1) : field.type;
    total += typeBits(type, spec);
  }
  return total > 0 ? total : DEFAULT_EVENT_BITS;
}

/** "1.5 kb" / "96 b" — bandwidth and packet sizes, at a glance. */
export function formatBits(bits: number): string {
  if (bits >= 1024) {
    const kb = bits / 1024;
    return `${kb % 1 === 0 ? kb : kb.toFixed(1)} kb`;
  }
  return `${bits} b`;
}
