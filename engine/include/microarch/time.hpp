#pragma once

#include <cstdint>
#include <limits>
#include <string>

namespace microarch {

/// Absolute simulated time, counted in ticks of the design's timebase.
///
/// A tick is a fixed sub-cycle quantum (femtoseconds by default), NOT a clock
/// cycle — with several clock domains there is no single "cycle" for absolute
/// time to be measured in. Deliberately a plain alias rather than a distinct
/// type: absolute time is compared, printed and stored as an integer all over
/// the engine and the trace, and wrapping it would buy nothing.
using Tick = std::uint64_t;

inline constexpr Tick tick_max = std::numeric_limits<Tick>::max();

/// Femtoseconds per tick. 1 fs gives ~5.1 hours of simulated time in a uint64,
/// far more than any exploration run, while keeping the rounding error of a
/// realistic clock period down around 1e-8 relative (see periodTicksFor).
inline constexpr std::uint64_t default_femtos_per_tick = 1;

/// A duration in cycles OF SOME CLOCK DOMAIN.
///
/// Distinct from Tick on purpose: "3 cycles" means nothing until you say whose
/// clock, so adding a cycle count to an absolute time must not compile. The
/// only way across is through a ClockDomain.
///
/// Implicitly constructible from an integer, because authoring is in cycles and
/// a bare number IS a cycle count — `link->latency = 5` is documented public
/// API, and every generated block writes bare numbers.
struct DomainCycle {
    std::uint64_t n = 0;

    constexpr DomainCycle() = default;
    constexpr DomainCycle(std::uint64_t value) noexcept : n(value) {}  // NOLINT: implicit by design

    constexpr explicit operator std::uint64_t() const noexcept { return n; }

    friend constexpr bool operator==(DomainCycle a, DomainCycle b) noexcept { return a.n == b.n; }
    friend constexpr bool operator!=(DomainCycle a, DomainCycle b) noexcept { return a.n != b.n; }
    friend constexpr bool operator<(DomainCycle a, DomainCycle b) noexcept { return a.n < b.n; }
    friend constexpr bool operator<=(DomainCycle a, DomainCycle b) noexcept { return a.n <= b.n; }
    friend constexpr bool operator>(DomainCycle a, DomainCycle b) noexcept { return a.n > b.n; }
    friend constexpr bool operator>=(DomainCycle a, DomainCycle b) noexcept { return a.n >= b.n; }
    friend constexpr DomainCycle operator+(DomainCycle a, DomainCycle b) noexcept {
        return DomainCycle{a.n + b.n};
    }
    constexpr DomainCycle& operator++() noexcept {
        ++n;
        return *this;
    }
};

/// How far a derived period misses the requested frequency.
struct PeriodFit {
    Tick ticks = 0;
    /// |actual - requested| / requested. Zero only when the period divides the
    /// timebase exactly.
    double relativeError = 0.0;
};

/// Ticks per cycle for a frequency in MHz.
///
/// NO decimal timebase represents every real clock exactly — 60 MHz is
/// 16.666… ns, a repeating decimal in picoseconds AND in femtoseconds — so the
/// period is rounded and the error is RETURNED rather than hidden. Callers are
/// expected to surface anything above their tolerance instead of discovering a
/// slow drift 100k cycles later.
PeriodFit periodTicksFor(double megahertz, std::uint64_t femtosPerTick = default_femtos_per_tick);

/// One clock. Edges fall at phase, phase + period, phase + 2·period, …
///
/// A domain owns the conversion between its own cycles and absolute ticks;
/// nothing else may perform it.
class ClockDomain {
public:
    ClockDomain(std::string name, Tick periodTicks, Tick phaseTicks = 0,
                unsigned syncDepth = 2);

    const std::string& name() const noexcept { return name_; }
    Tick period() const noexcept { return period_; }
    Tick phase() const noexcept { return phase_; }
    /// Synchronizer flops crossing INTO this domain (see crossInto).
    unsigned syncDepth() const noexcept { return syncDepth_; }

    /// The first edge at or after `t` — `t` itself when it is already an edge.
    Tick edgeAtOrAfter(Tick t) const noexcept;
    /// The first edge strictly after `t`. This is what the scheduler asks when
    /// deciding how far it may jump.
    Tick edgeAfter(Tick t) const noexcept;
    bool isEdge(Tick t) const noexcept;

    /// Whole cycles of this domain elapsed at `t`.
    DomainCycle cycleOf(Tick t) const noexcept;
    /// Absolute tick of this domain's cycle number `c`.
    Tick tickOfCycle(DomainCycle c) const noexcept;

    /// Absolute arrival for something leaving at `from` after `latency` cycles
    /// of THIS domain. The one sanctioned Tick ← DomainCycle conversion.
    Tick advance(Tick from, DomainCycle latency) const noexcept;

    /// Arrival when crossing INTO this domain from elsewhere.
    ///
    /// A receiver only samples on its own edges, so an arrival lands on the
    /// next edge at or after `t`, plus `syncDepth` further periods for the
    /// synchronizer. Clock-domain-crossing latency is not modelled separately —
    /// it falls out of edge alignment.
    Tick crossInto(Tick t) const noexcept;

private:
    std::string name_;
    Tick period_;
    Tick phase_;
    unsigned syncDepth_;
};

} // namespace microarch
