// Parser unit tests: the recognized slice on hand-written (non-generated)
// code, the inference tiers, and the incremental cache.

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { extractFacts, stripComments } from '@iss/host/parser/facts';
import { assembleGraph } from '@iss/host/parser/infer';
import { ProjectParser } from '@iss/host/parser/index';

function graphOf(files: Record<string, string>) {
  return assembleGraph(
    Object.entries(files).map(([file, text]) => extractFacts(file, text)),
  );
}

describe('stripComments', () => {
  it('removes comments but preserves strings and newlines', () => {
    const text = 'a; // note\n/* b\nc */ d("x // not a comment");';
    const out = stripComments(text);
    expect(out).toContain('d("x // not a comment")');
    expect(out).not.toContain('note');
    expect(out.split('\n')).toHaveLength(text.split('\n').length);
  });
});

describe('fact extraction on hand-written idioms', () => {
  const HANDWRITTEN = `
#include "microarch/engine.hpp"
using namespace microarch;

struct FetchEvent final : Event {
    FetchEvent() : Event("FetchEvent") {}
    std::uint32_t instruction = 0;
};
struct DecodeEvent final : Event {
    DecodeEvent() : Event("DecodeEvent") {}
    std::uint32_t opcode = 0;
};

class Fetch final : public Component {
public:
    explicit Fetch(Link& output) : Component("IF"), output_(output) {}
    void handler(Event& event) override {
        auto& request = dynamic_cast<FetchEvent&>(event);
        auto next = std::make_unique<DecodeEvent>();
        next->opcode = request.instruction & 0x7f;
        output_.send(std::move(next));
    }
private:
    Link& output_;
};

class Decode final : public Component {
public:
    Decode() : Component("DE") {}
    void handler(Event& event) override {
        auto& decoded = static_cast<DecodeEvent&>(event);
        (void)decoded;
    }
};
`;

  it('recognizes blocks, events, labels, Link& ports, emits, consumes', () => {
    const facts = extractFacts('hand.cpp', HANDWRITTEN);
    expect(facts.classes.map((c) => `${c.name}:${c.base}`).sort()).toEqual([
      'Decode:Component',
      'DecodeEvent:Event',
      'Fetch:Component',
      'FetchEvent:Event',
    ]);
    expect(facts.ports).toMatchObject([{ cls: 'Fetch', port: 'output_' }]);
    expect(facts.emits).toMatchObject([{ cls: 'Fetch', port: 'output_', message: 'DecodeEvent' }]);
    expect(facts.consumes).toContainEqual({ cls: 'Fetch', message: 'FetchEvent' });
    expect(facts.consumes).toContainEqual({ cls: 'Decode', message: 'DecodeEvent' });
    const fetch = facts.classes.find((c) => c.name === 'Fetch')!;
    expect(fetch.label).toBe('IF');
  });

  it('Tier 2: unique consumer → inferred edge (hand-written, no configureOut)', () => {
    const graph = graphOf({ 'hand.cpp': HANDWRITTEN });
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0]).toMatchObject({
      from: 'Fetch',
      fromPort: 'output_',
      to: 'Decode',
      message: 'DecodeEvent',
      status: 'inferred',
    });
  });

  it('Tier 2b: multiple candidate consumers → visible unresolved link', () => {
    const extra = `
class Decode2 final : public Component {
public:
    Decode2() : Component("DE2") {}
    void handler(Event& event) override {
        auto& d = static_cast<DecodeEvent&>(event);
        (void)d;
    }
};
`;
    const graph = graphOf({ 'hand.cpp': HANDWRITTEN, 'extra.cpp': extra });
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0].status).toBe('unresolved');
    expect(graph.links[0].to).toBeNull();
  });

  it('Tier 3: no consumer → stub', () => {
    const solo = HANDWRITTEN.replace(/class Decode final[\s\S]*$/, '');
    const graph = graphOf({ 'solo.cpp': solo });
    expect(graph.links).toHaveLength(0);
    expect(graph.stubs).toMatchObject([{ from: 'Fetch', message: 'DecodeEvent' }]);
  });

  it('Tier 1 beats inference: configureOut wins even with multiple consumers', () => {
    const wired = HANDWRITTEN.replace(
      'output_.send(std::move(next));',
      'output_.send(std::move(next));',
    ) + `
class Decode3 final : public Component {
public:
    Decode3() : Component("DE3") {}
    void handler(Event& event) override {
        auto& d = static_cast<DecodeEvent&>(event);
        (void)d;
    }
    void wire(microarch::Registry& registry) {
        out->configureOut(registry.find("Decode"));
    }
private:
    Link* out;
};
`;
    const graph = graphOf({ 'wired.cpp': wired });
    const d3 = graph.links.find((l) => l.from === 'Decode3');
    expect(d3).toMatchObject({ to: 'Decode', status: 'wired' });
  });

  it('label from an out-of-line .cpp ctor attaches to the .h class', () => {
    const header = `#pragma once
#include "infra/component.h"
class MEM : public Component {
  private:
    Link* out;
  public:
    MEM(Link* out = nullptr);
    void handler(Event& ev) override;
};
`;
    const source = `#include "MEM.h"
MEM::MEM(Link* out) : Component("Memory Stage"), out(out) {}
void MEM::handler(Event& ev) { (void)ev; }
`;
    const graph = graphOf({ 'inc/MEM.h': header, 'src/MEM.cpp': source });
    expect(graph.components[0].label).toBe('Memory Stage');
    expect(graph.components[0].handler?.file).toBe('src/MEM.cpp');
  });

  it('facts in free functions (generated harness main) are dropped', () => {
    const harness = `
#include "microarch/engine.hpp"
int main() {
    microarch::Link link_A_out(scheduler, 1);
    link_A_out.configureOut(registry.find("B"));
    return 0;
}
`;
    const facts = extractFacts('main.cpp', harness);
    expect(facts.wires).toHaveLength(0);
  });
});

