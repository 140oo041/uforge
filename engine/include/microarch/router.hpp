#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "microarch/component.hpp"
#include "microarch/event.hpp"
#include "microarch/link.hpp"

namespace microarch {

class Scheduler;

/// Per-packet hop-latency calculation for a routed destination. Assigned via
/// Router::setRouteLatency; unassigned routes use the router's flat constant.
using LatencyModel = std::function<Cycle(const Event&)>;

/// A fabric switch. Packets arrive with `Event::finalDest` stamped (by a
/// routeVia'd Link); the router looks the destination up in its static
/// next-hop table, queues the packet on that output port, and forwards as
/// much as the port's per-cycle BIT budget can pay for each Tick. A packet
/// costs `Event::bits`, so a payload wider than one cycle's bandwidth
/// serializes across cycles instead of teleporting, and several narrow
/// packets can share one cycle. Distinct ports forward in parallel. Unspent
/// budget carries while a port has a backlog and is dropped when it drains,
/// so an idle port cannot bank bandwidth for a later burst.
/// Every forward is an ordinary Link::send, so router hops
/// appear in the trace like any wire hop (from = this router, to = next hop)
/// and animation needs no special cases.
///
/// Which queued packet forwards is chosen by the arbitration policy, keyed
/// on `Event::origin` (the leaf that first sent the packet — stamped on the
/// first hop, so policies behave identically at first-hop and trunk routers):
///  - Fifo (default): arrival order, exactly the pre-policy behavior.
///  - RoundRobin: origins present in the queue take turns (sorted by name
///    for determinism; a per-port cursor remembers the last served).
///  - FixedPriority: the origin with the lowest priority number drains
///    first (setSourcePriority; unset origins rank last; ties by name).
///  - Weighted: BIT-quantum deficit round-robin — visiting origins in
///    round-robin order, each visit adds weight × the port's bandwidth to
///    the origin's deficit counter (in bits) and forwards its oldest packets
///    while the deficit covers their width; an origin whose backlog empties
///    resets its deficit (the standard DRR anti-hoarding rule). Over a
///    sustained backlog, origins share a port's bits in proportion to their
///    weights — an origin sending 4x-wide packets gets a quarter as many.
///
/// Output queues may be bounded (setQueueCapacity). A packet arriving at a
/// full queue follows the full policy:
///  - Stall (default): the packet "waits on the wire" — it is rescheduled
///    at this router for the next cycle and retries. No hop record is
///    emitted for the retry, so a traced token simply dwells. This is
///    wire-holds-packet backpressure, not credit-based flow control: the
///    upstream sender's logic is not stalled, only its packet. Retries live
///    in the scheduler calendar, not in any router queue, so cyclic fabrics
///    cannot deadlock on capacity.
///  - Drop: the packet is discarded and reported through the divergence
///    sink with kind "drop", so losses are visible, never silent.
///
/// Routes are configured by the generated harness (addRoute per reachable
/// final destination); an unroutable packet throws — generation guarantees
/// the table is total for the traffic it redirects.
///
/// Not final: the IDE generates one subclass per authored router
/// (src/<R>.cpp) whose member functions are user-written latency models —
/// the harness binds them per route via setRouteLatency.
class Router : public Component {
public:
    enum class Arbitration { Fifo, RoundRobin, FixedPriority, Weighted };
    enum class FullPolicy { Stall, Drop };

    Router(std::string name, Scheduler& scheduler, Cycle hopLatency = 1);

    /// One ingress forwarding rule: packets arriving WITHOUT a finalDest are
    /// resolved by first match (in insertion order) on message type and
    /// inclusive address range, which stamps finalDest. Empty message = any
    /// type. A packet no rule matches is dropped and reported through the
    /// divergence sink (kind "drop") — the sim continues.
    struct MatchRule {
        std::string message;
        std::uint64_t lo = 0;
        std::uint64_t hi = std::numeric_limits<std::uint64_t>::max();
        std::string finalDest;
    };

    /// Append an ingress rule (evaluation order = insertion order).
    void addMatchRule(std::string message, std::uint64_t lo, std::uint64_t hi,
                      std::string finalDest);

    /// Any-address convenience overload.
    void addMatchRule(std::string message, std::string finalDest);

    /// Route packets whose finalDest is `finalDest` toward `nextHop` (another
    /// router or the destination component itself).
    void addRoute(const std::string& finalDest, Component& nextHop);

    /// Compute this router's hop latency for `finalDest` packets with
    /// `model` instead of the flat constant. Evaluated per packet at
    /// forward time (the event is the one being forwarded).
    void setRouteLatency(const std::string& finalDest, LatencyModel model);

    /// Select the arbitration policy (default Fifo — arrival order).
    void setArbitration(Arbitration policy) noexcept { arbitration_ = policy; }

    /// Weighted arbitration: this origin's share of a contended port's
    /// bandwidth, relative to the other origins' weights. Unset origins
    /// weigh 1. Throws std::invalid_argument on weight 0.
    void setSourceWeight(const std::string& origin, std::uint32_t weight);

