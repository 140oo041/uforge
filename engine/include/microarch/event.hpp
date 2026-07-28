#pragma once

#include <cstdint>
#include <limits>
#include <string>

namespace microarch {

class Component;

using Cycle = std::uint64_t;
using TokenId = std::uint64_t;

inline constexpr TokenId no_token = std::numeric_limits<TokenId>::max();

/// Width charged to a packet that declares no payload — a bare notification
/// still occupies a word on the wire. Mirrors DEFAULT_EVENT_BITS in the IDE's
/// @iss/contracts/bits, which is where packet widths are actually derived.
inline constexpr std::uint32_t default_event_bits = 32;

/// Base class for every message that travels over a Link.
///
/// Derived events add payload fields and pass a type name to the base
/// constructor; the type name is what appears in the trace and what the IDE
/// keys edges on:
///
///   struct DecodeEvent final : Event {
///       DecodeEvent() : Event("DecodeEvent") {}
///       std::uint32_t instruction = 0;
///   };
class Event {
public:
    explicit Event(std::string type = "Event") : type_(std::move(type)) {}
    virtual ~Event() = default;

    Event(const Event&) = delete;
    Event& operator=(const Event&) = delete;
    Event(Event&&) = default;
    Event& operator=(Event&&) = default;

    const std::string& type() const noexcept { return type_; }

    /// Delivery cycle. Filled by Link::send / Scheduler::schedule.
    Cycle cycle = 0;

    /// Stable per-transaction id: minted by Scheduler::seed*, inherited by
    /// every event a handler sends while processing this one. This is what
    /// lets a trace thread hops into per-instruction tokens.
    TokenId token = no_token;

    /// Destination component. Filled by Link::send / Scheduler::schedule.
    Component* dest = nullptr;

    /// Fabric routing: the final destination's registry id when this event
    /// travels via routers (set by Link::send on a routeVia'd link; routers
    /// forward until it is reached). Empty = direct point-to-point delivery.
    std::string finalDest;

    /// The component that first sent this event (stamped once by Link::send
    /// on the first hop; later hops leave it untouched). Routers arbitrate
    /// per origin — weights and priorities keyed here behave identically at
    /// first-hop and trunk routers. Empty for seeded events until first sent.
    std::string origin;

    /// Transaction address. 0 unless the producer sets it (traffic
    /// generators emit within their configured range; hand code assigns
    /// ev->addr directly). Router match rules test it against inclusive
    /// [lo, hi] ranges when resolving a packet's final destination.
    std::uint64_t addr = 0;

    /// Wire width of this packet, in bits. Router bandwidth is a bit budget,
    /// so a packet costs what it actually carries: a 512-bit fill occupies a
    /// 128 bit/cycle port for four cycles, while two 32-bit credits share one.
    ///
    /// Generated event classes set this from their declared fields (the IDE
    /// derives the number and bakes it in). Hand-written events keep the
    /// default word unless they assign it themselves.
    std::uint32_t bits = default_event_bits;

private:
    std::string type_;
};

} // namespace microarch
