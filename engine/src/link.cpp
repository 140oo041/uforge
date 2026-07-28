#include "microarch/link.hpp"

#include <stdexcept>

#include "microarch/scheduler.hpp"

namespace microarch {

void Link::send(std::unique_ptr<Event> event) {
    if (!event) throw std::invalid_argument("Link::send: null event");

    // Diverted link: the tap consumes the event — no delivery, no hop trace.
    if (tap_) {
        scheduler_.fillToken(*event);
        tap_(std::move(event));
        return;
    }

    if (!out_ && !via_)
        throw std::logic_error("Link::send: destination not configured (configureOut)");

    // Fabric-routed link: the first hop goes to the router, which forwards
    // toward the stamped final destination hop by hop. A destination-less
    // routeVia leaves finalDest empty — the ingress router's match rules
    // resolve it on arrival.
    Component* target = via_ ? via_ : out_;
    if (via_ && !finalDest_.empty()) event->finalDest = finalDest_;

    const Cycle depart = scheduler_.currentCycle();
    const Cycle arrive = scheduler_.deliveryCycle(latency);

    // Thread the in-flight transaction id onto the outgoing event so the
    // trace can group hops into per-instruction tokens.
    scheduler_.fillToken(*event);

    // First hop stamps the packet's origin; routers arbitrate on it.
    if (event->origin.empty() && in_) event->origin = in_->name();

    if (scheduler_.hopSink()) {
        HopRecord hop;
        hop.from = in_ ? in_->name() : "?";
        hop.to = target->name();
        hop.event = event->type();
        hop.token = event->token;
        hop.depart = depart;
        hop.arrive = arrive;
        hop.addr = event->addr;
        scheduler_.hopSink()(hop);
    }

    scheduler_.schedule(std::move(event), *target, arrive);
}

} // namespace microarch
