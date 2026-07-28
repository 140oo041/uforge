// Headless engine acceptance tests. Plain asserts, no framework.
// Covers the exact defects the original ISS infra engine shipped with:
// clock init/advance, event delivery past small ring sizes, token
// propagation, hop tracing, two-phase clocking, registry wiring.

#include <cassert>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "microarch/engine.hpp"

using namespace microarch;

namespace {

struct Payload final : Event {
    explicit Payload(int v = 0) : Event("Payload"), value(v) {}
    int value;
};

/// A packet four times the default width — for the bandwidth tests, where the
/// whole point is that packets do not all cost the same.
struct WidePayload final : Event {
    explicit WidePayload(int v = 0) : Event("WidePayload"), value(v) {
        bits = 4 * default_event_bits;
    }
    int value;
};

class Counter final : public Component {
public:
    explicit Counter(std::string name) : Component(std::move(name)) {}
    void handler(Event& event) override {
        values.push_back(dynamic_cast<Payload&>(event).value);
    }
    std::vector<int> values;
};

/// One eighth of a default word — for showing that several narrow packets
/// share a cycle that one wide packet cannot.
struct NarrowPayload final : Event {
    NarrowPayload() : Event("NarrowPayload") { bits = default_event_bits / 8; }
};

/// Forwards a fixed event type, so a rig can drive an origin whose packets
/// have a chosen width.
template <typename E>
class TypedForwarder final : public Component {
public:
    TypedForwarder(std::string name, Link& out) : Component(std::move(name)), out_(out) {}
    void handler(Event&) override { out_.send(std::make_unique<E>()); }
private:
    Link& out_;
};

/// Counts arrivals without caring what type arrived (Counter down-casts).
class AnySink final : public Component {
public:
    explicit AnySink(std::string name) : Component(std::move(name)) {}
    void handler(Event&) override { ++count; }
    int count = 0;
};

class Forwarder final : public Component {
public:
    Forwarder(std::string name, Link& out) : Component(std::move(name)), out_(out) {}
    void handler(Event& event) override {
        out_.send(std::make_unique<Payload>(dynamic_cast<Payload&>(event).value + 1));
    }
private:
    Link& out_;
};

void clockStartsAtZeroAndAdvances() {
    Scheduler scheduler;
    assert(scheduler.currentCycle() == 0);
    scheduler.runFor(5);
    assert(scheduler.currentCycle() == 5);
    scheduler.runUntil(12);
    assert(scheduler.currentCycle() == 12);
    assert(scheduler.getCurrentCyle() == 12); // legacy alias
}

void eventsDeliverFarInTheFuture() {
    // The original engine's 50-slot ring went out of bounds past cycle 50.
    Scheduler scheduler;
    Counter sink("sink");
    scheduler.seed<Payload>(sink, 500, 7);
    scheduler.runFor(501);
    assert(sink.values == std::vector<int>{7});
}

void linksTraceAndPropagateTokens() {
    Scheduler scheduler;
    std::vector<HopRecord> hops;
    scheduler.setHopSink([&](const HopRecord& hop) { hops.push_back(hop); });

    Link aToB(scheduler, 1);
    Link bToC(scheduler, 2);
    Counter sink("C");
    Forwarder b("B", bToC);
    Forwarder a("A", aToB);
    aToB.connect(a, b);
    bToC.connect(b, sink);

    const TokenId token = scheduler.seed<Payload>(a, 0, 10);
    scheduler.runFor(5);

    assert(sink.values == std::vector<int>{12});
    assert(hops.size() == 2);
    assert(hops[0].from == "A" && hops[0].to == "B" && hops[0].event == "Payload");
    assert(hops[0].depart == 0 && hops[0].arrive == 1);
    assert(hops[1].from == "B" && hops[1].to == "C");
    assert(hops[1].depart == 1 && hops[1].arrive == 3);
    // Every hop carries the seeded transaction token.
    for (const auto& hop : hops) assert(hop.token == token);
}

void sendWithoutDestinationThrows() {
    Scheduler scheduler;
    Link dangling(scheduler, 1);
    Counter src("src");
    dangling.configureIn(&src);
    bool threw = false;
    try {
        dangling.send(std::make_unique<Payload>(1));
    } catch (const std::logic_error&) {
        threw = true;
    }
    assert(threw);
}

class ClockProbe final : public Component {
public:
    ClockProbe() : Component("clock") {}
    void handler(Event&) override { order.push_back("event"); }
    bool settle(Cycle cycle) override {
        order.push_back("settle:" + std::to_string(cycle));
        return false;
    }
    void tick(Cycle cycle) override {
        order.push_back("tick:" + std::to_string(cycle));
    }
    std::vector<std::string> order;
};

void clockUsesSettleThenEdge() {
    Scheduler scheduler;
    ClockProbe probe;
    scheduler.addClocked(probe);
    scheduler.seedNow<Payload>(probe, 1);
    scheduler.runFor(1);
    const std::vector<std::string> expected{"event", "settle:0", "tick:0"};
    assert(probe.order == expected);
}

void registryWiresByName() {
    Scheduler scheduler;
    Link out(scheduler, 1);
    Counter consumer("EX");
    Forwarder producer("DE", out);
    Registry registry;
    registry.add(consumer);
    registry.add(producer);

    // The exact call shape generated block files emit:
    out.configureIn(&producer);
    out.configureOut(registry.find("EX"));

    scheduler.seed<Payload>(producer, 0, 1);
    scheduler.runFor(3);
    assert(consumer.values == std::vector<int>{2});
    assert(registry.find("nope") == nullptr);
}

void jsonlWriterShapes() {
    std::ostringstream out;
    JsonlTraceWriter writer(out);
    writer.write(HopRecord{"IF", "DE", "FetchEvent", 0, 0, 1});
    writer.write(DivergenceRecord{"EX", "x5 mismatch", 0, 5, ""});
    const std::string expected =
        "{\"token\":0,\"from\":\"IF\",\"to\":\"DE\",\"event\":\"FetchEvent\",\"depart\":0,\"arrive\":1}\n"
        "{\"diverge\":true,\"cycle\":5,\"component\":\"EX\",\"token\":0,\"detail\":\"x5 mismatch\"}\n";
    assert(out.str() == expected);
}

void divertedLinkCapturesWithoutDelivery() {
    // The shadow-execution seam: a diverted link's events go to the tap —
    // token filled in — and never reach the destination or the hop trace.
    Scheduler scheduler;
    std::vector<HopRecord> hops;
    scheduler.setHopSink([&](const HopRecord& hop) { hops.push_back(hop); });

    Link tapped(scheduler, 1);
    Counter real("real");
    Forwarder src("src", tapped);
    tapped.connect(src, real);

    std::vector<std::pair<TokenId, int>> captured;
    tapped.divert([&](std::unique_ptr<Event> ev) {
        captured.emplace_back(ev->token, dynamic_cast<Payload&>(*ev).value);
    });

    const TokenId token = scheduler.seed<Payload>(src, 0, 10);
    scheduler.runFor(3);

    assert(real.values.empty());          // nothing delivered into the design
    assert(hops.empty());                 // nothing traced
    assert(captured.size() == 1);         // the tap saw the would-be output
    assert(captured[0].first == token);   // with the in-flight token stamped
    assert(captured[0].second == 11);
}

void divergenceKindInJsonl() {
    std::ostringstream out;
    JsonlTraceWriter writer(out);
    DivergenceRecord cosim{"Alpha", "out.value: sv=2 != cpp=3", 1, 4, "cosim"};
    writer.write(cosim);
    assert(out.str() ==
           "{\"diverge\":true,\"cycle\":4,\"component\":\"Alpha\",\"token\":1,"
           "\"detail\":\"out.value: sv=2 != cpp=3\",\"kind\":\"cosim\"}\n");

    // reportDivergence's defaulted kind stays out of the record entirely
    // (backward compatible — see jsonlWriterShapes for the empty-kind shape).
    Scheduler scheduler;
    std::vector<DivergenceRecord> records;
    scheduler.setDivergenceSink([&](const DivergenceRecord& d) { records.push_back(d); });
    Counter block("EX");
    scheduler.reportDivergence(block, 7, "plain");
    scheduler.reportDivergence(block, 8, "tagged", "cosim");
    assert(records.size() == 2);
    assert(records[0].kind.empty());
    assert(records[1].kind == "cosim");
}

void routerForwardsAlongMultiHopPath() {
    // A --(routeVia R0)--> R0 --> R1 --> B: the drawn wire still names B
    // (configureOut), but transport goes through the fabric hop by hop, one
    // HopRecord per leg, token constant throughout.
    Scheduler scheduler;
    std::vector<HopRecord> hops;
    scheduler.setHopSink([&](const HopRecord& hop) { hops.push_back(hop); });

    Router r0("R0", scheduler, 1);
    Router r1("R1", scheduler, 1);
    scheduler.addClocked(r0);
    scheduler.addClocked(r1);

    Link aOut(scheduler, 1);
    Counter b("B");
    Forwarder a("A", aOut);
    aOut.connect(a, b);           // the generated wire() contract, untouched
    aOut.routeVia(r0, "B");       // harness interposition
    r0.addRoute("B", r1);
    r1.addRoute("B", b);

    const TokenId token = scheduler.seed<Payload>(a, 0, 10);
    scheduler.runFor(6);

    assert(b.values == std::vector<int>{11});
    assert(hops.size() == 3);
    assert(hops[0].from == "A" && hops[0].to == "R0");
    assert(hops[0].depart == 0 && hops[0].arrive == 1);
    assert(hops[1].from == "R0" && hops[1].to == "R1");
    assert(hops[1].depart == 1 && hops[1].arrive == 2);
    assert(hops[2].from == "R1" && hops[2].to == "B");
    assert(hops[2].depart == 2 && hops[2].arrive == 3);
    for (const auto& hop : hops) assert(hop.token == token);
    assert(r0.pendingCount() == 0 && r1.pendingCount() == 0);
}

void routerSerializesContentionPerOutputPort() {
    // Three packets reach R0 the same cycle, all bound for B: one forwards
    // per tick, so arrivals at B are one cycle apart.
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);

