// Forwarding-rule model layer: address helpers, the four rule intents with
// validation/canonicalization/ordering, traffic-generator address params,
// and sidecar round-trip of `rules`.

import { describe, expect, it } from 'vitest';

import {
  ADDR_MAX,
  EMPTY_MODEL,
  formatAddr,
  parseAddr,
  type AuthoringModel,
  type EditIntent,
} from '@iss/contracts/model';
import { applyIntent } from '@iss/host/writer/edits';

function buildModel(intents: EditIntent[]): AuthoringModel {
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

/** Two tops (composite Sys + leaf Memory), router R0, one event. */
function ruleModel(): AuthoringModel {
  return buildModel([
    { kind: 'addComponent', id: 'Sys', nodeKind: 'composite' },
    { kind: 'addComponent', id: 'Sys.Gen' },
    { kind: 'addComponent', id: 'Memory' },
    { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
    { kind: 'addEvent', id: 'MemReq', fields: [] },
  ]);
}

const router = (m: AuthoringModel) => m.components.find((c) => c.id === 'R0')!;

describe('address helpers', () => {
  it('parses hex, decimal and separators; rejects junk and overflow', () => {
    expect(parseAddr('0x1000')).toBe(0x1000n);
    expect(parseAddr('0XFF')).toBe(0xffn);
    expect(parseAddr('4096')).toBe(4096n);
    expect(parseAddr(' 0x10_00 ')).toBe(0x1000n);
    expect(parseAddr('0xffffffffffffffff')).toBe(ADDR_MAX);
    expect(parseAddr('')).toBeNull();
    expect(parseAddr('0x')).toBeNull();
    expect(parseAddr('-1')).toBeNull();
    expect(parseAddr('0xg')).toBeNull();
    expect(parseAddr('1.5')).toBeNull();
    expect(parseAddr('0x10000000000000000')).toBeNull(); // 2^64
  });

  it('formats canonically', () => {
    expect(formatAddr(0n)).toBe('0x0');
    expect(formatAddr(0x1abcn)).toBe('0x1abc');
    expect(formatAddr(ADDR_MAX)).toBe('0xffffffffffffffff');
  });
});

describe('forwarding-rule intents', () => {
  it('adds, canonicalizes addresses, and appends in order', () => {
    let m = ruleModel();
    m = applyIntent(m, {
      kind: 'addForwardingRule',
      router: 'R0',
      rule: { message: 'MemReq', addrLo: '4096', addrHi: '0x1FFF', to: 'Memory' },
    });
    m = applyIntent(m, {
      kind: 'addForwardingRule',
      router: 'R0',
      rule: { to: 'Sys' },
    });
    expect(router(m).rules).toEqual([
      { message: 'MemReq', addrLo: '0x1000', addrHi: '0x1fff', to: 'Memory' },
      { to: 'Sys' },
    ]);
  });

  it('inserts at an explicit index', () => {
    let m = ruleModel();
    m = applyIntent(m, { kind: 'addForwardingRule', router: 'R0', rule: { to: 'Memory' } });
    m = applyIntent(m, {
      kind: 'addForwardingRule',
      router: 'R0',
      rule: { to: 'Sys' },
      index: 0,
    });
    expect(router(m).rules!.map((r) => r.to)).toEqual(['Sys', 'Memory']);
  });

  it('updates and removes; empty list deletes the field', () => {
    let m = ruleModel();
    m = applyIntent(m, { kind: 'addForwardingRule', router: 'R0', rule: { to: 'Memory' } });
    m = applyIntent(m, {
      kind: 'updateForwardingRule',
      router: 'R0',
      index: 0,
      rule: { message: 'MemReq', to: 'Memory', latencyModel: 'dram' },
    });
    expect(router(m).rules![0]).toEqual({ message: 'MemReq', to: 'Memory', latencyModel: 'dram' });
    m = applyIntent(m, { kind: 'removeForwardingRule', router: 'R0', index: 0 });
    expect(router(m).rules).toBeUndefined();
  });

  it('reorders with moveForwardingRule', () => {
    let m = ruleModel();
    m = applyIntent(m, { kind: 'addForwardingRule', router: 'R0', rule: { to: 'Memory' } });
    m = applyIntent(m, { kind: 'addForwardingRule', router: 'R0', rule: { to: 'Sys' } });
    m = applyIntent(m, { kind: 'moveForwardingRule', router: 'R0', from: 1, to: 0 });
    expect(router(m).rules!.map((r) => r.to)).toEqual(['Sys', 'Memory']);
  });

  it('rejects bad destinations, events, addresses and models', () => {
    const m = ruleModel();
    const add = (rule: Record<string, unknown>) => () =>
      applyIntent(m, { kind: 'addForwardingRule', router: 'R0', rule: rule as never });
    expect(add({ to: 'Nope' })).toThrow(/unknown component/);
    expect(add({ to: 'R0' })).toThrow(/is a router/);
    expect(add({ to: 'Sys.Gen' })).toThrow(/nested/);
    expect(add({ to: 'Memory', message: 'NoSuchEvent' })).toThrow(/unknown event/);
    expect(add({ to: 'Memory', addrLo: 'zzz' })).toThrow(/bad address/);
    expect(add({ to: 'Memory', addrLo: '0x2000', addrHi: '0x1000' })).toThrow(/exceeds/);
    expect(add({ to: 'Memory', latencyModel: 'not valid' })).toThrow(/latency-model/);
    expect(() =>
      applyIntent(m, { kind: 'addForwardingRule', router: 'Memory', rule: { to: 'Sys' } }),
    ).toThrow(/not a router/);
    expect(() =>
      applyIntent(m, { kind: 'removeForwardingRule', router: 'R0', index: 0 }),
    ).toThrow(/out of range/);
    expect(() =>
      applyIntent(m, { kind: 'moveForwardingRule', router: 'R0', from: 0, to: 1 }),
    ).toThrow(/out of range/);
  });

  it('blocks removeEvent while a rule references the event', () => {
    let m = ruleModel();
    m = applyIntent(m, {
      kind: 'addForwardingRule',
      router: 'R0',
      rule: { message: 'MemReq', to: 'Memory' },
    });
    expect(() => applyIntent(m, { kind: 'removeEvent', id: 'MemReq' })).toThrow(/used by R0/);
    m = applyIntent(m, { kind: 'removeForwardingRule', router: 'R0', index: 0 });
    expect(() => applyIntent(m, { kind: 'removeEvent', id: 'MemReq' })).not.toThrow();
  });

  it('rules ride removeComponent semantics: removed router takes its rules, removed dest dangles', () => {
    let m = ruleModel();
    m = applyIntent(m, { kind: 'addForwardingRule', router: 'R0', rule: { to: 'Memory' } });
    const gone = applyIntent(m, { kind: 'removeComponent', id: 'R0' });
    expect(gone.components.some((c) => c.id === 'R0')).toBe(false);
    // Removed destination: the rule stays (dangling), the derivation diagnoses it.
    const dangling = applyIntent(m, { kind: 'removeComponent', id: 'Memory' });
    expect(router(dangling).rules![0].to).toBe('Memory');
  });
});

describe('traffic address params', () => {
  const gen = (): AuthoringModel =>
    buildModel([
      { kind: 'addComponent', id: 'Gen', role: 'trafficgen' },
    ]);

  it('accepts the full trio and canonicalizes', () => {
    const m = applyIntent(gen(), {
      kind: 'setTraffic',
      id: 'Gen',
      traffic: {
        period: 2,
        burst: 1,
        count: 0,
        start: 0,
        pattern: 'roundrobin',
        addrLo: '4096',
        addrHi: '0x1FFF',
        addrPattern: 'random',
      },
    });
    const traffic = m.components[0].traffic!;
    expect(traffic.addrLo).toBe('0x1000');
    expect(traffic.addrHi).toBe('0x1fff');
    expect(traffic.addrPattern).toBe('random');
  });

  it('rejects partial trios and bad ranges', () => {
    const base = { period: 2, burst: 1, count: 0, start: 0, pattern: 'fixed' as const };
    expect(() =>
      applyIntent(gen(), { kind: 'setTraffic', id: 'Gen', traffic: { ...base, addrLo: '0x0' } }),
    ).toThrow(/together/);
    expect(() =>
      applyIntent(gen(), {
        kind: 'setTraffic',
        id: 'Gen',
        traffic: { ...base, addrLo: '0x10', addrHi: '0x1', addrPattern: 'random' },
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      applyIntent(gen(), {
        kind: 'setTraffic',
        id: 'Gen',
        traffic: { ...base, addrLo: '0x0', addrHi: '0x1', addrPattern: 'weird' as never },
      }),
    ).toThrow(/addrPattern/);
  });

  it('clearing the trio drops the fields', () => {
    let m = applyIntent(gen(), {
      kind: 'setTraffic',
      id: 'Gen',
      traffic: {
        period: 2,
        burst: 1,
        count: 0,
        start: 0,
        pattern: 'fixed',
        addrLo: '0x0',
        addrHi: '0xff',
        addrPattern: 'sequential',
      },
    });
    m = applyIntent(m, {
      kind: 'setTraffic',
      id: 'Gen',
      traffic: { period: 2, burst: 1, count: 0, start: 0, pattern: 'fixed' },
    });
    const traffic = m.components[0].traffic!;
    expect(traffic.addrLo).toBeUndefined();
    expect(traffic.addrHi).toBeUndefined();
    expect(traffic.addrPattern).toBeUndefined();
  });
});

describe('hard cutover', () => {
  it('addWire rejects cross-top destinations with a pointer to rules', () => {
    const m = ruleModel();
    expect(() =>
      applyIntent(m, {
        kind: 'addWire',
        from: 'Sys.Gen',
        port: 'out',
        message: 'MemReq',
        to: 'Memory',
      }),
    ).toThrow(/cross-top wires are not allowed.*forwarding rule/);
    // Intra-top and dangling stay legal.
    expect(() =>
      applyIntent(m, { kind: 'addWire', from: 'Sys.Gen', port: 'out', message: 'MemReq' }),
    ).not.toThrow();
  });
});
