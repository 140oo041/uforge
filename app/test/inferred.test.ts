// Inferred wires: a port that sends an event nobody wired, where exactly one
// block consumes that event, is a Tier-2 'inferred' link. It must reach the
// canvas — a connection the parser deduced is still a connection, and hiding it
// would be exactly the "silently dropped" failure this product refuses.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ProjectParser, augmentWithModel } from '@iss/host';
import { EMPTY_MODEL } from '@iss/contracts/model';

const EVENTS = `#pragma once
#include "infra/event.h"
struct PingEvent : Event { const char* type() const override { return "PingEvent"; } };
`;

/** A hand-written sender with NO configureOut — the destination must be deduced. */
const SENDER = `#pragma once
#include <memory>
#include "infra/component.h"
#include "infra/link.h"
#include "iss_events.h"
class Producer : public Component {
  private:
    Link* out;
  public:
    explicit Producer(Link* out = nullptr) : Component("Producer"), out(out) {}
    void handler(Event& ev) override {
        auto ev_out = std::make_unique<PingEvent>();
        out->send(std::move(ev_out));
    }
};
`;

/** A hand-written consumer that overloads handler() on the concrete type —
 *  the form the writer never emits, and the one that used to parse as
 *  consuming nothing at all. */
const CONSUMER = `#pragma once
#include "infra/component.h"
#include "iss_events.h"
class Consumer : public Component {
  public:
    Consumer() : Component("Consumer") {}
    void handler(PingEvent& ev) {}
};
`;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss-infer-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'inc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inc', 'iss_events.h'), EVENTS);
  fs.writeFileSync(path.join(root, 'src', 'Producer.cpp'), SENDER);
  fs.writeFileSync(path.join(root, 'src', 'Consumer.cpp'), CONSUMER);
  return root;
}

describe('inferred wires', () => {
  it('deduces a destination when exactly one block consumes the event', () => {
    const root = project();
    const graph = new ProjectParser([root]).parse();

    const producer = graph.components.find((c) => c.id === 'Producer');
    const consumer = graph.components.find((c) => c.id === 'Consumer');
    expect(producer, 'Producer did not parse').toBeDefined();
    expect(consumer, 'Consumer did not parse').toBeDefined();

    // The consumer has to be recognised as consuming PingEvent, or there is
    // nothing to infer against.
    expect(consumer!.consumes).toContain('PingEvent');

    // The port must carry its message, or the inference has no key.
    const port = producer!.outPorts.find((p) => p.name === 'out');
    expect(port, 'no out-port on Producer').toBeDefined();
    expect(port!.message).toBe('PingEvent');

    const link = graph.links.find((l) => l.from === 'Producer');
    expect(link, `no link produced — stubs: ${JSON.stringify(graph.stubs)}`).toBeDefined();
    expect(link!.status).toBe('inferred');
    expect(link!.to).toBe('Consumer');
  });

  it('survives augmentWithModel, which the app always applies', () => {
    const root = project();
    const graph = augmentWithModel(new ProjectParser([root]).parse(), EMPTY_MODEL);
    const link = graph.links.find((l) => l.from === 'Producer');
    expect(link).toBeDefined();
    expect(link!.status).toBe('inferred');
  });
});