    Link src1Out(scheduler, 1);
    Link src2Out(scheduler, 1);
    Link src3Out(scheduler, 1);
    Counter b("B");
    Forwarder s1("S1", src1Out);
    Forwarder s2("S2", src2Out);
    Forwarder s3("S3", src3Out);
    for (auto* pair : {&src1Out, &src2Out, &src3Out}) pair->configureOut(&b);
    src1Out.configureIn(&s1);
    src2Out.configureIn(&s2);
    src3Out.configureIn(&s3);
    src1Out.routeVia(r0, "B");
    src2Out.routeVia(r0, "B");
    src3Out.routeVia(r0, "B");
    r0.addRoute("B", b);

    std::vector<Cycle> arrivals;
    scheduler.setHopSink([&](const HopRecord& hop) {
        if (hop.from == "R0") arrivals.push_back(hop.arrive);
    });

    scheduler.seed<Payload>(s1, 0, 1);
    scheduler.seed<Payload>(s2, 0, 2);
    scheduler.seed<Payload>(s3, 0, 3);
    scheduler.runFor(8);

    // All three arrive at R0 at cycle 1; head-of-line forwards at ticks 1,2,3
    // with latency 1 → arrivals 2, 3, 4.
    assert((arrivals == std::vector<Cycle>{2, 3, 4}));
    assert(b.values.size() == 3);
    assert(r0.pendingCount() == 0);
}