    /// FixedPriority arbitration: lower numbers drain first. Unset origins
    /// rank after every prioritized one.
    void setSourcePriority(const std::string& origin, std::uint32_t priority);

    /// BITS forwarded per output port per cycle (default
    /// default_event_bits, i.e. one ordinary packet per cycle). A packet
    /// costs Event::bits, so a payload wider than one cycle's budget
    /// serializes across cycles instead of teleporting. Throws
    /// std::invalid_argument on 0.
    void setBandwidth(std::uint32_t bitsPerPortPerCycle);

    /// Per-output-port bandwidth override in bits/cycle, keyed by the next
    /// hop's name. Throws std::invalid_argument on 0.
    void setPortBandwidth(const std::string& nextHopName, std::uint32_t bitsPerCycle);

    /// Bound each output-port queue to `perPortCapacity` packets; a packet
    /// arriving at a full queue follows the full policy. 0 = unbounded
    /// (the default).
    void setQueueCapacity(std::size_t perPortCapacity) noexcept { queueCapacity_ = perPortCapacity; }

    /// What happens to a packet arriving at a full queue (default Stall).
    void setFullPolicy(FullPolicy policy) noexcept { fullPolicy_ = policy; }

    /// Dispatch phase: take ownership of the arriving packet and queue it on
    /// its next-hop output port (or stall/drop it if the queue is full).
    void handler(Event& event) override;

    /// Clock edge: forward each output port's arbitration winners while the
    /// port's per-cycle bit budget can pay for them.
    void tick(Cycle cycle) override;

    /// Packets still queued (e.g. at clock stop) — honesty surface.
    std::size_t pendingCount() const noexcept;

    Cycle hopLatency() const noexcept { return hopLatency_; }

private:
    /// One parked packet: the event plus arbitration facts about it.
    struct Queued {
        std::unique_ptr<Event> event;
        std::string origin;
        Cycle enqueued = 0;
    };
    using Queue = std::deque<Queued>;

    std::uint32_t portBandwidth(const Component& nextHop) const noexcept;
    std::uint32_t weightOf(const std::string& origin) const noexcept;
    std::uint32_t priorityOf(const std::string& origin) const noexcept;
    /// The queue entry the policy forwards next; queue.end() when the
    /// policy cannot pick (empty queue).
    ///
    /// Two-phase on purpose: a pick is only real once the port's bit budget
    /// can pay for that packet, so tick() first asks with commit=false (which
    /// mutates no cursor and burns no deficit) and asks again with
    /// commit=true only when it is actually going to send.
    Queue::iterator pickNext(Component* port, Queue& queue, bool commit);
    /// Send one dequeued packet down the port's link with its per-packet
    /// latency.
    void forward(Component& nextHop, std::unique_ptr<Event> event);

    Scheduler& scheduler_;
    Cycle hopLatency_;
    Arbitration arbitration_ = Arbitration::Fifo;
    FullPolicy fullPolicy_ = FullPolicy::Stall;
    std::uint32_t bandwidth_ = default_event_bits;
    std::size_t queueCapacity_ = 0;
    std::map<std::string, Component*> routes_;
    /// Ordered ingress rules — first match resolves an unstamped finalDest.
    std::vector<MatchRule> matchRules_;
    /// Per-finalDest latency models (absent = flat hopLatency_).
    std::map<std::string, LatencyModel> models_;
    /// One Link per distinct next hop (in_ = this router), created lazily.
    std::map<Component*, std::unique_ptr<Link>> links_;
    /// Per-output-port queue — the policy picks which entry forwards.
    std::map<Component*, Queue> queues_;
    /// Per-output-port bandwidth overrides, keyed by next-hop name.
    std::map<std::string, std::uint32_t> portBandwidth_;
    /// Weighted / FixedPriority per-origin configuration.
    std::map<std::string, std::uint32_t> weights_;
    std::map<std::string, std::uint32_t> priorities_;
    /// RoundRobin / Weighted: last origin served per port.
    std::map<Component*, std::string> rrCursor_;
    /// Weighted: per-(port, origin) deficit counters, in BITS — deficit
    /// round-robin is only fair if the quantum is the same unit the port
    /// meters in.
    std::map<Component*, std::map<std::string, std::uint64_t>> deficit_;
    /// Per-output-port unspent bit budget. Carried across cycles so a packet
    /// wider than one cycle's bandwidth still goes; zeroed when the port
    /// drains, so an idle port cannot bank bandwidth for a later burst.
    std::map<Component*, std::uint64_t> credit_;
    /// Metrics: last change-only-reported queue depth per port, and the
    /// current cycle's full-queue retry count per port (flushed each tick).
    std::map<Component*, std::size_t> lastReportedDepth_;
    std::map<Component*, std::uint64_t> stallCount_;
};

} // namespace microarch
