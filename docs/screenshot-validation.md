# Screenshot validation

The complete emulator was built and exercised with the screenshot patch, beyond the mocked bridge tests.

## Build

- Upstream PCSX2: `v2.6.3`, commit `bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`.
- Ubuntu 24.04 under WSL2; Clang 18.1.3; CMake 3.28.3; Ninja 1.11.1.
- Qt 6.10.1; SDL 3.2.26; KDDockWidgets 2.4.0; PlutoVG 1.3.2; PlutoSVG 0.0.7.
- Release build; OpenGL enabled; Vulkan, Wayland and libbacktrace disabled for this environment.
- `DebugServer.cpp` was compiled and linked into the real `pcsx2-qt` executable.
- `tools/apply-debug-server.py` installs the source, CMake entries and VM start/stop hooks into the upstream checkout.

Relevant configure options, after installing dependencies:

```sh
cmake -S pcsx2-src -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=clang-18 -DCMAKE_CXX_COMPILER=clang++-18 \
  -DCMAKE_PREFIX_PATH="/path/to/deps;/path/to/Qt/6.10.1/gcc_64" \
  -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG" \
  -DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld \
  -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF \
  -DUSE_VULKAN=OFF -DUSE_BACKTRACE=OFF -DWAYLAND_API=OFF \
  -DENABLE_TESTS=OFF -DENABLE_SETCAP=OFF
cmake --build build --target pcsx2-qt --parallel 8
```

## Live checks

The emulator used OpenGL with Mesa llvmpipe under WSLg. An existing local BIOS was used; no BIOS files
are included in this repository. Images were returned through the real MCP stdio transport, Node bridge,
TCP DebugServer, GS snapshot API and PNG encoder. The resulting PNGs were opened and inspected visually.

| Case | Result |
|---|---|
| BIOS screen, default bounds | Valid 640 × 480 PNG showing the PlayStation logo |
| BIOS screen, 1280 × 720 bounds | Valid 960 × 720 PNG preserving 4:3 |
| Jellyfin/SMS homebrew, 4:3 | Valid 640 × 480 and 960 × 720 PNGs showing the rendered interface |
| Jellyfin/SMS homebrew, 16:9 | Valid 640 × 360 and 1280 × 720 PNGs, including its SMS startup screen |
| Paused capture and repeat | Valid PNGs; consecutive paused images were byte-identical; paused status preserved |
| Invalid dimensions through MCP | Tool error, without contacting the renderer |
| Width 0 or 1281 sent directly to C++ | `ok: false`, explicit dimension error |
| Null renderer sent a screenshot command | `ok: false`, explicit no-rendered-frame error |
| Automated bridge tests | Nine tests passed, including large fragmented responses and disconnected/old servers |

To repeat the live checks with a rebuilt emulator already booted:

```sh
cd pcsx2-mcp-server
npm run build
node test/screenshot-live.mjs 21512 ../release/screenshot-validation
```

The script waits for connection/first-frame readiness, captures two sizes, checks identical paused frames,
rejects invalid dimensions and restores the emulator's initial running state. PNGs and `results.json` are
written to the specified directory (ignored by Git when under `release/`).

## Limits of this validation

This validates the Linux/WSL emulator and its OpenGL capture path. It is not a Windows/MSVC build, a
Direct3D/Vulkan test, a commercial-game compatibility test or a physical PS2 test. The homebrew was offline;
Jellyfin networking, audio and video playback were not part of these screenshot checks. Shutdown during an
in-flight GPU capture remains a manual test. PCSX2's existing pause/resume debug commands emitted a Qt timer
thread warning in this environment; capture itself completed, and paused-frame equality checks passed.