// The IDE's generated-router shape: a subclass whose member functions are
// user-written latency models, bound per route via setRouteLatency.
class TollRouter final : public Router {
public:
    TollRouter(std::string name, Scheduler& scheduler) : Router(std::move(name), scheduler, 1) {}
    Cycle expensive(const Event& event) const { return event.token == 0 ? 5 : 2; }
};

void routerLatencyModelsArePerPacket() {
    Scheduler scheduler;
    TollRouter r0("R0", scheduler);
    scheduler.addClocked(r0);

    Link out(scheduler, 1);
    Counter b("B");
    Forwarder a("A", out);
    out.connect(a, b);
    out.routeVia(r0, "B");
    r0.addRoute("B", b);
    r0.setRouteLatency("B", [&r0](const Event& event) { return r0.expensive(event); });

    std::vector<Cycle> arrivals;
    scheduler.setHopSink([&](const HopRecord& hop) {
        if (hop.from == "R0") arrivals.push_back(hop.arrive);
    });

    scheduler.seed<Payload>(a, 0, 1); // token 0 → model says 5 cycles
    scheduler.seed<Payload>(a, 1, 2); // token 1 → model says 2 cycles
    scheduler.runFor(10);

    // token 0 reaches R0 at 1, forwards at tick 1 with latency 5 → arrive 6;
    // token 1 reaches R0 at 2, forwards at tick 2 with latency 2 → arrive 4.
    assert((arrivals == std::vector<Cycle>{6, 4}));
    assert(b.values.size() == 2);
}

void routerThrowsOnUnroutablePacket() {
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);
    Link out(scheduler, 1);
    Counter b("B");
    Forwarder a("A", out);
    out.connect(a, b);
    out.routeVia(r0, "B");
    // No addRoute("B", …): the packet is unroutable.
    scheduler.seed<Payload>(a, 0, 1);
    bool threw = false;
    try {
        scheduler.runFor(3);
    } catch (const std::logic_error&) {
        threw = true;
    }
    assert(threw);
}

void routerReportsPendingAtClockStop() {
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);
    Link out(scheduler, 1);
    Counter b("B");
    Forwarder a("A", out);
    out.connect(a, b);
    out.routeVia(r0, "B");
    r0.addRoute("B", b);
    scheduler.seed<Payload>(a, 0, 1);
    scheduler.seed<Payload>(a, 0, 2); // same cycle → second packet queues
    scheduler.runFor(2);              // stop before the second forwards
    assert(r0.pendingCount() == 1);
}

// Two-origin contention rig: A and B each seed `perOrigin` packets at cycle 0
// through one router toward sink B; every packet reaches R0 at cycle 1, so
// the forward order is purely the arbitration policy's choice. Returns the
// order in which tokens left R0.
struct ContentionRig {
    Scheduler scheduler;
    Router r0{"R0", scheduler, 1};
    Counter sink{"Sink"};
    Link aOut{scheduler, 1};
    Link bOut{scheduler, 1};
    Forwarder a{"A", aOut};
    Forwarder b{"B", bOut};
    std::vector<TokenId> aTokens, bTokens;
    std::vector<TokenId> forwardOrder;

    explicit ContentionRig(int perOrigin) {
        scheduler.addClocked(r0);
        aOut.connect(a, sink);
        bOut.connect(b, sink);
        aOut.routeVia(r0, "Sink");
        bOut.routeVia(r0, "Sink");
        r0.addRoute("Sink", sink);
        scheduler.setHopSink([this](const HopRecord& hop) {
            if (hop.from == "R0") forwardOrder.push_back(hop.token);
        });
        for (int i = 0; i < perOrigin; ++i) aTokens.push_back(scheduler.seed<Payload>(a, 0, i));
        for (int i = 0; i < perOrigin; ++i) bTokens.push_back(scheduler.seed<Payload>(b, 0, i));
    }
};

