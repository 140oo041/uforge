#pragma once

// Compatibility shim: hoists the microarch engine into the global namespace so
// legacy / generated ISS blocks (`#include "infra/component.h"`) compile
// unchanged. New code should include "microarch/engine.hpp" directly.

#include "infra/event.h"
#include "infra/link.h"
#include "microarch/component.hpp"

using Component = microarch::Component;
