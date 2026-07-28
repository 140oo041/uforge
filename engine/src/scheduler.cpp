#include "microarch/scheduler.hpp"

#include <algorithm>
#include <stdexcept>
#include <string>
#include <utility>

namespace microarch {

std::size_t Scheduler::pending() const noexcept {
    std::size_t count = 0;
    for (const auto& [cycle, bucket] : calendar_) count += bucket.size();
    return count;
}

void Scheduler::schedule(std::unique_ptr<Event> event, Component& destination,
                         Cycle cycle) {
    if (!event) throw std::invalid_argument("Scheduler::schedule: null event");
    if (cycle < currentTick_)
        throw std::invalid_argument(
            "Scheduler::schedule: cycle " + std::to_string(cycle) +
            " is in the past (current " + std::to_string(currentTick_) + ")");
    event->cycle = cycle;
    event->dest = &destination;
    calendar_[cycle].push_back(std::move(event));
}

void Scheduler::scheduleNow(std::unique_ptr<Event> event, Component& destination) {
    schedule(std::move(event), destination, currentTick_);
}

void Scheduler::addEvent(std::unique_ptr<Event> event) {
    if (!event) throw std::invalid_argument("Scheduler::addEvent: null event");
    if (!event->dest) throw std::logic_error("Scheduler::addEvent: event has no dest");
    Component& destination = *event->dest;
    const Tick cycle = event->cycle < currentTick_ ? currentTick_ : event->cycle;
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
    return seed(std::move(event), destination, currentTick_);
}

ClockDomain& Scheduler::ensureReference() {
    // A design that never declares a clock gets one of period 1, so ticks and
    // cycles coincide and every pre-domain design behaves exactly as before.
    if (domains_.empty()) domains_.push_back(DomainSlot{ClockDomain("main", 1), {}});
    return domains_.front().clock;
}

const ClockDomain& Scheduler::addDomain(std::string name, Tick periodTicks, Tick phaseTicks,
                                        unsigned syncDepth) {
    for (const DomainSlot& slot : domains_)
        if (slot.clock.name() == name)
            throw std::invalid_argument("Scheduler::addDomain: duplicate domain '" + name + "'");
    domains_.push_back(
        DomainSlot{ClockDomain(std::move(name), periodTicks, phaseTicks, syncDepth), {}});
    return domains_.back().clock;
}

const ClockDomain& Scheduler::referenceDomain() const noexcept {
    return const_cast<Scheduler*>(this)->ensureReference();
}

Tick Scheduler::deliveryTick(const ClockDomain& domain, Cycle latency) const noexcept {
    // A zero-latency send from a clock edge still lands on the NEXT edge, so a
    // clock-edge output can never re-enter the cycle that produced it.
    if (phase_ == Phase::Commit && latency == 0) return domain.edgeAfter(currentTick_);
    return domain.advance(currentTick_, DomainCycle{latency});
}

Cycle Scheduler::deliveryCycle(Cycle latency) const noexcept {
    return deliveryTick(referenceDomain(), latency);
}

void Scheduler::addClocked(Component& component) {
    addClocked(component, ensureReference());
}

void Scheduler::addClocked(Component& component, const ClockDomain& domain) {
    for (const DomainSlot& slot : domains_)
        for (Component* existing : slot.clocked)
            if (existing == &component) return;
    for (DomainSlot& slot : domains_) {
        if (&slot.clock != &domain) continue;
        slot.clocked.push_back(&component);
        return;
    }
    throw std::invalid_argument("Scheduler::addClocked: domain is not registered here");
}

void Scheduler::removeClocked(Component& component) {
    for (DomainSlot& slot : domains_) {
        auto it = std::find(slot.clocked.begin(), slot.clocked.end(), &component);
        if (it != slot.clocked.end()) {
            slot.clocked.erase(it);
            return;
        }
    }
}

Tick Scheduler::nextTick() const noexcept {
    Tick next = calendar_.empty() ? tick_max : calendar_.begin()->first;
    for (const DomainSlot& slot : domains_) {
        if (slot.clocked.empty()) continue;
        // A domain whose every member is quiescent has no edge worth visiting.
        // quiescent() defaults to false, so by default nothing is ever skipped.
        bool idle = true;
        for (const Component* c : slot.clocked)
            if (!c->quiescent()) {
                idle = false;
                break;
            }
        if (idle) continue;
        next = std::min(next, slot.clock.edgeAfter(currentTick_));
    }
    return next;
}

void Scheduler::activeAt(Tick t, std::vector<Component*>& out) const {
    out.clear();
    for (const DomainSlot& slot : domains_) {
        if (slot.clocked.empty() || !slot.clock.isEdge(t)) continue;
        out.insert(out.end(), slot.clocked.begin(), slot.clocked.end());
    }
}

void Scheduler::reportDivergence(const Component& component, TokenId token,
                                 std::string detail, std::string kind) {
    if (!divergenceSink_) return;
    DivergenceRecord record;
    record.component = component.name();
    record.detail = std::move(detail);
    record.token = token;
    record.cycle = currentTick_;
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
    record.cycle = currentTick_;
    record.value = value;
    metricSink_(record);
}

void Scheduler::step() {
    // Phase 1 — dispatch every event due now, FIFO. Handlers may send more
    // events for this same tick (zero-latency links); re-find each iteration so
    // the loop keeps draining until the bucket is empty.
    phase_ = Phase::Dispatch;
    for (auto it = calendar_.find(currentTick_); it != calendar_.end();
         it = calendar_.find(currentTick_)) {
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

    // Only components whose own clock has an edge here run the clocked phases.
    std::vector<Component*> active;
    activeAt(currentTick_, active);
    if (active.empty()) {
        phase_ = Phase::Idle;
        return;
    }

    // Phase 2 — settle combinational logic (delta-cycles until quiescent).
    phase_ = Phase::Settle;
    std::size_t deltas = 0;
    bool again = true;
    while (again) {
        if (++deltas > maxDeltaCycles_)
            throw std::runtime_error("combinational logic did not settle");
        again = false;
        for (Component* component : active)
            if (component->settle(currentTick_)) again = true;
    }

    // Phase 3 — evaluate: every component computes next-state from
    // current-state only, so the result cannot depend on iteration order.
    phase_ = Phase::Evaluate;
    for (Component* component : active) component->evaluate(currentTick_);

    // Phase 4 — commit: publish next-state, then the clock edge itself.
    phase_ = Phase::Commit;
    for (Component* component : active) component->commit(currentTick_);
    for (Component* component : active) component->tick(currentTick_);

    phase_ = Phase::Idle;
}

bool Scheduler::hasWorkAt(Tick t) const noexcept {
    if (calendar_.find(t) != calendar_.end()) return true;
    for (const DomainSlot& slot : domains_) {
        if (slot.clocked.empty() || !slot.clock.isEdge(t)) continue;
        for (const Component* c : slot.clocked)
            if (!c->quiescent()) return true;
    }
    return false;
}

void Scheduler::runToTick(Tick endTick) {
    while (currentTick_ < endTick) {
        // The CURRENT tick first: nextTick() is strictly in the future, so
        // jumping straight to it would skip the tick we are standing on — and
        // with phase 0 that is the very first edge of every domain.
        if (hasWorkAt(currentTick_)) step();

        const Tick next = nextTick();
        if (next >= endTick) break;      // nothing left to do before the deadline
        currentTick_ = next;
    }
    // Time still passes even when nothing happened in it.
    if (currentTick_ < endTick) currentTick_ = endTick;
}

void Scheduler::runFor(Cycle count) {
    const ClockDomain& ref = referenceDomain();
    runToTick(currentTick_ + count * ref.period());
}

void Scheduler::runUntil(Cycle endExclusive) {
    const ClockDomain& ref = referenceDomain();
    runToTick(ref.tickOfCycle(DomainCycle{endExclusive}));
}

} // namespace microarch