void routerFifoDefaultUnchanged() {
    // Explicitly configured Fifo with defaults is bit-identical to the
    // pre-policy behavior: arrival order, one default-width packet per port
    // per cycle. Bandwidth is bits now, so "one packet" is one packet's width.
    ContentionRig rig(2);
    rig.r0.setArbitration(Router::Arbitration::Fifo);
    rig.r0.setBandwidth(default_event_bits);
    rig.r0.setQueueCapacity(0);
    rig.scheduler.runFor(8);
    const std::vector<TokenId> expected{rig.aTokens[0], rig.aTokens[1],
                                        rig.bTokens[0], rig.bTokens[1]};
    assert(rig.forwardOrder == expected);
    assert(rig.sink.values.size() == 4);
}

void routerRoundRobinAlternatesOrigins() {
    // A,A,B,B queued in arrival order forwards A,B,A,B under round-robin.
    ContentionRig rig(2);
    rig.r0.setArbitration(Router::Arbitration::RoundRobin);
    rig.scheduler.runFor(8);
    const std::vector<TokenId> expected{rig.aTokens[0], rig.bTokens[0],
                                        rig.aTokens[1], rig.bTokens[1]};
    assert(rig.forwardOrder == expected);
}

void routerFixedPriorityDrainsHighFirst() {
    // B outranks A (lower number = higher priority): all of B forwards
    // before any of A, even though A's packets arrived first.
    ContentionRig rig(2);
    rig.r0.setArbitration(Router::Arbitration::FixedPriority);
    rig.r0.setSourcePriority("B", 0);
    rig.r0.setSourcePriority("A", 1);
    rig.scheduler.runFor(8);
    const std::vector<TokenId> expected{rig.bTokens[0], rig.bTokens[1],
                                        rig.aTokens[0], rig.aTokens[1]};
    assert(rig.forwardOrder == expected);
}

