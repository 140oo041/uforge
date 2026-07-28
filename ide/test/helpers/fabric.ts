// Shared fixtures for the three fabric suites (fabric, router-codegen, e2e).
//
// Not a .test.ts on purpose — vitest collects by that suffix, and a fixtures
// file with no `it()` would report as an empty suite.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EMPTY_MODEL, type AuthoringModel, type EditIntent } from '@iss/contracts/model';
import { applyIntent } from '@iss/host/writer/edits';

export const ENGINE = path.resolve(__dirname, '..', '..', '..', 'engine');
export const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-fabric-'));

export function buildModel(intents: EditIntent[]): AuthoringModel {
  return intents.reduce(applyIntent, EMPTY_MODEL);
}

/** LEGACY fixture: A (top leaf) --Ping--> B (top leaf), routers R0—R1.
 *  Cross-top wires can no longer be authored through the reducer (hard
 *  cutover), so the wire is hand-set on the model — simulating a legacy
 *  sidecar or hand-written configureOut. Every consumer asserts the ERROR
 *  path; rule-based transport lives in ruleFabricModel(). */
export function fabricModel(): AuthoringModel {
  const m = buildModel([
    { kind: 'addComponent', id: 'A' },
    { kind: 'addComponent', id: 'B' },
    { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
    { kind: 'addComponent', id: 'R1', nodeKind: 'router' },
    { kind: 'addEvent', id: 'Ping', fields: [] },
    { kind: 'addWire', from: 'A', port: 'out', message: 'Ping', latency: 1 },
    { kind: 'setConsumes', id: 'B', consumes: ['Ping'] },
    { kind: 'attachRouter', id: 'A', router: 'R0', attach: true },
    { kind: 'attachRouter', id: 'B', router: 'R1', attach: true },
    { kind: 'linkRouters', a: 'R0', b: 'R1', connect: true },
  ]);
  m.components.find((c) => c.id === 'A')!.outPorts[0].to = 'B';
  return m;
}

/** Rule-based fixture: A's dangling Ping port enters R0; R0 rule sends Ping
 *  to B (attached at R1 over one trunk). No cross-top wires anywhere. */
export function ruleFabricModel(): AuthoringModel {
  return buildModel([
    { kind: 'addComponent', id: 'A' },
    { kind: 'addComponent', id: 'B' },
    { kind: 'addComponent', id: 'R0', nodeKind: 'router' },
    { kind: 'addComponent', id: 'R1', nodeKind: 'router' },
    { kind: 'addEvent', id: 'Ping', fields: [] },
    { kind: 'addWire', from: 'A', port: 'out', message: 'Ping' },
    { kind: 'setConsumes', id: 'B', consumes: ['Ping'] },
    { kind: 'attachRouter', id: 'A', router: 'R0', attach: true },
    { kind: 'attachRouter', id: 'B', router: 'R1', attach: true },
    { kind: 'linkRouters', a: 'R0', b: 'R1', connect: true },
    { kind: 'addForwardingRule', router: 'R0', rule: { message: 'Ping', to: 'B' } },
  ]);
}
