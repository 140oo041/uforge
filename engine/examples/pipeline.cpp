// Minimal 3-stage pipeline exercising the whole engine surface:
// seeding tokens, links with latencies, hop tracing, divergence reporting.
//
//   IF --(DecodeEvent, 1cy)--> EX --(ExecuteEvent, 2cy)--> WB
//
// Run:  ./pipeline [trace.jsonl]

#include <fstream>
#include <iostream>
#include <memory>
#include <vector>

#include "microarch/engine.hpp"

using namespace microarch;

struct FetchEvent final : Event {
    explicit FetchEvent(std::uint32_t insn = 0)
        : Event("FetchEvent"), instruction(insn) {}
    std::uint32_t instruction;
};

struct DecodeEvent final : Event {
    DecodeEvent() : Event("DecodeEvent") {}
    std::uint32_t instruction = 0;
    std::uint32_t opcode = 0;
};

struct ExecuteEvent final : Event {
    ExecuteEvent() : Event("ExecuteEvent") {}
    std::uint32_t value = 0;
};

class Fetch final : public Component {
public:
    explicit Fetch(Link& output) : Component("IF"), output_(output) {}

    void handler(Event& event) override {
        auto& request = dynamic_cast<FetchEvent&>(event);
        auto next = std::make_unique<DecodeEvent>();
        next->instruction = request.instruction;
        next->opcode = request.instruction & 0x7f;
        output_.send(std::move(next));
    }

private:
    Link& output_;
};

class Execute final : public Component {
public:
    explicit Execute(Link& output) : Component("EX"), output_(output) {}

    void handler(Event& event) override {
        auto& decoded = dynamic_cast<DecodeEvent&>(event);
        auto next = std::make_unique<ExecuteEvent>();
        next->value = decoded.instruction >> 7;
        output_.send(std::move(next));
    }

private:
    Link& output_;
};

class Retire final : public Component {
public:
    explicit Retire(Scheduler& scheduler) : Component("WB"), scheduler_(scheduler) {}

    void handler(Event& event) override {
        auto& result = dynamic_cast<ExecuteEvent&>(event);
        values.push_back(result.value);
        if (result.value == 0)
            scheduler_.reportDivergence(*this, event.token, "unexpected zero result");
    }

    std::vector<std::uint32_t> values;

private:
    Scheduler& scheduler_;
};

int main(int argc, char** argv) {
    const char* tracePath = argc > 1 ? argv[1] : "pipeline_trace.jsonl";
    std::ofstream traceFile(tracePath);

    Scheduler scheduler;
    JsonlTraceWriter trace(traceFile);
    scheduler.setHopSink(trace.hopSink());
    scheduler.setDivergenceSink(trace.divergenceSink());

    Link ifToEx(scheduler, 1);
    Link exToWb(scheduler, 2);
    Fetch fetch(ifToEx);
    Execute execute(exToWb);
    Retire retire(scheduler);
    ifToEx.connect(fetch, execute);
    exToWb.connect(execute, retire);

    const std::uint32_t program[] = {0x00500093, 0x00308113, 0x002081b3};
    for (Cycle cycle = 0; cycle < 3; ++cycle)
        scheduler.seed<FetchEvent>(fetch, cycle, program[cycle]);

    scheduler.runFor(8);

    std::cout << retire.values.size() << " tokens retired in "
              << scheduler.currentCycle() << " cycles; trace: " << tracePath << "\n";
    return retire.values.size() == 3 ? 0 : 1;
}