void routerWeightedSharesBandwidth() {
    // Weights A=2, B=1 over a sustained backlog: deficit round-robin yields
    // the exact 2:1 pattern A,A,B,A,A,B.
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    Counter sink("Sink");
    Link aOut(scheduler, 1), bOut(scheduler, 1);
    Forwarder a("A", aOut), b("B", bOut);
    scheduler.addClocked(r0);
    aOut.connect(a, sink);
    bOut.connect(b, sink);
    aOut.routeVia(r0, "Sink");
    bOut.routeVia(r0, "Sink");
    r0.addRoute("Sink", sink);
    r0.setArbitration(Router::Arbitration::Weighted);
    r0.setSourceWeight("A", 2);
    r0.setSourceWeight("B", 1);

    std::vector<TokenId> forwardOrder;
    scheduler.setHopSink([&](const HopRecord& hop) {
        if (hop.from == "R0") forwardOrder.push_back(hop.token);
    });
    std::vector<TokenId> aTok, bTok;
    for (int i = 0; i < 4; ++i) aTok.push_back(scheduler.seed<Payload>(a, 0, i));
    for (int i = 0; i < 2; ++i) bTok.push_back(scheduler.seed<Payload>(b, 0, i));
    scheduler.runFor(10);

    const std::vector<TokenId> expected{aTok[0], aTok[1], bTok[0],
                                        aTok[2], aTok[3], bTok[1]};
    assert(forwardOrder == expected);
    assert(sink.values.size() == 6);

    // Weight 0 would silently starve an origin — rejected loudly instead.
    bool threw = false;
    try {
        r0.setSourceWeight("A", 0);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    assert(threw);
}

void routerPortBandwidthCap() {
    // Port bandwidth = two default packets' worth of bits: two of the
    // same-cycle contenders forward in the same tick (same arrive), the rest
    // follow a cycle later.
    ContentionRig rig(2); // A×2 + B×2 = 4 packets, all at R0 by cycle 1
    rig.r0.setPortBandwidth("Sink", 2 * default_event_bits);
    std::vector<Cycle> arrivals;
    rig.scheduler.setHopSink([&](const HopRecord& hop) {
        if (hop.from == "R0") arrivals.push_back(hop.arrive);
    });
    rig.scheduler.runFor(8);
    assert((arrivals == std::vector<Cycle>{2, 2, 3, 3}));

    bool threw = false;
    try {
        rig.r0.setBandwidth(0);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    assert(threw);
}

/// Cycles at which R0 forwarded, for a router fed by direct seeds.
static std::vector<Cycle> departsOfSeeded(std::vector<std::unique_ptr<Event>> packets,
                                          std::uint32_t bandwidthBits, Cycle firstAt,
                                          Cycle secondAt) {
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    AnySink sink("Sink");
    scheduler.addClocked(r0);
    r0.addRoute("Sink", sink);
    r0.addMatchRule("", "Sink"); // any type, any address
    r0.setBandwidth(bandwidthBits);
    std::vector<Cycle> departs;
    scheduler.setHopSink([&](const HopRecord& hop) {
        if (hop.from == "R0") departs.push_back(hop.depart);
    });
    Cycle at = firstAt;
    for (auto& packet : packets) {
        packet->finalDest = "Sink";
        scheduler.schedule(std::move(packet), r0, at);
        at = secondAt;
    }
    scheduler.runFor(40);
    return departs;
}

void routerWidePacketOccupiesPortForSeveralCycles() {
    // The point of metering bits: a packet four times the default width takes
    // four times as long to get out of the port, instead of costing the same
    // as a one-word notification.
    std::vector<std::unique_ptr<Event>> narrow;
    narrow.push_back(std::make_unique<Payload>(1));
    const std::vector<Cycle> narrowDeparts = departsOfSeeded(std::move(narrow), default_event_bits, 0, 0);

    std::vector<std::unique_ptr<Event>> wide;
    wide.push_back(std::make_unique<WidePayload>(1));
    const std::vector<Cycle> wideDeparts = departsOfSeeded(std::move(wide), default_event_bits, 0, 0);

    assert(narrowDeparts.size() == 1 && wideDeparts.size() == 1);
    // 4× the width at the same bandwidth = 3 extra cycles of serialization.
    assert(wideDeparts[0] == narrowDeparts[0] + 3);
}

void routerNarrowPacketsShareOneCycle() {
    // Eight eighth-width packets fit in the budget one default packet needs.
    std::vector<std::unique_ptr<Event>> packets;
    for (int i = 0; i < 8; ++i) packets.push_back(std::make_unique<NarrowPayload>());
    const std::vector<Cycle> departs = departsOfSeeded(std::move(packets), default_event_bits, 0, 0);
    assert(departs.size() == 8);
    for (const Cycle depart : departs) assert(depart == departs[0]);
}

void routerIdlePortDoesNotBankBandwidth() {
    // An idle port must not accumulate credit it can spend later — otherwise a
    // link that was quiet for a while would teleport an arbitrarily wide burst.
    std::vector<std::unique_ptr<Event>> packets;
    packets.push_back(std::make_unique<Payload>(1));     // drains at once
    packets.push_back(std::make_unique<WidePayload>(2)); // arrives much later
    const std::vector<Cycle> departs = departsOfSeeded(std::move(packets), default_event_bits, 0, 8);
    assert(departs.size() == 2);
    // Still three extra cycles of serialization, despite eight idle cycles.
    assert(departs[1] == 11);
}

void routerWeightedIsBitFair() {
    // Deficit round-robin with a BIT quantum: equal weights split the port's
    // bits evenly, so an origin sending 4×-wide packets gets a quarter as many
    // of them. Under the old packet quantum it would have taken four times the
    // bandwidth for the same weight.
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    AnySink sink("Sink");
    Link aOut(scheduler, 1), bOut(scheduler, 1);
    TypedForwarder<WidePayload> a("A", aOut);   // 4 words per packet
    TypedForwarder<Payload> b("B", bOut);       // 1 word per packet
    scheduler.addClocked(r0);
    aOut.connect(a, sink);
    bOut.connect(b, sink);
    aOut.routeVia(r0, "Sink");
    bOut.routeVia(r0, "Sink");
    r0.addRoute("Sink", sink);
    r0.setArbitration(Router::Arbitration::Weighted);
    r0.setSourceWeight("A", 1);
    r0.setSourceWeight("B", 1);
    r0.setBandwidth(default_event_bits);

    std::uint64_t bitsA = 0, bitsB = 0;
    scheduler.setHopSink([&](const HopRecord& hop) {
        if (hop.from != "R0") return;
        if (hop.event == "WidePayload") bitsA += 4 * default_event_bits;
        else bitsB += default_event_bits;
    });
    // Equal backlogs in BITS (512 each), so neither origin drains first and
    // the comparison stays about arbitration rather than about who ran out.
    for (int i = 0; i < 4; ++i) scheduler.seed<Payload>(a, 0, i);
    for (int i = 0; i < 16; ++i) scheduler.seed<Payload>(b, 0, i);
    scheduler.runFor(20); // partway through both backlogs

    assert(bitsA > 0 && bitsB > 0);
    assert(bitsA < 512 && bitsB < 512); // still contending, nobody drained
    // Within a couple of quanta of each other. Packet-quantum arbitration
    // would have handed A four times the bits for the same weight.
    const std::uint64_t gap = bitsA > bitsB ? bitsA - bitsB : bitsB - bitsA;
    assert(gap <= 4 * default_event_bits);
}

void routerBoundedQueueStallsUpstream() {
    // Capacity 1, three same-cycle arrivals: overflow packets wait on the
    // wire (rescheduled retries, no hop records), the queue never exceeds
    // its bound, and every packet still delivers in order.
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);
    Link s1Out(scheduler, 1), s2Out(scheduler, 1), s3Out(scheduler, 1);
    Counter b("B");
    Forwarder s1("S1", s1Out), s2("S2", s2Out), s3("S3", s3Out);
    s1Out.connect(s1, b);
    s2Out.connect(s2, b);
    s3Out.connect(s3, b);
    s1Out.routeVia(r0, "B");
    s2Out.routeVia(r0, "B");
    s3Out.routeVia(r0, "B");
    r0.addRoute("B", b);
    r0.setQueueCapacity(1);
    r0.setFullPolicy(Router::FullPolicy::Stall);

    std::size_t hopsIntoRouter = 0;
    std::vector<Cycle> arrivals;
    scheduler.setHopSink([&](const HopRecord& hop) {
        if (hop.to == "R0") ++hopsIntoRouter;
        if (hop.from == "R0") arrivals.push_back(hop.arrive);
    });
    std::vector<std::pair<Cycle, std::uint64_t>> stalls;
    scheduler.setMetricSink([&](const MetricRecord& m) {
        if (m.metric == "stall") stalls.emplace_back(m.cycle, m.value);
    });
    scheduler.seed<Payload>(s1, 0, 1);
    scheduler.seed<Payload>(s2, 0, 2);
    scheduler.seed<Payload>(s3, 0, 3);
    for (int cycle = 0; cycle < 8; ++cycle) {
        scheduler.runFor(1);
        assert(r0.pendingCount() <= 1); // the bound holds every cycle
    }

    assert(b.values == (std::vector<int>{2, 3, 4}));
    assert((arrivals == std::vector<Cycle>{2, 3, 4}));
    assert(hopsIntoRouter == 3); // retries emit no extra hop records
    assert(r0.pendingCount() == 0);
    // Two packets retried at cycle 1, one of them again at cycle 2.
    const std::vector<std::pair<Cycle, std::uint64_t>> expectedStalls{{1, 2}, {2, 1}};
    assert(stalls == expectedStalls);
}

void metricRecordJsonlShape() {
    std::ostringstream out;
    JsonlTraceWriter writer(out);

    MetricRecord depth;
    depth.metric = "qdepth";
    depth.component = "R1";
    depth.port = "Memory1";
    depth.cycle = 12;
    depth.value = 3;
    writer.write(depth);

    MetricRecord wide; // component-wide sample: port omitted entirely
    wide.metric = "stall";
    wide.component = "R0";
    wide.cycle = 3;
    wide.value = 1;
    writer.write(wide);

    assert(out.str() ==
           "{\"metric\":\"qdepth\",\"cycle\":12,\"component\":\"R1\",\"port\":\"Memory1\","
           "\"value\":3}\n"
           "{\"metric\":\"stall\",\"cycle\":3,\"component\":\"R0\",\"value\":1}\n");
}

void routerEmitsQdepthOnChangeOnly() {
    // Four packets drain one per cycle: qdepth reports each new settled
    // depth exactly once (3,2,1,0), then goes quiet; flow reports each
    // forwarding cycle.
    ContentionRig rig(2);
    std::vector<std::pair<Cycle, std::uint64_t>> depths;
    std::size_t flows = 0;
    rig.scheduler.setMetricSink([&](const MetricRecord& m) {
        assert(m.component == "R0" && m.port == "Sink");
        if (m.metric == "qdepth") depths.emplace_back(m.cycle, m.value);
        if (m.metric == "flow") ++flows;
    });
    rig.scheduler.runFor(12);

    const std::vector<std::pair<Cycle, std::uint64_t>> expected{{1, 3}, {2, 2}, {3, 1}, {4, 0}};
    assert(depths == expected);
    assert(flows == 4);
    assert(rig.sink.values.size() == 4);
}

void routerBoundedQueueDropReportsDivergence() {
    // Capacity 1, policy Drop: overflow packets are discarded and each loss
    // is reported through the divergence sink with kind "drop".
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);
    Link s1Out(scheduler, 1), s2Out(scheduler, 1), s3Out(scheduler, 1);
    Counter b("B");
    Forwarder s1("S1", s1Out), s2("S2", s2Out), s3("S3", s3Out);
    s1Out.connect(s1, b);
    s2Out.connect(s2, b);
    s3Out.connect(s3, b);
    s1Out.routeVia(r0, "B");
    s2Out.routeVia(r0, "B");
    s3Out.routeVia(r0, "B");
    r0.addRoute("B", b);
    r0.setQueueCapacity(1);
    r0.setFullPolicy(Router::FullPolicy::Drop);

    std::vector<DivergenceRecord> drops;
    scheduler.setDivergenceSink([&](const DivergenceRecord& d) { drops.push_back(d); });
    const TokenId t1 = scheduler.seed<Payload>(s1, 0, 1);
    const TokenId t2 = scheduler.seed<Payload>(s2, 0, 2);
    const TokenId t3 = scheduler.seed<Payload>(s3, 0, 3);
    (void)t1;
    scheduler.runFor(6);

    assert(b.values == (std::vector<int>{2})); // only the first survived
    assert(drops.size() == 2);
    assert(drops[0].kind == "drop" && drops[1].kind == "drop");
    assert(drops[0].token == t2 && drops[1].token == t3);
    assert(drops[0].component == "R0");
    assert(r0.pendingCount() == 0);
}

