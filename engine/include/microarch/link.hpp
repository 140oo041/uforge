#pragma once

#include <functional>
#include <memory>
#include <utility>

#include "microarch/component.hpp"
#include "microarch/event.hpp"

namespace microarch {

class Scheduler;

/// Consumer for events captured off a diverted Link (see Link::divert).
using EventTap = std::function<void(std::unique_ptr<Event>)>;

/// A directed wire between two components. Carries Events with a per-link
/// latency and emits a HopRecord on every send when the scheduler has a hop
/// sink installed — the seam the IDE's trace animation hangs off.
class Link {
public:
    explicit Link(Scheduler& scheduler, Cycle latencyCycles = 1)
        : latency(latencyCycles), scheduler_(scheduler) {}

    Link(Scheduler& scheduler, Component& source, Component& destination,
         Cycle latencyCycles = 1)
        : latency(latencyCycles), scheduler_(scheduler), in_(&source), out_(&destination) {}

    void configureIn(Component* source) noexcept { in_ = source; }
    void configureOut(Component* destination) noexcept { out_ = destination; }
    void connect(Component& source, Component& destination) noexcept {
        in_ = &source;
        out_ = &destination;
    }

    Component* source() const noexcept { return in_; }
    Component* destination() const noexcept { return out_; }
    /// True when send() has somewhere to go: a configured destination or a
    /// via router — the guard generated blocks use before sending.
    bool connected() const noexcept { return out_ != nullptr || via_ != nullptr; }
    Cycle delay() const noexcept { return latency; }
    void setLatency(Cycle value) noexcept { latency = value; }

    /// Public so legacy generated code can write `link->latency = N`.
    Cycle latency = 1;

    /// Deliver `event` to the configured destination after `latency` cycles.
    /// Throws std::logic_error if the destination is unset, or
    /// std::invalid_argument if the event is null.
    void send(std::unique_ptr<Event> event);

    template <typename EventT, typename... Args>
    void send(Args&&... args) {
        send(std::make_unique<EventT>(std::forward<Args>(args)...));
    }

    /// Capture seam for shadow execution: a diverted link hands every sent
    /// event (token filled in) to `tap` instead of scheduling it — nothing is
    /// delivered into the design and no hop is traced. Used by the co-sim
    /// divergence check to observe a C++ shadow block's would-be outputs.
    void divert(EventTap tap) noexcept { tap_ = std::move(tap); }

    /// Fabric interposition: route this link's traffic through `via` (a
    /// Router) instead of delivering straight to the configured destination.
    /// Every sent event gets `finalDest` stamped (the registry id the fabric
    /// routes toward) and is delivered to `via` after this link's latency;
    /// `configureOut` stays untouched — generated wire() code is unaffected.
    void routeVia(Component& via, std::string finalDest) {
        via_ = &via;
        finalDest_ = std::move(finalDest);
    }

    /// Fabric ingress without a pre-resolved destination: deliver to `via`;
    /// the ingress router resolves finalDest itself via its match rules
    /// (first match on message type + address). finalDest is NOT stamped.
    void routeVia(Component& via) {
        via_ = &via;
        finalDest_.clear();
    }

private:
    Scheduler& scheduler_;
    Component* in_ = nullptr;
    Component* out_ = nullptr;
    EventTap tap_;
    Component* via_ = nullptr;
    std::string finalDest_;
};

} // namespace microarch
