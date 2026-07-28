#include "microarch/scheduler.hpp"

#include <stdexcept>
#include <string>

namespace microarch {

std::size_t Scheduler::pending() const noexcept {
    std::size_t count = 0;
    for (const auto& [cycle, bucket] : calendar_) count += bucket.size();
    return count;
}

void Scheduler::schedule(std::unique_ptr<Event> event, Component& destination,
                         Cycle cycle) {
    if (!event) throw std::invalid_argument("Scheduler::schedule: null event");
    if (cycle < currentCycle_)
        throw std::invalid_argument(
            "Scheduler::schedule: cycle " + std::to_string(cycle) +
            " is in the past (current " + std::to_string(currentCycle_) + ")");
    event->cycle = cycle;
    event->dest = &destination;
    calendar_[cycle].push_back(std::move(event));
}

void Scheduler::scheduleNow(std::unique_ptr<Event> event, Component& destination) {
    schedule(std::move(event), destination, currentCycle_);
}

void Scheduler::addEvent(std::unique_ptr<Event> event) {
    if (!event) throw std::invalid_argument("Scheduler::addEvent: null event");
    if (!event->dest) throw std::logic_error("Scheduler::addEvent: event has no dest");
    Component& destination = *event->dest;
    const Cycle cycle = event->cycle < currentCycle_ ? currentCycle_ : event->cycle;
    schedule(std::move(event), destination, cycle);
}

TokenId Scheduler::seed(std::unique_ptr<Event> event, Component& destination,
                        Cycle cycle) {
    if (!event) throw std::invalid_argument("Scheduler::seed: null event");
    const TokenId token = nextToken_++;
    event->token = token;
    schedule(std::move(event), destination, cycle);
    return token;
}

TokenId Scheduler::seedNow(std::unique_ptr<Event> event, Component& destination) {
    return seed(std::move(event), destination, currentCycle_);
}

Cycle Scheduler::deliveryCycle(Cycle latency) const noexcept {
    // During the Tick phase a zero-latency send still lands next cycle, so a
    // clock-edge output can never re-enter the cycle that produced it.
    if (phase_ == Phase::Tick && latency == 0) return currentCycle_ + 1;
    return currentCycle_ + latency;
}

void Scheduler::addClocked(Component& component) {
    for (Component* existing : clocked_)
        if (existing == &component) return;
    clocked_.push_back(&component);
}

void Scheduler::removeClocked(Component& component) {
    for (auto it = clocked_.begin(); it != clocked_.end(); ++it) {
        if (*it == &component) {
            clocked_.erase(it);
            return;
        }
    }
}

void Scheduler::reportDivergence(const Component& component, TokenId token,
                                 std::string detail, std::string kind) {
    if (!divergenceSink_) return;
    DivergenceRecord record;
    record.component = component.name();
    record.detail = std::move(detail);
    record.token = token;
    record.cycle = currentCycle_;
    record.kind = std::move(kind);
    divergenceSink_(record);
}

void Scheduler::reportMetric(const Component& component, std::string metric, std::string port,
                             std::uint64_t value) {
    if (!metricSink_) return;
    MetricRecord record;
    record.metric = std::move(metric);
    record.component = component.name();
    record.port = std::move(port);
    record.cycle = currentCycle_;
    record.value = value;
    metricSink_(record);
}

void Scheduler::runCycle() {
    // Phase 1 — dispatch every event due this cycle, FIFO within the cycle.
    // Handlers may send more events (even for this same cycle, via
    // zero-latency links); the loop keeps draining until the bucket is empty.
    phase_ = Phase::Dispatch;
    for (auto it = calendar_.find(currentCycle_); it != calendar_.end();
         it = calendar_.find(currentCycle_)) {
        auto& bucket = it->second;
        if (bucket.empty()) {
            calendar_.erase(it);
            break;
        }
        // Held in a member so a handler may steal ownership
        // (releaseActiveEvent); reset() is a no-op if it did.
        activeEvent_ = std::move(bucket.front());
        bucket.pop_front();
        activeToken_ = activeEvent_->token;
        Component* dest = activeEvent_->dest;
        dest->handler(*activeEvent_);
        activeEvent_.reset();
        activeToken_ = no_token;
    }

    // Phase 2 — settle combinational logic (delta-cycles until quiescent).
    phase_ = Phase::Settle;
    std::size_t deltas = 0;
    bool again = !clocked_.empty();
    while (again) {
        if (++deltas > maxDeltaCycles_)
            throw std::runtime_error("combinational logic did not settle");
        again = false;
        for (Component* component : clocked_)
            if (component->settle(currentCycle_)) again = true;
    }

    // Phase 3 — clock edge.
    phase_ = Phase::Tick;
    for (Component* component : clocked_) component->tick(currentCycle_);

    phase_ = Phase::Idle;
    ++currentCycle_;
}

void Scheduler::runFor(Cycle count) {
    for (Cycle i = 0; i < count; ++i) runCycle();
}

void Scheduler::runUntil(Cycle endExclusive) {
    while (currentCycle_ < endExclusive) runCycle();
}

} // namespace microarch
