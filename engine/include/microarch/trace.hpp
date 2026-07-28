#pragma once

#include <functional>
#include <ostream>
#include <string>

#include <vector>

#include "microarch/event.hpp"
#include "microarch/time.hpp"

namespace microarch {

/// What the time numbers in a trace MEAN.
///
/// Every `depart`, `arrive` and `cycle` field below is an absolute tick, and a
/// tick is meaningless without this. Written as the FIRST line of a trace and
/// required by the reader: a consumer that takes ticks for cycles is off by the
/// period, silently — the playhead just appears frozen and nothing errors.
struct TimebaseRecord {
    struct Domain {
        std::string name;
        Tick periodTicks = 1;
        Tick phaseTicks = 0;
        unsigned syncDepth = 0;
    };
    std::uint64_t femtosPerTick = default_femtos_per_tick;
    std::vector<Domain> domains;
    /// Index of the reference clock — the one runFor() counts.
    std::size_t reference = 0;
};

/// One event hand-off: a token leaving `from` and arriving at `to`.
/// Emitted automatically by every Link::send when a hop sink is installed.
struct HopRecord {
    std::string from;
    std::string to;
    std::string event;
    TokenId token = no_token;
    Cycle depart = 0;
    Cycle arrive = 0;
    /// Transaction address the event carried (0 = unaddressed). Emitted to
    /// the JSONL as a hex STRING only when nonzero — uint64 values must
    /// never reach JS as numbers (2^53 precision).
    std::uint64_t addr = 0;
};

/// A cross-verification disagreement localized to a component + cycle + token.
/// `kind` distinguishes the divergence source ("" = architectural oracle,
/// "cosim" = SV twin vs C++ shadow) — empty is omitted from the JSONL so old
/// traces and old consumers are unaffected.
struct DivergenceRecord {
    std::string component;
    std::string detail;
    TokenId token = no_token;
    Cycle cycle = 0;
    std::string kind;
};

/// A performance sample localized to a component (and optionally one of its
/// ports) at a cycle. Kinds emitted today (all by Router):
///   "qdepth" — settled per-port queue depth at tick end, change-only;
///   "flow"   — packets forwarded on a port this cycle (omitted when 0);
///   "bits"   — their total width; bandwidth is metered in bits, so packet
///              counts alone don't say how loaded a port was;
///   "stall"  — full-queue retries charged to a port this cycle (omitted
///              when 0).
/// `port` is empty for component-wide samples and omitted from the JSONL,
/// mirroring the divergence-`kind` precedent.
struct MetricRecord {
    std::string metric;
    std::string component;
    std::string port;
    Cycle cycle = 0;
    std::uint64_t value = 0;
};

using HopSink = std::function<void(const HopRecord&)>;
using DivergenceSink = std::function<void(const DivergenceRecord&)>;
using MetricSink = std::function<void(const MetricRecord&)>;

/// Writes hop / divergence / metric records as JSONL, one object per line —
/// the trace contract the IDE consumes (ide/src/trace/parse.ts):
///
///   {"token":0,"from":"IF","to":"DE","event":"FetchEvent","depart":0,"arrive":1}
///   {"diverge":true,"cycle":5,"component":"EX","token":0,"detail":"x5 mismatch"}
///   {"metric":"qdepth","cycle":12,"component":"R1","port":"Memory1","value":3}
class JsonlTraceWriter {
public:
    explicit JsonlTraceWriter(std::ostream& out) : out_(out) {}

    void write(const TimebaseRecord& timebase);

    void write(const HopRecord& hop);
    void write(const DivergenceRecord& divergence);
    void write(const MetricRecord& metric);

    HopSink hopSink() {
        return [this](const HopRecord& hop) { write(hop); };
    }
    DivergenceSink divergenceSink() {
        return [this](const DivergenceRecord& d) { write(d); };
    }
    MetricSink metricSink() {
        return [this](const MetricRecord& m) { write(m); };
    }

private:
    std::ostream& out_;
};

/// JSON-escape a string (quotes, backslash, control characters).
std::string jsonString(const std::string& raw);

} // namespace microarch
