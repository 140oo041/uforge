# Sample design project — builds the generated harness (which #include's the
# single-file inline blocks) against the micro_arch_ide2 engine and runs it,
# producing iss_trace.jsonl.

ENGINE   ?= ../engine
CXX      ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -Iinc -Isrc -I$(ENGINE)/include
BUILD    := build

BLOCK_SRCS := $(shell find src -name '*.cpp')

.PHONY: all run clean

all: $(BUILD)/design

$(ENGINE)/build/libmicroarch.a:
	$(MAKE) -C $(ENGINE) build/libmicroarch.a

$(BUILD)/design: src/iss_main_gen.cpp $(BLOCK_SRCS) $(ENGINE)/build/libmicroarch.a | $(BUILD)
	$(CXX) $(CXXFLAGS) src/iss_main_gen.cpp $(ENGINE)/build/libmicroarch.a -o $@

$(BUILD):
	mkdir -p $(BUILD)

run: $(BUILD)/design
	./$(BUILD)/design 64

clean:
	rm -rf $(BUILD)
