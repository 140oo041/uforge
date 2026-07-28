#include "microarch/router.hpp"

#include <algorithm>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <utility>
#include <vector>

#include "microarch/scheduler.hpp"

namespace microarch {

/// Distinct origin names, sorted — the deterministic visiting universe for
/// the origin-aware policies.
static std::vector<std::string> distinctOrigins(const std::deque<std::string>& names) {
    std::vector<std::string> origins(names.begin(), names.end());
    std::sort(origins.begin(), origins.end());
    origins.erase(std::unique(origins.begin(), origins.end()), origins.end());
    return origins;
}

/// Lowercase hex with 0x prefix — the divergence-detail address format.
static std::string toHex(std::uint64_t value) {
    char buf[19];
    std::snprintf(buf, sizeof buf, "0x%llx", static_cast<unsigned long long>(value));
    return buf;
}

Router::Router(std::string name, Scheduler& scheduler, Cycle hopLatency)
    : Component(std::move(name)), scheduler_(scheduler), hopLatency_(hopLatency) {}

void Router::addMatchRule(std::string message, std::uint64_t lo, std::uint64_t hi,
                          std::string finalDest) {
    if (lo > hi)
        throw std::invalid_argument("Router " + name() + ": match rule lo > hi");
    MatchRule rule;
    rule.message = std::move(message);
    rule.lo = lo;
    rule.hi = hi;
    rule.finalDest = std::move(finalDest);
    matchRules_.push_back(std::move(rule));
}

void Router::addMatchRule(std::string message, std::string finalDest) {
    addMatchRule(std::move(message), 0, std::numeric_limits<std::uint64_t>::max(),
                 std::move(finalDest));
}

void Router::addRoute(const std::string& finalDest, Component& nextHop) {
    routes_[finalDest] = &nextHop;
    auto& link = links_[&nextHop];
    if (!link) {
        link = std::make_unique<Link>(scheduler_, hopLatency_);
        link->configureIn(this);
        link->configureOut(&nextHop);
    }
}

void Router::setRouteLatency(const std::string& finalDest, LatencyModel model) {
    models_[finalDest] = std::move(model);
}

void Router::setSourceWeight(const std::string& origin, std::uint32_t weight) {
    if (weight == 0)
        throw std::invalid_argument("Router " + name() + ": weight 0 for '" + origin +
                                    "' would starve it — use FixedPriority instead");
    weights_[origin] = weight;
}

void Router::setSourcePriority(const std::string& origin, std::uint32_t priority) {
    priorities_[origin] = priority;
}

void Router::setBandwidth(std::uint32_t bitsPerPortPerCycle) {
    if (bitsPerPortPerCycle == 0)
        throw std::invalid_argument("Router " + name() + ": bandwidth 0 bits forwards nothing");
    bandwidth_ = bitsPerPortPerCycle;
}

void Router::setPortBandwidth(const std::string& nextHopName, std::uint32_t bitsPerCycle) {
    if (bitsPerCycle == 0)
        throw std::invalid_argument("Router " + name() + ": bandwidth 0 bits forwards nothing");
    portBandwidth_[nextHopName] = bitsPerCycle;
}

void Router::handler(Event& event) {
    // Ingress resolution: a packet arriving without a finalDest is matched
    // against the ordered rules (message type + inclusive address range).
    // No match → drop + report; the sim continues (real fabrics surface
    // decode errors, they don't halt).
    if (event.finalDest.empty()) {
        const MatchRule* hit = nullptr;
        for (const MatchRule& rule : matchRules_)
            if ((rule.message.empty() || rule.message == event.type()) &&
                event.addr >= rule.lo && event.addr <= rule.hi) {
                hit = &rule;
                break;
            }
        if (!hit) {
            // Not stolen — the dispatch loop frees the event.
            scheduler_.reportDivergence(*this, event.token,
                                        "no forwarding rule matched type=" + event.type() +
                                            " addr=" + toHex(event.addr),
                                        "drop");
            return;
        }
        event.finalDest = hit->finalDest;
    }

    // A stamped finalDest with no hop route is a codegen bug — stay loud.
    const auto route = routes_.find(event.finalDest);
    if (route == routes_.end())
        throw std::logic_error("Router " + name() + ": no route for '" + event.finalDest + "'");

    Queue& queue = queues_[route->second];
    if (queueCapacity_ != 0 && queue.size() >= queueCapacity_) {
        if (fullPolicy_ == FullPolicy::Drop) {
            // Not stolen — the dispatch loop frees the event. The loss is
            // reported, never silent.
            scheduler_.reportDivergence(*this, event.token,
                                        "packet dropped: queue full on port to " +
                                            route->second->name(),
                                        "drop");
            return;
        }
        // Stall: the packet waits on the wire — retry at next cycle's
        // dispatch. No Link::send, so no hop record; a traced token dwells.
        std::unique_ptr<Event> owned = scheduler_.releaseActiveEvent();
        if (!owned)
            throw std::logic_error("Router " + name() + ": event not stealable (nested dispatch?)");
        ++stallCount_[route->second];
        scheduler_.schedule(std::move(owned), *this, scheduler_.currentCycle() + 1);
        return;
    }

    // Take ownership from the dispatch loop and park the packet on its
    // output port; it forwards at this (or a later) cycle's Tick.
    std::unique_ptr<Event> owned = scheduler_.releaseActiveEvent();
    if (!owned)
        throw std::logic_error("Router " + name() + ": event not stealable (nested dispatch?)");
    Queued entry;
    entry.origin = owned->origin;
    entry.enqueued = scheduler_.currentCycle();
    entry.event = std::move(owned);
    queue.push_back(std::move(entry));
}

std::uint32_t Router::portBandwidth(const Component& nextHop) const noexcept {
    const auto it = portBandwidth_.find(nextHop.name());
    return it != portBandwidth_.end() ? it->second : bandwidth_;
}

std::uint32_t Router::weightOf(const std::string& origin) const noexcept {
    const auto it = weights_.find(origin);
    return it != weights_.end() ? it->second : 1;
}

std::uint32_t Router::priorityOf(const std::string& origin) const noexcept {
    const auto it = priorities_.find(origin);
    return it != priorities_.end() ? it->second
                                   : std::numeric_limits<std::uint32_t>::max();
}

Router::Queue::iterator Router::pickNext(Component* port, Queue& queue, bool commit) {
    if (queue.empty()) return queue.end();
    if (arbitration_ == Arbitration::Fifo) return queue.begin();

    // Distinct origins present, sorted for determinism.
    std::deque<std::string> names;
    for (const Queued& entry : queue) names.push_back(entry.origin);
    const std::vector<std::string> origins = distinctOrigins(names);

    const auto oldestOf = [&queue](const std::string& origin) {
        return std::find_if(queue.begin(), queue.end(),
                            [&origin](const Queued& q) { return q.origin == origin; });
    };

    if (arbitration_ == Arbitration::FixedPriority) {
        // Lowest priority number drains first; origins is sorted, so the
        // first minimum wins ties by name.
        const std::string* best = &origins.front();
        for (const std::string& origin : origins)
            if (priorityOf(origin) < priorityOf(*best)) best = &origin;
        return oldestOf(*best);
    }

    // RoundRobin and Weighted visit origins in cyclic name order, starting
    // after the port's cursor.
    const auto visitOrder = [&origins](const std::string& cursor) {
        std::vector<std::string> order;
        order.reserve(origins.size());
        auto pivot = std::upper_bound(origins.begin(), origins.end(), cursor);
        order.insert(order.end(), pivot, origins.end());
        order.insert(order.end(), origins.begin(), pivot);
        return order;
    };

    std::string& storedCursor = rrCursor_[port];
    std::string cursor = storedCursor;

    if (arbitration_ == Arbitration::RoundRobin) {
        const std::string next = visitOrder(cursor).front();
        if (commit) storedCursor = next;
        return oldestOf(next);
    }

    // Weighted: BIT-quantum deficit round-robin — the textbook DRR, now that
    // packets have real widths. Each visit tops an origin up by
    // weight × bandwidth bits; an origin forwards while its deficit covers the
    // width of its head packet. Charging per packet instead would hand a
    // stream of wide packets the same share as a stream of narrow ones, which
    // is precisely the unfairness DRR exists to prevent.
    //
    // Everything below works on a local copy of the port's deficits and is
    // written back only when the caller commits, so a pick that the bit budget
    // cannot afford this cycle costs nothing.
    std::map<std::string, std::uint64_t> deficits = deficit_[port];
    for (auto it = deficits.begin(); it != deficits.end();) {
        if (!std::binary_search(origins.begin(), origins.end(), it->first))
            it = deficits.erase(it); // backlog drained — no hoarding
        else
            ++it;
    }
    const std::uint64_t quantum = portBandwidth(*port);
    const auto writeBack = [&](const std::string& winner) {
        if (!commit) return;
        deficit_[port] = deficits;
        storedCursor = winner;
    };

    if (std::binary_search(origins.begin(), origins.end(), cursor)) {
        const auto head = oldestOf(cursor);
        if (head != queue.end() && deficits[cursor] >= head->event->bits) {
            deficits[cursor] -= head->event->bits;
            writeBack(cursor);
            return head;
        }
    }
    // Rotate, topping each origin up, until one can pay for its head packet.
    // Bounded by a full sweep per origin so a packet wider than any single
    // top-up still accumulates over successive calls rather than spinning.
    for (const std::string& origin : visitOrder(cursor)) {
        const auto head = oldestOf(origin);
        if (head == queue.end()) continue;
        std::uint64_t& deficit = deficits[origin];
        deficit += quantum * weightOf(origin);
        if (deficit >= head->event->bits) {
            deficit -= head->event->bits;
            writeBack(origin);
            return head;
        }
    }
    // Nobody could pay yet — the top-ups still count toward the next attempt.
    if (commit) deficit_[port] = deficits;
    return queue.end();
}

void Router::forward(Component& nextHop, std::unique_ptr<Event> event) {
    // Hop latency is per packet: the route's LatencyModel when one is
    // assigned, else the flat constant. Tick-phase sends land at
    // currentCycle + latency (next cycle for latency 0 — deliveryCycle is
    // phase-aware), so a port's contenders serialize while distinct ports
    // forward in parallel.
    Link& link = *links_.at(&nextHop);
    const auto model = models_.find(event->finalDest);
    link.latency = model != models_.end() ? model->second(*event) : hopLatency_;
    link.send(std::move(event));
}

void Router::tick(Cycle) {
    for (auto& [next, queue] : queues_) {
        // The port's budget is bits, not packets. Unspent budget carries so a
        // packet wider than one cycle's bandwidth serializes across cycles
        // (a 512-bit fill on a 128 b/cy port takes four) rather than either
        // teleporting or jamming the port forever.
        std::uint64_t& credit = credit_[next];
        credit += portBandwidth(*next);

        std::uint32_t sent = 0;
        std::uint64_t bitsSent = 0;
        while (!queue.empty()) {
            const auto probe = pickNext(next, queue, /*commit=*/false);
            if (probe == queue.end()) {
                // Weighted arbitration funded nobody this round; let the
                // top-ups land for real so a later cycle can pay.
                if (arbitration_ == Arbitration::Weighted) pickNext(next, queue, /*commit=*/true);
                break;
            }
            const std::uint64_t cost = std::max<std::uint32_t>(1, probe->event->bits);
            if (credit < cost) break; // head-of-line packet is still in flight
            const auto it = pickNext(next, queue, /*commit=*/true);
            if (it == queue.end()) break;
            credit -= cost;
            bitsSent += cost;
            ++sent;
            std::unique_ptr<Event> event = std::move(it->event);
            queue.erase(it);
            forward(*next, std::move(event));
        }
        // An idle port cannot bank bandwidth for a later burst.
        if (queue.empty()) credit = 0;

        // Per-cycle port metrics: forwards and full-queue retries when they
        // happened, and the settled queue depth when it changed.
        if (sent > 0) {
            scheduler_.reportMetric(*this, "flow", next->name(), sent);
            scheduler_.reportMetric(*this, "bits", next->name(), bitsSent);
        }
        const auto stalled = stallCount_.find(next);
        if (stalled != stallCount_.end() && stalled->second > 0) {
            scheduler_.reportMetric(*this, "stall", next->name(), stalled->second);
            stalled->second = 0;
        }
        std::size_t& lastDepth = lastReportedDepth_[next];
        if (queue.size() != lastDepth) {
            scheduler_.reportMetric(*this, "qdepth", next->name(), queue.size());
            lastDepth = queue.size();
        }
    }
}

std::size_t Router::pendingCount() const noexcept {
    std::size_t pending = 0;
    for (const auto& [next, queue] : queues_) pending += queue.size();
    return pending;
}

} // namespace microarch
