# Bounded repetition and source CI — T1

Validated locally on Windows/modified PCSX2 v2.9.147 on 2026-10-30.
The supervised GUI cases remain separately accepted; this suite needs no
GUI input. It drives only its own instruction fixture and native process.

## Repeat the native test

Build Node with `npm ci` / `npm test` in `pcsx2-mcp-server` first. Reuse the
standalone instruction fixture and your configured local BIOS root from
[standalone validation](standalone-validation.md), or build a fresh fixture.
The fixture manifest and its source inputs must match the checkout.

```powershell
rtk proxy node "D:\dev\PCSX2-MCP\pcsx2-mcp-server\test\stability-live.mjs" "D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe" "D:\dev\PCSX2-MCP\release\instruction-fixture-20261024-final" "D:\dev\PCSX2-MCP\release\standalone-data" "D:\dev\PCSX2-MCP\release\stability-new" 100
```

The final integer defaults to 100 and accepts 10–500. Output must be a new
directory. The repetition loop has a ten-minute budget, and each MCP call has
a 15-second response deadline. Startup/cleanup have separate bounds. No global
process kill, existing-instance connection, or automatic BIOS acquisition occurs.

The private `-debugger` instance uses its own port/data root and a copy of the
fixture. After the initial ELF becomes active, it reloads that fixture to
reach the exact `instruction_ready` breakpoint. It verifies PID/port/root/ELF
and requires empty EE and IOP breakpoint lists before measuring.

Each cycle performs two EE instruction steps and a real JAL step-over, checks
the exact PC and `t0` changes, replaces the native inspector's socket and
compares the sampled paused state. It reads at most 32 history events and
keeps a nondecreasing cursor. Event continuity/losslessness is not asserted.
Every tenth cycle also:

- Times out a nonreturning call, requires a paused VM and no leftover point.
- Creates an occupied successor, requires refusal with the complete sampled
  paused state/foreign point unchanged, then removes only that control point.
- Stops the current stdio MCP server and starts/reconnects a new one, requiring
  unchanged sampled state and confirmation that the prior transport PID closed.
- Requests a 320×240-bounded debugger PNG through actual MCP stdio, decodes its
  pixels, checks metadata/dimensions/nonuniform content and unchanged state.

The original native process/session/execution epoch/ELF must remain unchanged,
and both CPU breakpoint lists must be empty at each cycle boundary. Results
checkpoint every ten cycles. Final acceptance requires the requested count,
unchanged executable and original INI hashes, all owned MCP servers closed and
the owned emulator stopped. A partial checkpoint with `passed: false` is not
acceptance. Test PC writes and control breakpoints are intentional fixture work.

## Local results

| Run | Completed cycles | Loop duration | Native reconnects | Timeout/foreign/restart/capture rounds | Closed stdio processes |
|---|---:|---:|---:|---:|---:|
| Default | 100 | 13.117 s | 100 | 10 | 11 |
| Upper accepted count | 500 | 71.345 s | 500 | 50 | 51 |

Both runs passed five logical groups, retained native identity/paused state
and stopped their emulators. All 60 PNGs decoded. The first and last PNGs of
the 500-cycle run were visually inspected. The local TypeScript build and
**260 Node tests** passed. A deliberately modified fixture failed manifest
verification with exit 1 before any native process or MCP server was launched.

The first harness attempt stopped at `0x001000d8` instead of the fixture's
`instruction_ready` at `0x00100210`, completed zero cycles, exited 1 and stopped
its emulator. It remains excluded. Startup was corrected to wait for the ELF
and replay its boot before measuring; the 100- and 500-cycle runs used that
same corrected harness. No native or Node runtime source change was needed.

```text
release/stability-node-tests-20261030.log
release/stability-live-20261030/validation.json           # excluded startup failure
release/stability-live-20261030-02/validation.json        # accepted 100
release/stability-live-20261030-500/validation.json       # accepted 500
release/stability-stale-rejected-20261030/validation.json # expected refusal
release/stability-ci-delivery-20261030.json
```

Executable, integrated native sources, dist and runtime DLL hashes are compared
to the S3 baseline. The local receipt separately records publication and remote
CI outcomes. Generated INIs, BIOS references, logs and PNGs remain ignored.

## GitHub Actions

[The workflow](../.github/workflows/mcp-tests.yml) runs on pushes to `main`,
pull requests and manual dispatch. Its Node 22 matrix runs `npm ci`, syntax
checks this live harness and runs `npm test` (including TypeScript compilation)
on Windows and Ubuntu. Checkout/setup-node actions are pinned to commit SHAs;
repository permissions are read-only and checkout does not persist credentials.
Each job has a ten-minute timeout. New runs cancel older runs for the same ref.

Hosted CI validates the bridge's source tests, not the native emulator. It does
not install BIOS, build/launch PCSX2, run this native repetition, exercise the
GUI, or upload local execution data. Passing Ubuntu Node tests does not accept
the native Linux build. Check the actual workflow status for each pushed SHA;
a local pass does not imply remote CI success.

## Remaining work

This is bounded repetition over roughly 84 seconds across two measured loops,
not a multi-hour soak or a proof of memory-leak freedom, general performance or
game stability. No RSS/handle/socket growth guarantee is established. Reset,
savestate, IOP IRQ and GUI ownership retain their earlier separate evidence;
they are not repeatedly mixed in this loop. No SMS/Jellyfin or physical PS2 is
involved. No new 60-check standalone-suite or native build run is claimed.

Next T2 should add duration-based runs with rendered guest progress, process
resource samples and explicit failure thresholds/artifact bounds, then exercise
reset/restore and interruption boundaries under that sustained workload. Keep
IOP/GUI option coverage explicit. DAP/editor integration follows these scoped
stability results; native synchronous-load interruption/rollback remains deferred.