describe('hierarchy: namespace qualification', () => {
  const NAMESPACED = `
#include "microarch/engine.hpp"
namespace CPU0 {
class IF : public Component {
  private:
    Link* out;
    std::uint32_t pc = 0x80000000;
  public:
    explicit IF(Link* out = nullptr) : Component("CPU0.IF"), out(out) {}
    void handler(Event& ev) override {
        (void)ev;
        if (out && out->destination()) {
            auto ev_out = std::make_unique<FetchEvent>();
            out->send(std::move(ev_out));
        }
    }
    void wire(microarch::Registry& registry) {
        if (out) out->configureOut(registry.find("CPU0.DE"));
    }
};
} // namespace CPU0
struct FetchEvent final : Event { FetchEvent() : Event("FetchEvent") {} };
namespace CPU0 {
class DE : public Component {
  public:
    DE() : Component("CPU0.DE") {}
    void handler(Event& ev) override {
        auto& f = static_cast<FetchEvent&>(ev);
        (void)f;
    }
};
}
`;

  it('classes inside namespaces get dot-path ids; wires resolve across them', () => {
    const graph = graphOf({ 'cpu0.cpp': NAMESPACED });
    const ids = graph.components.map((c) => c.id).sort();
    expect(ids).toEqual(['CPU0', 'CPU0.DE', 'CPU0.IF']);
    const cpu = graph.components.find((c) => c.id === 'CPU0')!;
    expect(cpu.kind).toBe('composite');
    const link = graph.links.find((l) => l.id === 'CPU0.IF.out')!;
    expect(link).toMatchObject({ to: 'CPU0.DE', status: 'wired', message: 'FetchEvent' });
  });

  it('identity labels (Component string == id) display as the leaf name', () => {
    const graph = graphOf({ 'cpu0.cpp': NAMESPACED });
    expect(graph.components.find((c) => c.id === 'CPU0.IF')!.label).toBe('IF');
  });
});

describe('component state variables', () => {
  it('extracts depth-1 members, not handler locals or Link ports', () => {
    const source = `
class IF : public Component {
  private:
    Link* out;
    std::uint32_t pc = 0x80000000;
    bool stalled = false;
  public:
    IF() : Component("IF") {}
    void handler(Event& ev) override {
        auto tmp = std::make_unique<Event>("E");
        uint32_t local = 3;
        (void)local;
        (void)ev;
    }
};
`;
    const graph = graphOf({ 'if.cpp': source });
    expect(graph.components[0].vars.sort()).toEqual(['pc:std::uint32_t', 'stalled:bool']);
  });

  it('extracts vars from hand-written members too', () => {
    const source = `
class Fetch final : public Component {
public:
    explicit Fetch() : Component("IF") {}
    void handler(Event& event) override { (void)event; }
private:
    std::uint64_t pc_ = 0;
    Link& output_;
};
`;
    const graph = graphOf({ 'fetch.cpp': source });
    expect(graph.components[0].vars).toEqual(['pc_:std::uint64_t']);
    expect(graph.components[0].outPorts.map((p) => p.name)).toEqual(['output_']);
  });
});

describe('incremental cache', () => {
  it('reuses unchanged files and picks up overlays', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iss2-parser-'));
    fs.mkdirSync(path.join(root, 'inc'));
    const file = path.join(root, 'inc', 'A.h');
    fs.writeFileSync(
      file,
      `class A : public Component { private: Link* out; public: A(); void handler(Event& ev) override; };`,
    );
    const parser = new ProjectParser([root]);
    let graph = parser.parse();
    expect(graph.components.map((c) => c.id)).toEqual(['A']);

    // Overlay simulates unsaved editor text (live refresh path).
    parser.setOverlay(
      file,
      `class Renamed : public Component { public: void handler(Event& ev) override; };`,
    );
    graph = parser.parse();
    expect(graph.components.map((c) => c.id)).toEqual(['Renamed']);

    parser.setOverlay(file, null);
    graph = parser.parse();
    expect(graph.components.map((c) => c.id)).toEqual(['A']);
  });
});