/// Sender for the match-rule tests: forwards the seeded payload with its
/// value doubling as the transaction address.
class AddrSender final : public Component {
public:
    AddrSender(std::string name, Link& out) : Component(std::move(name)), out_(out) {}
    void handler(Event& event) override {
        auto p = std::make_unique<Payload>(dynamic_cast<Payload&>(event).value);
        p->addr = static_cast<std::uint64_t>(p->value);
        out_.send(std::move(p));
    }
private:
    Link& out_;
};

void routerMatchRulesResolveByTypeAndAddress() {
    // Destination-less ingress: the link routes into R0 with NO finalDest;
    // R0's ordered rules resolve it from (type, addr).
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);
    Link out(scheduler, 1);
    Counter b("B");
    Counter c("C");
    AddrSender a("A", out);
    out.configureIn(&a);
    assert(!out.connected());
    out.routeVia(r0); // one-arg overload — no finalDest stamped
    assert(out.connected());
    r0.addMatchRule("Payload", 0x0, 0xfff, "B");
    r0.addMatchRule("Payload", 0x1000, 0x1fff, "C");
    r0.addRoute("B", b);
    r0.addRoute("C", c);

    scheduler.seed<Payload>(a, 0, 0x10);
    scheduler.seed<Payload>(a, 1, 0x1005);
    scheduler.runFor(8);

    assert(b.values == std::vector<int>{0x10});
    assert(c.values == std::vector<int>{0x1005});
    assert(r0.pendingCount() == 0);
}

