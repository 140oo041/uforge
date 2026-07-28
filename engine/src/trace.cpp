#include "microarch/trace.hpp"

#include <cstdio>

namespace microarch {

std::string jsonString(const std::string& raw) {
    std::string out;
    out.reserve(raw.size() + 2);
    out.push_back('"');
    for (const char c : raw) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(c);
                }
        }
    }
    out.push_back('"');
    return out;
}

void JsonlTraceWriter::write(const TimebaseRecord& timebase) {
    out_ << "{\"timebase\":{\"femtosPerTick\":" << timebase.femtosPerTick
         << ",\"reference\":" << timebase.reference << ",\"domains\":[";
    for (std::size_t i = 0; i < timebase.domains.size(); ++i) {
        const TimebaseRecord::Domain& d = timebase.domains[i];
        if (i > 0) out_ << ',';
        out_ << "{\"name\":" << jsonString(d.name) << ",\"periodTicks\":" << d.periodTicks
             << ",\"phaseTicks\":" << d.phaseTicks << ",\"syncDepth\":" << d.syncDepth << '}';
    }
    out_ << "]}}\n";
}

void JsonlTraceWriter::write(const HopRecord& hop) {
    out_ << "{\"token\":" << hop.token << ",\"from\":" << jsonString(hop.from)
         << ",\"to\":" << jsonString(hop.to) << ",\"event\":" << jsonString(hop.event)
         << ",\"depart\":" << hop.depart << ",\"arrive\":" << hop.arrive;
    if (hop.addr != 0) {
        char buf[19];
        std::snprintf(buf, sizeof buf, "0x%llx", static_cast<unsigned long long>(hop.addr));
        out_ << ",\"addr\":\"" << buf << "\"";
    }
    out_ << "}\n";
}

void JsonlTraceWriter::write(const MetricRecord& metric) {
    out_ << "{\"metric\":" << jsonString(metric.metric) << ",\"cycle\":" << metric.cycle
         << ",\"component\":" << jsonString(metric.component);
    if (!metric.port.empty()) out_ << ",\"port\":" << jsonString(metric.port);
    out_ << ",\"value\":" << metric.value << "}\n";
}

void JsonlTraceWriter::write(const DivergenceRecord& divergence) {
    out_ << "{\"diverge\":true,\"cycle\":" << divergence.cycle
         << ",\"component\":" << jsonString(divergence.component)
         << ",\"token\":" << divergence.token
         << ",\"detail\":" << jsonString(divergence.detail);
    if (!divergence.kind.empty()) out_ << ",\"kind\":" << jsonString(divergence.kind);
    out_ << "}\n";
}

} // namespace microarch
