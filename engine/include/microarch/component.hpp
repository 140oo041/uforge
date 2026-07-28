#pragma once

#include <string>

#include "microarch/event.hpp"

namespace microarch {

/// A block in the design graph. Hand-written (or IDE-generated) blocks derive
/// from Component, receive input events through handler(), and hold Link
/// references as their output ports.
class Component {
public:
    explicit Component(std::string name) : name_(std::move(name)) {}
    virtual ~Component() = default;

    Component(const Component&) = delete;
    Component& operator=(const Component&) = delete;

    const std::string& name() const noexcept { return name_; }
    const std::string& getName() const noexcept { return name_; } // legacy alias

    /// Called once per event delivered to this component.
    virtual void handler(Event& event) = 0;

    /// Optional combinational phase (two-phase clocking, used by Verilated
    /// twins). Return true to request another delta-cycle this cycle.
    virtual bool settle(Cycle cycle) {
        (void)cycle;
        return false;
    }

    /// Optional clock-edge phase, called after combinational logic settles.
    virtual void tick(Cycle cycle) { (void)cycle; }

    /// Two-phase clocking, for components whose behaviour must not depend on
    /// the order their peers are visited in. `evaluate` computes next-state
    /// reading ONLY current-state; `commit` publishes it. Everything in the
    /// NoC is written this way, so a flit can never traverse two hops in one
    /// cycle and metric emission cannot vary with iteration order.
    ///
    /// Both default to no-ops: an event-driven block that only implements
    /// handler()/tick() is unaffected.
    virtual void evaluate(Cycle cycle) { (void)cycle; }
    virtual void commit(Cycle cycle) { (void)cycle; }

    /// True when this component provably has nothing to do until something
    /// arrives for it, letting the scheduler jump past its clock edges.
    ///
    /// Defaults to FALSE — never skip. A component that wrongly claims to be
    /// quiescent silently loses work, so the safe answer is the default and
    /// opting in is deliberate.
    virtual bool quiescent() const noexcept { return false; }

private:
    std::string name_;
};

} // namespace microarch