void routerMatchRulesFirstMatchWins() {
    // Overlapping ranges: insertion order decides — 0x1500 hits the broad
    // first rule even though the second matches too.
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);
    Link out(scheduler, 1);
    Counter b("B");
    Counter c("C");
    AddrSender a("A", out);
    out.configureIn(&a);
    out.routeVia(r0);
    r0.addMatchRule("Payload", 0x0, 0xffff, "B");
    r0.addMatchRule("Payload", 0x1000, 0x1fff, "C");
    r0.addRoute("B", b);
    r0.addRoute("C", c);

    scheduler.seed<Payload>(a, 0, 0x1500);
    scheduler.runFor(6);

    assert(b.values == std::vector<int>{0x1500});
    assert(c.values.empty());
}

void routerMatchRulesAnyTypeAndAnyAddress() {
    // Empty message = any type; the two-arg overload = any address.
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);
    Link out(scheduler, 1);
    Counter b("B");
    Counter c("C");
    AddrSender a("A", out);
    out.configureIn(&a);
    out.routeVia(r0);
    r0.addMatchRule("", 0x0, 0xff, "B");   // range-only
    r0.addMatchRule("", "C");              // catch-all
    r0.addRoute("B", b);
    r0.addRoute("C", c);

    scheduler.seed<Payload>(a, 0, 0x10);
    scheduler.seed<Payload>(a, 1, 0x500);
    scheduler.runFor(8);

    assert(b.values == std::vector<int>{0x10});
    assert(c.values == std::vector<int>{0x500});
}

void routerUnmatchedPacketDropsAndReports() {
    // No rule covers 0x500: the packet is dropped, reported with kind
    // "drop", and the sim continues — a later matched packet still lands.
    Scheduler scheduler;
    Router r0("R0", scheduler, 1);
    scheduler.addClocked(r0);
    Link out(scheduler, 1);
    Counter b("B");
    AddrSender a("A", out);
    out.configureIn(&a);
    out.routeVia(r0);
    r0.addMatchRule("Payload", 0x0, 0xff, "B");
    r0.addRoute("B", b);

    std::vector<DivergenceRecord> drops;
    scheduler.setDivergenceSink([&](const DivergenceRecord& d) { drops.push_back(d); });

    const TokenId dropped = scheduler.seed<Payload>(a, 0, 0x500);
    scheduler.seed<Payload>(a, 1, 0x10);
    scheduler.runFor(8);

    assert(b.values == std::vector<int>{0x10});
    assert(drops.size() == 1);
    assert(drops[0].kind == "drop");
    assert(drops[0].component == "R0");
    assert(drops[0].token == dropped);
    assert(drops[0].detail.find("no forwarding rule matched") != std::string::npos);
    assert(drops[0].detail.find("type=Payload") != std::string::npos);
    assert(drops[0].detail.find("addr=0x500") != std::string::npos);
    assert(r0.pendingCount() == 0);
}

void routerRuleStampedDestRidesHopsAndLatencyModels() {
    // Rule resolution at the ingress composes with the dest-keyed hop tables
    // and setRouteLatency: A → R0 (rule stamps "B", model latency 3) → R1 → B.
    Scheduler scheduler;
    std::vector<HopRecord> hops;
    scheduler.setHopSink([&](const HopRecord& hop) { hops.push_back(hop); });

    Router r0("R0", scheduler, 1);
    Router r1("R1", scheduler, 1);
    scheduler.addClocked(r0);
    scheduler.addClocked(r1);
    Link out(scheduler, 1);
    Counter b("B");
    AddrSender a("A", out);
    out.configureIn(&a);
    out.routeVia(r0);
    r0.addMatchRule("Payload", 0x100, 0x1ff, "B");
    r0.addRoute("B", r1);
    r1.addRoute("B", b);
    r0.setRouteLatency("B", [](const Event& ev) { return ev.addr >= 0x100 ? Cycle{3} : Cycle{1}; });

    scheduler.seed<Payload>(a, 0, 0x150);
    scheduler.runFor(8);

    assert(b.values == std::vector<int>{0x150});
    assert(hops.size() == 3);
    assert(hops[0].from == "A" && hops[0].to == "R0");
    assert(hops[1].from == "R0" && hops[1].to == "R1");
    assert(hops[1].arrive - hops[1].depart == 3); // model, not the flat 1
    assert(hops[2].from == "R1" && hops[2].to == "B");
    assert(hops[0].addr == 0x150 && hops[1].addr == 0x150 && hops[2].addr == 0x150);
}

