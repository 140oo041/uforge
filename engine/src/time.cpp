#include "microarch/time.hpp"

#include <cmath>
#include <stdexcept>
#include <utility>

namespace microarch {

PeriodFit periodTicksFor(double megahertz, std::uint64_t femtosPerTick) {
    if (!(megahertz > 0.0))
        throw std::invalid_argument("periodTicksFor: frequency must be positive");
    if (femtosPerTick == 0)
        throw std::invalid_argument("periodTicksFor: femtosPerTick must be positive");

    // 1 MHz is 1e9 femtoseconds per cycle.
    const double exactTicks = 1e9 / (megahertz * static_cast<double>(femtosPerTick));
    if (exactTicks < 1.0)
        throw std::invalid_argument(
            "periodTicksFor: frequency is too high for this timebase (period < 1 tick)");

    PeriodFit fit;
    fit.ticks = static_cast<Tick>(std::llround(exactTicks));
    fit.relativeError = std::fabs(static_cast<double>(fit.ticks) - exactTicks) / exactTicks;
    return fit;
}

ClockDomain::ClockDomain(std::string name, Tick periodTicks, Tick phaseTicks,
                         unsigned syncDepth)
    : name_(std::move(name)), period_(periodTicks), phase_(phaseTicks), syncDepth_(syncDepth) {
    if (period_ == 0) throw std::invalid_argument("ClockDomain: period must be positive");
    // A phase beyond one period is the same clock with a different cycle
    // numbering; fold it so cycleOf() cannot go negative.
    phase_ %= period_;
}

bool ClockDomain::isEdge(Tick t) const noexcept {
    return t >= phase_ && (t - phase_) % period_ == 0;
}

Tick ClockDomain::edgeAtOrAfter(Tick t) const noexcept {
    if (t <= phase_) return phase_;
    const Tick since = t - phase_;
    const Tick rem = since % period_;
    return rem == 0 ? t : t + (period_ - rem);
}

Tick ClockDomain::edgeAfter(Tick t) const noexcept {
    if (t < phase_) return phase_;
    // t is at or past the first edge: step to the next one.
    const Tick since = t - phase_;
    return phase_ + (since / period_ + 1) * period_;
}

DomainCycle ClockDomain::cycleOf(Tick t) const noexcept {
    if (t <= phase_) return DomainCycle{0};
    return DomainCycle{(t - phase_) / period_};
}

Tick ClockDomain::tickOfCycle(DomainCycle c) const noexcept {
    return phase_ + c.n * period_;
}

Tick ClockDomain::advance(Tick from, DomainCycle latency) const noexcept {
    return from + latency.n * period_;
}

Tick ClockDomain::crossInto(Tick t) const noexcept {
    return edgeAtOrAfter(t) + static_cast<Tick>(syncDepth_) * period_;
}

} // namespace microarch
