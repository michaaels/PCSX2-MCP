# Conservative IOP lifetime boundaries

5A3a, 2026-10-22. Rebuild native PCSX2 and TypeScript, then restart MCP.
Capability: `iop_lifetime`. This delivery adds an invalidation epoch and bounded
history for observed loader, registry, reset and restore boundaries. It is the
first part of 5A3. Later [5A3b](iop-bindings.md) adds scoped observed generations,
explicit revalidated bindings and propagation to pending IOP watches. This
document's acceptance below records the earlier 5A3a delivery.

## Tools and guards

Call `pcsx2_iop_lifetime` with no arguments. It reads the current
`iop_lifetime_epoch`, CPU-reset epoch, session/execution identity, process ID,
current locator and last 64 boundaries. It never pauses, resumes, installs
breakpoints or writes guest memory. It works while running; another observed
boundary may occur immediately after the response.

Each entry has an epoch, host timestamp, kind and raw address relevant to that
boundary. Epochs advance monotonically in the native process and are not part
of a guest savestate. Native server restart clears the journal, retaining the
process epoch counter. `history_truncated` marks actual ring eviction, not a
complete history of every module operation. This diagnostic is not a wait or
replay API, and does not hash or persist an artifact binding.

Current capabilities, module snapshots/images and load-watch states carry
`iop_lifetime_epoch`. Module snapshot/image requests and load-watch starts must
send `expected_iop_lifetime_epoch` to the new native build, in addition to their
existing VM/CPU/ELF/pause guards. A stale or missing value refuses before reading
module RAM or arming a watch. The Node client sends and checks it; clients using
the TCP protocol directly must also update. Older native builds without this
capability retain their previous, narrower contract.

IRX source/verification reads fresh native images before and after lookup, so
a changed epoch discards the result even if the record, name, PC, pause revision
and code bytes otherwise match. With `load_watch_id`, the receipt's registration
epoch must match the current image too. It still permits association only at
the first guarded pause; the epoch does not extend that scope.

## Observed boundaries

| Kind | Evidence and effect |
|---|---|
| `server_start` | Native server starts a new journal/session. |
| `vm_reset` | Existing VM reset hook; clears locator and pending SIF observation. |
| `cpu_reset` | Actual IOP `psxReset`; the existing `iop_reset_epoch` also advances. |
| `load_object_call` | Entry to observed loadcore import 23. A call is not proof of loader success. |
| `register_module_call` | Entry to observed loadcore import 16, with the raw record address. A new full-file receipt records this epoch. |
| `release_module_call` | Entry to observed loadcore import 17. Invalidates pending/current load association even if release later fails. |
| `loadcore_locator_changed` | A different published locator; repeated publication of the same address does not advance the epoch. |
| `sif_reset_packet` | A supported reset-shaped packet actually transported into canonical IOP RAM through SIF1 DMA. Clears locator and pending load provenance. |
| `savestate_load_attempt` | Entry to native `DoLoadState`, before restoring memory. Advances pause revision and clears locator/pending SIF observation even if loading fails. |
| `debugger_mutation` | DebugServer memory/register/PC write request; conservatively invalidates even for same-byte writes or later refusal. |
| `module_service_call` / `module_reboot_call` | Later 5A3b observes selected modload load/stop/unload and reboot entry calls; ordinals are carried in `address`. |

All journal/epoch mutations occur on the CPU thread. Loadcore observers return
to the original guest functions without replacing their behavior. Boundary
observation invalidates the current registered load association; historical
captured bytes remain retained until another watch supersedes them or the
native server closes. `module_generation` stays null.

## Software reset observation

The pinned SDK's standard `SifIopReset` sends a 104-byte command, rounded to a
112-byte SIF1 DMA transfer. The observer starts only for an interrupt-bearing
28-word tag targeting canonical aligned IOP RAM. It collects at most 26 words
from the bytes actually written, requiring contiguous chunks within that tag.
It checks packet size 104, command ID `0x80000003` and argument length at most
79. A new tag, invalid chunk, CPU/VM reset or restore discards partial state.
No guest writes, extra DMA, interrupt changes or handler calls are introduced.

The event proves **transport of a supported reset-shaped request**, not handler
dispatch, completion or success. A matching ordinary data transfer can cause
conservative invalidation. The live fixture separately stops after actual
`SifIopSync` returns; the general API does not infer that result. CPU reset and
software-reset request remain distinct: `iop_reset_epoch` continues to declare
`cpu_reset_only`. The new observer does not change that existing watch contract.

