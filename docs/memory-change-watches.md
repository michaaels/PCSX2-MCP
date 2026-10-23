# Sampled memory-change observers

Later [5A3b](iop-bindings.md) adds lifetime guarding at IOP watch start and
`lifetime_changed` termination of pending IOP watches at observed load, registry,
service, reboot and restore boundaries. EE watches and completed value pairs are
preserved by those IOP-only boundaries. Debugger-write rebasing remains as
documented below. This does not track every custom/direct loader or external write.

F4, 2026-10-22. Requires the rebuilt native DebugServer capability
`memory_change_watch` and the matching TypeScript MCP server. Restart the MCP
client to discover the four added tools. The original release binary lacks them.

The candidate came from FastestMolasses
[`fe9056c`](https://github.com/FastestMolasses/PCSX2-MCP/commit/fe9056c3f93207d1e3e18e60847b3d8271c3cedf).
This implementation uses our CPU-thread scheduler and identity guards. It does
not copy that fork's detached direct-memory polling thread. Upstream remains
PCSX2 v2.6.3, `bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`.

## Tools and bounds

| Tool | Behavior |
|---|---|
| `pcsx2_memory_watch_start` | Arm one EE or IOP RAM observer; never resumes. |
| `pcsx2_memory_watch_status` | Read its state/pair; optional wait of 0–30000 ms. |
| `pcsx2_memory_watch_list` | List all retained observers, at most 16. |
| `pcsx2_memory_watch_cancel` | Cancel this ID only; preserves an already changed pair. |

Example arguments to start (choose an address from your current build):

```json
{
  "cpu": "iop",
  "address": "0x00018000",
  "size": 4,
  "mask": 65535,
  "sample_interval_ms": 100,
  "timeout_ms": 30000,
  "pause_on_change": true
}
```

`size` is exactly 1, 2 or 4 bytes. The address must be aligned to that size and
the entire extent must fit canonical EE RAM `[0,0x02000000)` or canonical IOP
RAM `[0,0x00200000)`. Aliases, ROM and MMIO are refused. A nonzero optional mask
must fit the width; its default includes every bit in the selected width.
Sampling interval is 50–1000 ms (default 100); wall TTL is 100–300000 ms
(default 30000). `pause_on_change` defaults to false. Native checks also reject
malformed, fractional, overflowing or incorrectly typed numeric fields.

There are 16 slots shared by active and terminal observers. Starting when full
evicts the oldest terminal entry; it refuses if all 16 are active. IDs are random
32-character lowercase hex strings. An evicted, foreign or unknown ID fails;
there is no broad clear operation. Arming verifies process, server session,
execution epoch, current EE ELF/CRC and, for IOP, its native CPU-reset epoch.
Multiple change observers may coexist. Active exception/progress watches are
mutually exclusive with them in both directions, preserving the current owner.

## Sampling and evidence

The watchdog queues at most one memory-observer callback for its server session.
All guest reads, comparisons, lifecycle changes and optional pausing execute on
the CPU thread. Delayed callbacks from an old server session cannot sample or
clear the queue flag of a new session. Intervals are minimum requested spacing,
not a real-time scheduling guarantee; callbacks can be delayed by emulator work.

Only running samples outside active guarded-step/frame operations qualify.
Paused polls do not read RAM. The first qualifying sample establishes a baseline.
Pause/resume transitions, MCP register/memory/PC writes through DebugServer, nonadvancing CPU cycles
and a gap greater than four requested intervals rebase the next comparison.
TTL continues paused or disconnected. A blocked CPU thread can delay expiry and
cannot provide evidence of a host hang.

The first masked difference makes the observer terminal (`changed`). It retains
only two samples: `previous` and `current`, each with raw and masked unsigned
value, wall timestamp, elapsed monotonic milliseconds, sample PC and CPU cycles.
The pair is frozen before any optional pause. It survives reconnect, subsequent
MCP writes and ELF reset until evicted or server shutdown. It does not fetch a
new context, screenshot or stack when polled. `memory_change` appears in bounded
event history with the observer ID; history can independently roll over.

`writer_pc` is always null. A sampling PC is **not the instruction that wrote
the value**. A difference does not distinguish CPU stores, DMA or other writers;
change-then-restore, full-width wraps and changes in excluded periods can be
missed. Use exact native memory watchpoints when writer instruction provenance
is required. This feature observes a value change, not its cause or a crash.

Other terminal states are `expired`, `cancelled`, `vm_changed`, `vm_stopped`,
`cpu_reset` and `memory_unavailable`. ELF/VM reset invalidates armed observers;
IOP CPU reset invalidates armed IOP observers. An unknown reader result never
becomes a fabricated zero. Waiting timeout/cancellation leaves the observer
armed; explicit cancellation does not resume or touch breakpoints.

EE ELF identity is only boot affinity for IOP. The original F4 delivery did not
guard software reboot, module reload or restore. Later 5A3b terminates pending
IOP watches at observed boundaries as `lifetime_changed`; it does not identify
their raw addresses as IRX artifacts or permit reuse after those changes.
Cancel before operations outside the documented observed-path coverage.

## Acceptance and reproduction

Windows native build and TypeScript build passed, with **117 Node tests**.
The new live suite passed **10 checks**: stale identity and strict native input
refusal; paused zero-read expiry; foreign cancellation and watch conflicts;
capacity/terminal eviction; real EE/IOP byte/halfword/word changes and constant
masked values; writes and pauses rebasing; reconnect and optional IOP pause
with foreign breakpoints preserved; a bounded timing experiment; immutable
retention across ELF reset; and a real IOP CPU reset.

Regression: **10 progress** and **13 IOP exception/module checks**, run with
separate ports and private INI roots. Their harnesses now propagate the selected
environment to the stdio child. Native pristine/upgrade from `0086ab1`, reapply
and build checkout matched hashes for all **20 native files**. These are emulator
checks; there is no new physical PS2 or multimedia acceptance.

The SDK fixture builder retains its pinned container revision, sources, maps,
symbols and SHA256 manifest. Its added `watch.elf` loads a resident IRX whose
worker increments a counter by 0x100 every 80 ms after a two-second delay; EE
increments its own counter by 0x100. Constant low bytes and changing higher
bytes let tests distinguish masks without treating MCP writes as guest writes.
Test-only linked offsets and runtime range checks locate this known fixture;
they do not implement general IRX binding.

From the repository root, with Docker Linux running:

```powershell
rtk proxy python -X utf8 tools/build-iop-exception-fixture.py release/check-memory-watch
rtk npm test --prefix pcsx2-mcp-server
rtk proxy node pcsx2-mcp-server/test/memory-watch-live.mjs D:\dev\PCSX2-MCP\release\windows\pcsx2-qt.exe D:\dev\PCSX2-MCP\release\check-memory-watch D:\dev\PCSX2-MCP\release\windows D:\dev\PCSX2-MCP\release\check-memory-live
```

Substitute actual absolute paths. The live harness requires a new output
directory, copies only the configured INI into a private root, enables HostFs
there, chooses an unused debug port and stops only its owned emulator. It does
not copy the BIOS or modify the source INI. Local ignored receipts:

- `release/memory-watch-live-20261022-accepted/validation.json`
- `release/memory-watch-regressions-20261022-accepted/`
- `release/memory-watch-integration-20261022-accepted/integration.json`
- `release/memory-watch-acceptance-20261022.json`

The live receipt includes three paired 500 ms control/16-observer runs, guest
EE cycle deltas and summed `sampling_cpu_ns`. That metric measures read/compare
work only, excluding callback queueing, scheduling, identity checks and pause
cost. A throttled isolated fixture does not establish general game performance,
real-time guarantees or a universal overhead percentage. Raw measurements remain
in the receipt for comparison on the same host/configuration.
