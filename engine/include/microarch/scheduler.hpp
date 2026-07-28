#pragma once

#include <cstddef>
#include <deque>
#include <map>
#include <memory>
#include <vector>

#include "microarch/component.hpp"
#include "microarch/event.hpp"
#include "microarch/trace.hpp"

namespace microarch {

/// The clock. Owns the pending-event calendar, mints transaction tokens,
/// runs the two-phase (dispatch → settle → tick) cycle loop, and fans hop /
/// divergence records out to installed sinks.
///
/// Design notes (fixes over the original ISS infra engine):
///  - the clock is zero-initialized and advances every cycle;
///  - the calendar is a std::map keyed by absolute cycle — no fixed-size ring,
///    so events may be scheduled arbitrarily far ahead;
///  - Event carries a TokenId so traces thread hops into per-instruction
///    tokens; handlers' output events inherit the in-flight token.
class Scheduler {
public:
    enum class Phase { Idle, Dispatch, Settle, Tick };

    explicit Scheduler(std::size_t maxDeltaCycles = 1024)
        : maxDeltaCycles_(maxDeltaCycles) {}

    Cycle currentCycle() const noexcept { return currentCycle_; }
    Cycle getCurrentCyle() const noexcept { return currentCycle_; } // legacy alias
    Phase phase() const noexcept { return phase_; }
    bool empty() const noexcept { return calendar_.empty(); }
    std::size_t pending() const noexcept;

    /// Schedule an event for `destination` at an absolute `cycle`.
    /// Throws std::invalid_argument if the cycle is already in the past.
    void schedule(std::unique_ptr<Event> event, Component& destination, Cycle cycle);
    void scheduleNow(std::unique_ptr<Event> event, Component& destination);

    /// Legacy surface: destination and cycle are read off the event itself.
    void addEvent(std::unique_ptr<Event> event);

    /// Seed a new transaction: mints a fresh token, stamps it on the event,
    /// and schedules it. Returns the token so harnesses can correlate.
    TokenId seed(std::unique_ptr<Event> event, Component& destination, Cycle cycle);
    TokenId seedNow(std::unique_ptr<Event> event, Component& destination);

    template <typename EventT, typename... Args>
    TokenId seed(Component& destination, Cycle cycle, Args&&... args) {
        return seed(std::make_unique<EventT>(std::forward<Args>(args)...), destination, cycle);
    }
    template <typename EventT, typename... Args>
    TokenId seedNow(Component& destination, Args&&... args) {
        return seed<EventT>(destination, currentCycle_, std::forward<Args>(args)...);
    }

    /// Mint a fresh transaction token without scheduling anything. For
    /// components that originate traffic from their own tick() (traffic
    /// generators), where there is no in-flight token to inherit.
    TokenId mintToken() noexcept { return nextToken_++; }

    /// The cycle an event sent now with `latency` arrives. Phase-aware: a
    /// zero-latency send during the Tick phase still lands next cycle, so
    /// clock-edge outputs can never re-enter the cycle that produced them.
    Cycle deliveryCycle(Cycle latency) const noexcept;

    /// Register a component for the settle()/tick() clock phases.
    void addClocked(Component& component);
    void removeClocked(Component& component);

    void setHopSink(HopSink sink) { hopSink_ = std::move(sink); }
    const HopSink& hopSink() const noexcept { return hopSink_; }
    void setDivergenceSink(DivergenceSink sink) { divergenceSink_ = std::move(sink); }
    void setMetricSink(MetricSink sink) { metricSink_ = std::move(sink); }
    const MetricSink& metricSink() const noexcept { return metricSink_; }

    /// Surface a cross-verification disagreement at the current cycle.
    /// `kind` tags the source ("" = architectural, "cosim" = SV vs C++ shadow).
    void reportDivergence(const Component& component, TokenId token, std::string detail,
                          std::string kind = "");

    /// Emit a performance sample at the current cycle. `port` may be empty
    /// for component-wide samples. No-op without an installed metric sink.
    void reportMetric(const Component& component, std::string metric, std::string port,
                      std::uint64_t value);

    /// Token currently being dispatched (no_token outside a handler). Links
    /// use this to propagate the transaction id onto output events.
    TokenId activeToken() const noexcept { return activeToken_; }
    /// Stamp the active token onto an event that doesn't carry one yet.
    void fillToken(Event& event) const noexcept {
        if (event.token == no_token) event.token = activeToken_;
    }

    /// Take ownership of the event currently being dispatched. For handlers
    /// that store events instead of consuming them in place (Router queues a
    /// packet until its arbitration slot). Null outside Dispatch or if the
    /// event was already taken; a handler that doesn't call this sees no
    /// change — the dispatch loop drops the event after the handler returns.
    std::unique_ptr<Event> releaseActiveEvent() noexcept {
        return std::move(activeEvent_);
    }

    /// Advance exactly `count` cycles (each cycle: dispatch, settle, tick).
    void runFor(Cycle count);
    /// Advance until currentCycle() == endExclusive.
    void runUntil(Cycle endExclusive);
    void run(Cycle maxCycles) { runUntil(maxCycles); } // legacy alias

private:
    void runCycle();

    Cycle currentCycle_ = 0;
    Phase phase_ = Phase::Idle;
    TokenId nextToken_ = 0;
    TokenId activeToken_ = no_token;
    std::unique_ptr<Event> activeEvent_;
    std::size_t maxDeltaCycles_;
    std::map<Cycle, std::deque<std::unique_ptr<Event>>> calendar_;
    std::vector<Component*> clocked_;
    HopSink hopSink_;
    DivergenceSink divergenceSink_;
    MetricSink metricSink_;
};

} // namespace microarch
