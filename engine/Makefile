CXX      ?= g++
# -MMD -MP: header dependency tracking. Without it a change to event.hpp
# rebuilt only the .cpp that changed, leaving the rest of the archive compiled
# against a stale Event layout — which fails at runtime, not at link time.
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Iinclude -MMD -MP
BUILD    := build

SRCS := src/scheduler.cpp src/link.cpp src/router.cpp src/trace.cpp
OBJS := $(SRCS:src/%.cpp=$(BUILD)/%.o)
DEPS := $(OBJS:.o=.d) $(BUILD)/pipeline.d $(BUILD)/engine_tests.d

.PHONY: all clean run test

all: $(BUILD)/libmicroarch.a $(BUILD)/pipeline $(BUILD)/engine_tests

$(BUILD)/%.o: src/%.cpp | $(BUILD)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD)/libmicroarch.a: $(OBJS)
	ar rcs $@ $^

$(BUILD)/pipeline: examples/pipeline.cpp $(BUILD)/libmicroarch.a
	$(CXX) $(CXXFLAGS) $< $(BUILD)/libmicroarch.a -o $@

$(BUILD)/engine_tests: tests/engine_tests.cpp $(BUILD)/libmicroarch.a
	$(CXX) $(CXXFLAGS) $< $(BUILD)/libmicroarch.a -o $@

$(BUILD):
	mkdir -p $(BUILD)

run: $(BUILD)/pipeline
	cd $(BUILD) && ./pipeline

test: $(BUILD)/engine_tests
	$(BUILD)/engine_tests

clean:
	rm -rf $(BUILD)

-include $(DEPS)