Primary references, independently implemented:

- PS2SDK [`iopcontrol.c`](https://github.com/ps2dev/ps2sdk/blob/89b9d8cf249f927192c57804ce5e55e99e34002d/ee/kernel/src/iopcontrol.c)
  and [`sifcmd-common.h`](https://github.com/ps2dev/ps2sdk/blob/89b9d8cf249f927192c57804ce5e55e99e34002d/common/include/sifcmd-common.h), revision `89b9d8cf249f927192c57804ce5e55e99e34002d`.
- PS2SDK [`loadcore.h`](https://github.com/ps2dev/ps2sdk/blob/89b9d8cf249f927192c57804ce5e55e99e34002d/iop/system/loadcore/include/loadcore.h)
  for registry ordinals. The pinned legacy build SDK omits those declarations;
  the isolated fixture declares the required ABI explicitly.
- Native integration stays on PCSX2 v2.6.3
  `bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`, including `Sif1.cpp`'s tag and actual
  FIFO-to-IOP write paths. No upstream shared class layout was changed.

## Acceptance

Windows native/TypeScript builds and **142 Node tests** passed. **11 new live
checks** cover read-only observation, stale native guards, actual full-file load,
guest release/removal, same-address re-registration with identical code,
reconnect, 64-entry eviction, actual SifIopReset/SifIopSync, native savestate
loading, guest MMIO CPU reset and VM reset. Regression: **11 load-provenance**,
**10 IRX/source**, **13 IOP exception/module** and **10 memory-watch** checks.
Total: **55 live checks**. Pristine, upgrade from `0a186f4`, reapply and build
checkout agree for **21 native files**. Integration validates before writing.

The fixture's module at record `0x00045000` was present at epoch 10, absent after
the genuine release call at epoch 11, and present with the same text/code after
re-registration at epoch 12. The old receipt was refused. A real software-reset
packet to `0x00019600` appeared at epoch 91 while the CPU-reset epoch stayed
unchanged. Coordinates/epochs are run-specific. The fixture changes registry
membership without freeing/reloading its code; this is not a complete test of
the game module-unload service. No test assigns PC to simulate those calls.

The SDK builder now creates `lifetime.elf`; its companion IRX has 47 load
relocations and SHA256
`1222742672ae0bc5f833d8dae1b08a6d7f7d2c139ffa6ab0a7dac2aaae751aee`
for the stripped loaded file. Existing fixture modes keep their behavior.

From the repo root, with Docker Linux running and configured Windows PCSX2:

```powershell
rtk proxy python -X utf8 tools/build-iop-exception-fixture.py release/check-lifetime
rtk npm test --prefix pcsx2-mcp-server
rtk proxy node pcsx2-mcp-server/test/iop-lifetime-live.mjs D:\dev\PCSX2-MCP\release\windows\pcsx2-qt.exe D:\dev\PCSX2-MCP\release\check-lifetime D:\dev\PCSX2-MCP\release\windows D:\dev\PCSX2-MCP\release\check-lifetime-live
```

Replace paths with actual absolute paths. The Windows harness uses its own
ports, INI/data root, fixture copy and savestate. It stops only its owned
emulator and neither copies BIOS nor edits the source configuration. Use new
output directories. Local ignored receipts:

- `release/lifetime-live-20261022-final/validation.json`
- `release/lifetime-regressions-20261022/`
- `release/lifetime-integration-20261022/integration.json`
- `release/lifetime-acceptance-20261022.json`

## Later delivery and remaining coverage

The scope is `observed_boundaries_only`. Internal/direct loader calls bypassing
the instrumented imports, other software reboot mechanisms, other SIF packet
layouts/aliases and arbitrary external writes are not fully tracked. The SIF
observer's malformed/fragmented-input matrix has not all been exercised live.
There is no universal performance or all-BIOS acceptance, and no new physical
PS2 or A/V acceptance.

5A3b adds observed per-record sequences/namespaces, explicit artifact bindings
that revalidate on every use, and `lifetime_changed` termination of pending IOP
exception/memory watches at observed load/reboot/restore boundaries. The CPU
reset counter still has its separate `cpu_reset_only` scope. Historical reports
do not automatically become artifact bindings. Direct/custom loader paths and
other unsupported reset mechanisms remain partial. Next: F5 controlled replay
under the [binding contract](iop-bindings.md) and
[implementation plan](IMPLEMENTATION-PLAN.md).
