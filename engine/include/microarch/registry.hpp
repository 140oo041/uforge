#pragma once

#include <map>
#include <stdexcept>
#include <string>

#include "microarch/component.hpp"

namespace microarch {

/// Name → Component* lookup used to wire a design at run time.
///
/// This is what lets an IDE-generated block file emit its own wiring —
///
///     void DE::wire(microarch::Registry& registry) {
///         out->configureOut(registry.find("EX"));   // DE.out → EX
///     }
///
/// — so a drawn connection lives in the block's source (parseable, Tier-1
/// "wired") instead of only in a separately generated harness.
class Registry {
public:
    void add(Component& component) {
        components_[component.name()] = &component;
    }

    /// Register under an explicit key — generated harnesses register blocks by
    /// their class id, which may differ from the display label in name().
    void add(std::string name, Component& component) {
        components_[std::move(name)] = &component;
    }

    /// Returns nullptr when absent.
    Component* find(const std::string& name) const noexcept {
        auto it = components_.find(name);
        return it == components_.end() ? nullptr : it->second;
    }

    /// Throws std::out_of_range when absent.
    Component& at(const std::string& name) const {
        Component* component = find(name);
        if (!component)
            throw std::out_of_range("Registry: no component named '" + name + "'");
        return *component;
    }

    std::size_t size() const noexcept { return components_.size(); }

private:
    std::map<std::string, Component*> components_;
};

} // namespace microarch
