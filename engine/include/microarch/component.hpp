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

private:
    std::string name_;
};

} // namespace microarch
