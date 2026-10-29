# D3D11 GS replay acceptance — M2

Validated on Windows on 2026-10-28 with the modified pinned PCSX2 v2.9.147
from [M1](pcsx2-2.9-migration.md), native SHA256
`51042a6330a7e63184bf7fe976dfe19a6e7210043c83a7670eb0c8c132b6914f`.
This delivery changes fixtures, the fixture builder and acceptance tooling.
Native code, compiled executable and Node runtime remain unchanged.

## Observed result

The original standalone fixture draws its text once, then only updates an EE
counter. Its captured dump has **zero GIF transfer packets**, 34 VSync packets
and 34 register packets. It still fails to provide a capturable D3D11 replay
frame. M1's software replay remains accepted for that same static artifact.

The separate `test/fixtures/gs-replay` homebrew continually redraws a counter.
Its final captured dump contains **4,759 GIF transfers**, 34 VSync packets and
34 register packets. That transfer count is an observation, not a required
constant: capture timing and emulation speed affect it. The test requires
nonzero transfer traffic and complete, hash-verified artifacts.

Both exact closed artifacts were replayed without modification on explicitly
selected D3D11 devices, confirmed by the native log:

| Device | Static dump | Continuous-drawing dump |
|---|---|---|
| Intel(R) Graphics | Expected `No rendered frame available` throughout bounded sampling | Real 640×480 PNG |
| NVIDIA GeForce RTX 5070 Ti Laptop GPU | Same missing-frame result | Real 640×480 PNG |

The two final PNGs were visually inspected: they show the fixture title and
counter. The test does not require identical pixels/counter values across runs.
The earlier exploratory run selected different default GPUs for different
artifacts; it was insufficient to isolate the fixture effect. The final matrix
fixes the adapter for each pair and records actual selection, PID, private data
root, native port and cleanup.

The upstream hardware path `GSRendererHW::GetOutput` obtains its frame from
`GSTextureCache::LookupDisplayTarget`; target creation there can depend on recent
uploads. Software rendering can read the initial GS memory directly. That is
consistent with these observations, but the exact internal branch was not
instrumented. No renderer/cache fix or general GPU incompatibility is claimed.
An embedded dump thumbnail is not a newly rendered replay frame.

## Reproduce

From the repository root, build the new fixture with the existing pinned PS2SDK
Docker image. The default builder still produces the original static fixture:

```powershell
rtk proxy python tools/build-standalone-fixture.py release/gs-fixture-new --gs-replay
rtk proxy node pcsx2-mcp-server/test/gs-dump-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/gs-fixture-new/gs-replay.elf release/standalone-data release/gs-capture-new
```

The configured data root needs your own BIOS reference and file logging enabled.
Both harnesses copy its INI into private roots. Use new output directories.
For comparison, retain an original static fixture capture report; a report whose
capture succeeded but whose D3D11 replay failed is suitable. Its closed artifact
is independently reverified before it is used. Pass its `validation.json` and the
new dynamic capture report to the focused test, followed by exact adapter names
available on your machine:

```powershell
rtk proxy node pcsx2-mcp-server/test/gs-replay-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/v2.9.147-gs-regression-20261028/validation.json release/gs-capture-new/validation.json release/standalone-data release/gs-matrix-new "Intel(R) Graphics" "NVIDIA GeForce RTX 5070 Ti Laptop GPU"
```

The focused test enforces D3D11 in each private GS configuration, checks the
actual device in its log, and refuses a device fallback. It verifies dump
structure/SHA, counts packet classes, checks exact native process/root/port
identity, captures actual replay pixels and stops only its own children.
Only the specific missing-rendered-frame error can satisfy the static case;
connection, encoding, renderer startup and other failures cannot pass it.
A changed dump/native hash or failure to stop invalidates the result.

## Acceptance and remaining work

**18 live checks passed**: eight capture/ownership/limits/reset/replay checks and
ten checks for the controlled four-process replay matrix. All owned emulator
processes stopped. The earlier 255 Node, 60 standalone and 53 extra regression
checks remain M1 evidence; they were not rerun for this fixture-only delivery.
The default static fixture sources/Makefile retain their original hashes.

The D3D11 replay gate is now accepted for the continuous-drawing fixture on these
two devices. Static no-transfer D3D11 replay retains its observed missing-frame
limitation. Arbitrary games/dumps, other GPUs/backends, GPU resets and pixel
equivalence remain outside this acceptance. There is no audio or physical PS2
acceptance and no SMS/Jellyfin dependency.

The supervised GUI replacement/ownership test is still pending. The Windows
computer-use runtime failed to initialize twice this delivery, including after
a JavaScript-kernel reset: `failed to write kernel assets: El sistema no puede
encontrar la ruta especificada. (os error 3)`. No GUI input occurred. After that
gate, the plan continues with stability/CI and DAP over proven capabilities.

Ignored evidence:

```text
release/gs-replay-acceptance-20261028/validation.json
release/gs-replay-acceptance-20261028/fixture/manifest.json
release/gs-replay-acceptance-20261028/capture/validation.json
release/gs-replay-acceptance-20261028/matrix/validation.json
release/gs-replay-acceptance-20261028/matrix/adapter-{0,1}-dynamic/replayed.png
release/gs-replay-matrix-probe-20261028/validation.json
release/gs-replay-delivery-20261028.json
```

The first fixture build failed because Docker's Linux engine was stopped. Its
log remains in `release/gs-dynamic-probe-fixture-20261028/build.log`; the engine
was started and a new output was built. That failed attempt is not accepted.
