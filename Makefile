#!/usr/bin/env make
-include .dev.vars
export

default:
	@echo "Available Targets:"
	@echo
	@echo "  dev:        Run the Vite dev server (validates .dev.vars first)"
	@echo "  env-check:  Verify .dev.vars exists"
	@echo "  doom-build: Build Chocolate Doom (Emscripten/WASM) into doom/src/"
	@echo "  doom-copy:  Copy chocolate-doom.* artifacts from doom/src/ into ./public"
	@echo "  doom-clean: Remove doom/build and in-tree doom browser bundles"

.PHONY: node_modules doom-build doom-clean doom-copy dev env-check

# Verify that .dev.vars exists before running anything that needs local
# environment variables (e.g. `make dev`). Prints a friendly, actionable
# error pointing the user at .dev.vars.sample if the file is missing.
env-check:
	@if [ ! -f .dev.vars ]; then \
		printf '\n\033[31mError:\033[0m .dev.vars not found.\n\nCreate one from .dev.vars.sample:\n\n  cp .dev.vars.sample .dev.vars\n\n' >&2; \
		exit 1; \
	fi

# Run the Vite dev server. Validates .dev.vars first; npm run dev also
# performs the same check via its `predev` script as defense in depth.
dev: env-check
	@npm run dev

# Drives a CMake-based Emscripten build of Chocolate Doom 3.1.1 with the
# WebSocket networking module and copies the resulting browser artifacts
# (chocolate-doom.{html,js,wasm,wasm.map}) into doom/src/ where index.html
# expects to find them.
doom-build:
	@cd doom && \
	if ! command -v emcc >/dev/null 2>&1; then \
		EMSDK_DIR="$${EMSDK:-$$HOME/emsdk}"; \
		if [ -f "$$EMSDK_DIR/emsdk_env.sh" ]; then \
			. "$$EMSDK_DIR/emsdk_env.sh"; \
		else \
			echo "error: emcc not found and $$EMSDK_DIR/emsdk_env.sh missing." >&2; \
			echo "Install EMSDK to ~/emsdk or set \$$EMSDK, or 'brew install emscripten'." >&2; \
			exit 1; \
		fi; \
	fi; \
	export EMSDK EMSDK_NODE EMSDK_PYTHON; \
	command -v emcmake >/dev/null 2>&1 || { echo "error: emcmake not found in PATH (after emsdk activation)." >&2; exit 1; }; \
	command -v cmake   >/dev/null 2>&1 || { echo "error: cmake not found in PATH." >&2; echo "Install with 'brew install cmake' or your distro package manager." >&2; exit 1; }; \
	BUILD_DIR="$${BUILD_DIR:-build}"; \
	emcmake cmake -S . -B "$$BUILD_DIR" \
		-DCMAKE_BUILD_TYPE=Release \
		-DENABLE_SDL2_NET=OFF \
		-DENABLE_SDL2_MIXER=ON && \
	cmake --build "$$BUILD_DIR" -j"$$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" && \
	for ext in html js wasm wasm.map; do \
		artifact="$$BUILD_DIR/src/chocolate-doom.$$ext"; \
		if [ -f "$$artifact" ]; then cp "$$artifact" "src/chocolate-doom.$$ext"; fi; \
	done; \
	echo; \
	echo "Build complete. Artifacts in src/:"; \
	ls -lh src/chocolate-doom.* 2>/dev/null || true

# Copy the built Chocolate Doom browser artifacts into ./public so they can
# be served by the Worker assets binding. Hard-fails if any artifact is
# missing; run `make doom-build` first.
doom-copy:
	@mkdir -p public
	@for ext in js wasm wasm.map; do \
		artifact="doom/src/chocolate-doom.$$ext"; \
		if [ ! -f "$$artifact" ]; then \
			echo "error: $$artifact not found; run 'make doom-build' first." >&2; \
			exit 1; \
		fi; \
		cp "$$artifact" "public/chocolate-doom.$$ext"; \
		echo "copied $$artifact -> public/chocolate-doom.$$ext"; \
	done

# Remove all CMake build artifacts and the in-tree browser bundle.
doom-clean:
	rm -rf doom/build
	rm -f doom/src/chocolate-doom.*