void legacyAddEventSurface() {
    Scheduler scheduler;
    Counter sink("sink");
    auto event = std::make_unique<Payload>(3);
    event->cycle = 2;
    event->dest = &sink;
    event->token = 9;
    scheduler.addEvent(std::move(event));
    scheduler.run(4); // legacy alias for runUntil
    assert(sink.values == std::vector<int>{3});
}

/* -------------------------------------------------------------------------
 * The registry. main() used to hand-list every case AND hand-count them in the
 * summary line, so adding a test meant remembering both — and forgetting the
 * first silently skipped it while still reporting a pass.
 *
 * Add a case here and nowhere else. The count is derived.
 *
 * Usage: engine_tests [substring]   — runs only the matching cases.
 * ------------------------------------------------------------------------- */

struct TestCase {
    const char* name;
    void (*fn)();
};

const TestCase kTests[] = {
    {"clockStartsAtZeroAndAdvances", clockStartsAtZeroAndAdvances},
    {"eventsDeliverFarInTheFuture", eventsDeliverFarInTheFuture},
    {"linksTraceAndPropagateTokens", linksTraceAndPropagateTokens},
    {"sendWithoutDestinationThrows", sendWithoutDestinationThrows},
    {"clockUsesSettleThenEdge", clockUsesSettleThenEdge},
    {"registryWiresByName", registryWiresByName},
    {"jsonlWriterShapes", jsonlWriterShapes},
    {"divertedLinkCapturesWithoutDelivery", divertedLinkCapturesWithoutDelivery},
    {"divergenceKindInJsonl", divergenceKindInJsonl},
    {"routerForwardsAlongMultiHopPath", routerForwardsAlongMultiHopPath},
    {"routerSerializesContentionPerOutputPort", routerSerializesContentionPerOutputPort},
    {"routerLatencyModelsArePerPacket", routerLatencyModelsArePerPacket},
    {"routerThrowsOnUnroutablePacket", routerThrowsOnUnroutablePacket},
    {"routerReportsPendingAtClockStop", routerReportsPendingAtClockStop},
    {"routerFifoDefaultUnchanged", routerFifoDefaultUnchanged},
    {"routerRoundRobinAlternatesOrigins", routerRoundRobinAlternatesOrigins},
    {"routerFixedPriorityDrainsHighFirst", routerFixedPriorityDrainsHighFirst},
    {"routerWeightedSharesBandwidth", routerWeightedSharesBandwidth},
    {"routerPortBandwidthCap", routerPortBandwidthCap},
    {"routerWidePacketOccupiesPortForSeveralCycles", routerWidePacketOccupiesPortForSeveralCycles},
    {"routerNarrowPacketsShareOneCycle", routerNarrowPacketsShareOneCycle},
    {"routerIdlePortDoesNotBankBandwidth", routerIdlePortDoesNotBankBandwidth},
    {"routerWeightedIsBitFair", routerWeightedIsBitFair},
    {"routerBoundedQueueStallsUpstream", routerBoundedQueueStallsUpstream},
    {"routerBoundedQueueDropReportsDivergence", routerBoundedQueueDropReportsDivergence},
    {"metricRecordJsonlShape", metricRecordJsonlShape},
    {"routerEmitsQdepthOnChangeOnly", routerEmitsQdepthOnChangeOnly},
    {"routerMatchRulesResolveByTypeAndAddress", routerMatchRulesResolveByTypeAndAddress},
    {"routerMatchRulesFirstMatchWins", routerMatchRulesFirstMatchWins},
    {"routerMatchRulesAnyTypeAndAnyAddress", routerMatchRulesAnyTypeAndAnyAddress},
    {"routerUnmatchedPacketDropsAndReports", routerUnmatchedPacketDropsAndReports},
    {"routerRuleStampedDestRidesHopsAndLatencyModels", routerRuleStampedDestRidesHopsAndLatencyModels},
    {"legacyAddEventSurface", legacyAddEventSurface},
};

/* An assert aborts, so the name of the case that died is otherwise lost among
 * a thousand lines of source. Park it where the SIGABRT handler can find it. */
const char* g_current = nullptr;

extern "C" void onAbort(int) {
    if (g_current) std::fprintf(stderr, "\n  FAILED in: %s\n", g_current);
    std::_Exit(1);
}

} // namespace

int main(int argc, char** argv) {
    std::signal(SIGABRT, onAbort);
    const std::string filter = argc > 1 ? argv[1] : "";
    const std::size_t total = sizeof(kTests) / sizeof(kTests[0]);

    std::size_t ran = 0;
    for (const TestCase& test : kTests) {
        if (!filter.empty() && std::string(test.name).find(filter) == std::string::npos) continue;
        g_current = test.name;
        test.fn();
        ++ran;
    }
    g_current = nullptr;

    if (!filter.empty() && ran == 0) {
        std::cerr << "no test matched '" << filter << "'\n";
        return 1;
    }
    std::cout << "engine tests: " << ran << "/" << (filter.empty() ? total : ran) << " passed\n";
    return 0;
}
