# MCP development progress

Updated: 2026-10-24. This records the debugging extensions after the original main
commit `8f9bf45`. Each implementation remains in a separate commit so its
behavior, native integration and tests can be reviewed together.

## Active scope

User direction on 2026-10-24: test the MCP independently of SMS and debug that
project in another chat. The standalone suite and its own acceptance take
priority. Application audio/SIF2 work remains a separate backlog.
[Commands and evidence](standalone-validation.md); [handoff](MCP-HANDOFF.md).

## Delivered improvements

| Area | Commits | Result and contract |
|---|---|---|
| Bounded EE/IOP instructions | S2a, this delivery | CPU selection, shared sequence budget, native identity/PC guards, partial JSON results, timeout cleanup/recovery. 231 Node, 32 live and 26-file integration passed. IOP fixture masks current IRQ enable; broader game/branch behavior remains open. [Contract](instruction-control.md). |
| Standalone validation and step cleanup | S1, this delivery | Independent rendered and EE/IOP homebrew, repeatable runner; legacy step/step-over remove owned private points before returning. Windows/TypeScript, 223 Node, 18 live and 26-file integration passed. [Contract](standalone-validation.md). |
| SIF/PGIF observations | 6B2b1, this delivery | Read-only paused state and last 64 actual PGIF DMA writes; high-half BCR write leaves backing word unchanged in two SMS runs. Windows build, 223 Node, 26-file integration, five live and 12 evidence checks passed. Playback still fails; ACK fix pending. [Contract](sif-diagnostics.md). |
| Real SMS audio incident | 6B2a, this delivery | Known clip selected through actual controller/UDPFS/Jellyfin; zero PCM and stalled player clocks, separate verified first SIF2 header-ACK wait. Playback remains failed. 215 Node, eight DWARF controls, four transport regressions and seven evidence checks. [Scope](sms-playback-audio.md). |
| Decoded audio measurements | 6B1, this delivery | SHA-pinned MP4/PCM/JSON, per-channel RMS/peak/DC and silence-window metrics; 208 Node tests, ten real AAC/MCP checks and ten native media checks. SMS playback/listening/A/V gates remain pending. [Contract](audio-measurement.md). |
| Rendered screenshots | `eef0e8e`, `79ce272`, `d128b3b` | Bounded PNG images over MCP, renderer errors and native Windows support. [Validation](screenshot-validation.md). |
| Debug sessions | `04bc127` | Session identity, bounded event/log history, ELF reload and context artifacts. [Usage](debug-sessions.md). |
| Launch and automation | `2739a16` | Owned emulator launch/stop and bounded video-frame/controller operations. [Usage](automation.md). |
| Symbols and scenarios | `efae4fc` | Symbol lookup, named breakpoints and repeatable assertions with saved evidence. [Usage](workflows.md). |
| Source lookup | `71d8566` | Offline debug-ELF source locations and guarded current EE PC lookup. [Usage](source-debugging.md). |
| Source breakpoints | `95155c2` | Exact executable file/line resolution, ELF identity guards and owned breakpoint groups. [Usage](source-breakpoints.md). |
| Source stepping | `6e775d0` | Bounded EE into/over/out with branch/delay-slot handling, interruption and private-breakpoint cleanup. [Usage](source-stepping.md). |
| Variables | `79b3d5b` | Read-only arguments/locals/types for supported DWARF locations at physical EE frame 0. [Usage](variables.md). |
| Automatic EE evidence | `4c8a042`, `40750e6` | One-shot native exception watches and independent EE BREAK JIT instruction provenance. [Usage](exceptions.md). |
| IOP exceptions | `3cb66b9` | Real IOP GPR/CP0/HI/LO, R3000 Status semantics, IOP context and CPU-reset identity. [Usage](iop-exceptions.md). |
| Additional trap provenance | `3279461` | EE SYSCALL and IOP BREAK/SYSCALL call-site evidence; original exception behavior and HLE paths remain visible. [Usage](exceptions.md). |
| Explicit progress signal | `7db45ed` | Native EE heartbeat observation, expected-wait gate, bounded history and automatic evidence capture. [Usage](progress-watches.md). |
| IOP runtime modules | `49bf380` | Bounded paused loadcore inventory, address-to-runtime-range association and frozen module observations in exception reports. [Usage](iop-modules.md). |
| Independent emulator instances | F1, 2026-10-21 | Validated environment/explicit ports, per-process data roots, PID/port/root launch checks, exclusive Windows bind and socket session guards. [Usage and evidence](automation.md#independent-instances). |
| Owned GS dumps | F2, 2026-10-21 | Identity-guarded uncompressed GS capture, native frame/time/byte limits, owned cancellation, close notification and checked/hashed streams. Native replay produced a rendered PNG. [Usage and evidence](gs-dumps.md). |
| Owned video/audio capture | F3, 2026-10-22 | Per-request MP4 capture with frame/time/encoded-payload limits, exact-file stop, native close/error evidence and ffprobe checks against actual tracks/frame count/size. Audio audibility and A/V sync remain unmeasured. [Usage and evidence](media-capture.md). |

## Operational improvements

6A (2026-10-24) adds offline `pcsx2_compare_screenshots` and scenario
`assert_screenshot`: decoded pixel tolerances, explicit named regions/masks,
hash-pinned references, sampled local ELF/process/session/epoch identity and
input/diff/JSON evidence preserved on failure. TypeScript and 193 Node tests
passed, plus ten visual live checks and seven workflow regressions. A perturbed
reference fixture triggered the expected 16-pixel failure; no guest change or
gameplay/perceptual/A/V/hardware validation is claimed. Native/Bridge unchanged.
[Contract, bounds and evidence](visual-regression.md). Next: 6B audio criteria.

5B2b (2026-10-24) adds an optional SMS incident recipe to the live transport
harness. It reached the exact `SMS_JellyfinUpdateCheck` guard, verified an empty
path via DWARF/runtime byte-load addressing, observed the direct logger call
and argument, captured EE registers/45 IOP runtime modules, then joined the
subsequent ERROR to its real console/Bridge fields in the same boot. Eight
incident live checks, four transport regressions and four metadata refusals
passed. Core runtime/build hashes retain the historical 174-test baseline;
no rebuild or historical suite rerun. This verifies the HostFs emission path,
not physical E11/audio causality. [Evidence, recipe and limits](project-incidents.md).
The next original-roadmap item is 6A tolerant visual regression by regions.

5B2a (closed 2026-10-24) validates fresh actual SMS → UDPFS → Bridge events
against Jellyfin 12.2.0 with a verified dedicated nonadministrator user.
The live harness requires a new journal and private emulator/project settings;
four events of the same build/boot matched, including `update_path_failed`.
Four live checks passed, with expected failure for a missing Bridge journal
and pre-launch rejection of historical receipts. Emulator and owned services
were stopped. The 174-test runtime baseline is unchanged; no builds or old
suites were repeated. Playback, hardware and incident CPU/source investigation
remain pending. [Evidence and reproduction](project-diagnostics.md#5b2a-fresh-sms-transport-acceptance).

5B1 (2026-10-23) adds `pcsx2_diagnostics_collect` and
`pcsx2_diagnostics_correlate`: bounded sanitized native history and offline
build/boot association with Bridge client-event JSONL. Manifest/ELF/capture
hashes, exact reported fields and explicit missing/ambiguous evidence prevent
silent mixing. Clock uncertainty stays unbounded; no exact timeline or cause
is inferred. TypeScript and 174 Node tests passed; seven new live checks and
11 input-movie regressions passed. Bridge association used synthetic receipts
and historical journals; 5B2a above subsequently validated fresh transport.
[Inventory, contract and evidence](project-diagnostics.md). Native/Bridge runtime
did not change and was not rebuilt.

F5 (2026-10-23) adds five native input-movie tools: bounded power-on recording,
read-only copied replay, EOF stop, owned status/stop and offline inspection.
Reset/restore invalidate EE inspection and pending observers as well as IOP
tracking. Windows/TypeScript builds, 163 Node tests, 11 new live checks and 33
regressions passed; integration agrees across 25 native files.
[Contract and evidence](input-movies.md). Savestate-start movies and deterministic
network replay remain pending. The original plan resumes with 5B correlation.

5A3b (2026-10-23) adds scoped observed-registration generations and four explicit
IOP binding tools. A binding starts from verified full-file provenance, then
freshly revalidates artifact, runtime code and native namespace/sequence on every
later source query. Modload load/stop/unload/reboot entry observations extend
invalidation; pending IOP exception/memory watches end as `lifetime_changed`.
Windows/TypeScript builds, 152 Node tests, 12 new live checks and 55 regressions
passed; integration agrees across 21 native files. [Contract](iop-bindings.md).
This completes the documented observed-path 5A3 delivery; custom/direct paths
and universal module generations are not claimed. F5 followed this delivery.

5A3a (2026-10-22) adds `iop_lifetime_epoch`, native request guards and
`pcsx2_iop_lifetime` with a 64-entry boundary journal. Actual module registry
calls, transported standard SIF reset packets, restore attempts, locator changes
and DebugServer writes invalidate conservatively. Software request observation
does not claim reset completion; CPU-reset identity stays separate. Windows and
TypeScript builds, 142 Node tests, 11 new live checks and 44 regressions passed;
native integration agrees across 21 files. [Contract](iop-lifetime.md).
The later 5A3b delivery above adds scoped explicit bindings; universal lifetime
coverage remains partial.

5A2b (2026-10-22) adds explicit HostFs load watches and full-file receipts,
matching actual descriptor bytes to loadcore input and registration calls.
Optional `load_watch_id` checks the complete candidate load image, including
initial writable bytes, and reports the observed original file SHA at the first
guarded pause. Registered export tables are bounded and function pointers stay
checked. Windows/TypeScript builds, 136 Node tests, 11 new live checks and 33
IRX/IOP/memory regressions passed; integration agrees across 20 native files.
[Contract and limits](iop-load-provenance.md). Other devices/dialects and reusable
module lifetime/generation tracking remain pending; 5A3a above adds conservative
observed-boundary guards; 5A3b above adds revalidated bindings for that scope.

5A2a (2026-10-22) adds guarded IRX immutable-image association and IOP source
lookup. It hashes the selected local artifact, reconstructs supported relocations
and revalidates native bytes/metadata/pause and file state after lookup. Actual
IOP breakpoint addresses resolve through IRX DWARF2. [Contract](irx-source-association.md).
Windows/TypeScript builds, 127 Node tests, 10 new live checks and 23 IOP/memory
regressions passed; native integration still agrees across 20 files. The later
5A2b delivery above adds supported load-file provenance; additional layouts and
module generations remain pending.

F4 (2026-10-22) adds up to 16 bounded one-shot EE/IOP memory-change observers
sampled on the CPU thread, masks for 1/2/4-byte values, wall TTL, owned
cancellation and optional pause. Frozen pairs preserve sample PCs/cycles and
explicitly unknown writer PC. [Contract and acceptance](memory-change-watches.md).
Windows build, 117 Node tests, 10 new live checks and 23 progress/IOP regressions
passed; integration agrees across 20 native files. F1–F4 are complete in the
documented emulator scope; 5A2a is recorded above as the following delivery.

Both the TypeScript server and the native PCSX2 integration have changed.
Rebuild both and restart the MCP server/client to discover the added tools and
fields. The original release binary does not contain these extensions; source
commits do not imply that a new binary release has been published.

Execution operations have explicit ownership, bounds and terminal states.
Arming exception/progress watches does not resume execution. Native watches can
capture without report polling, and retained reports survive client reconnect.
VM/ELF/reset identity, unavailable data and uncertain cleanup remain explicit.
Captured evidence is not silently replaced with a new live VM context.

The implementation preserves upstream PC/BD/CP0 behavior even when independent
JIT evidence disagrees. HLE calls that do not raise an exception do not produce
fabricated exception reports. Runtime module names and ranges do not become
local IRX artifact identity or EE source mappings.

## Next work, in order

The user authorized implementing the candidates from the
[fork review dated 2026-10-21](fork-review-2026-10-21.md), then resuming the
original sequence below. Follow [IMPLEMENTATION-PLAN](IMPLEMENTATION-PLAN.md):
each validated delivery must be committed and published to `main` of
`michaaels/PCSX2-MCP`, with the remote HEAD checked. Native input replay applies
the documented reset/restore and observed module-lifetime invalidations.

1. **S2b: independent reset/reconnect and broader instruction coverage.** S2a
   accepts the documented bounded EE/IOP vectors, timeout cleanup and partial
   sequences: 231 Node and 32 live checks. Next are reset/restore, GUI replacement,
   reconnect generations and interrupt-active IOP; then recovery/CI.
   Preserve unsupported branch/device limits. [Instruction contract](instruction-control.md).
2. **Application backlog, separate chat: 6B2b2.** 6B2b1 adds
   paused SIF/PGIF state and bounded write observations; see [evidence](sif-diagnostics.md). 6B2a
   now measures a real failed attempt: known clip, zero captured PCM, stalled
   player clocks and a separate verified first header-ACK wait. Investigate the
   IOP/emulator acknowledgment path with independent evidence, then repeat the
   clip successfully. Listening, A/V timing and physical intermittent audio
   remain separate; the incident verifier accepts evidence only.
3. **Long-run/recovery and CI.** Add repeated playback/catalog/network recovery
   with bounded failure criteria, and CI separation for tests without BIOS or
   hardware. 5B2 fresh transport and the scoped HostFs incident are already
   proven; retain clock uncertainty and separate E11/audio acceptance.
4. **Measured diagnostics and editor workflows.** Add verified SIF/RPC, DMA and
   A/V observations where available, with overhead evidence, then a DAP adapter
   over supported operations. Unavailable metrics must remain explicit.
5. **Extend scoped coverage with separate acceptance.** Savestate-start movies
   require a checked/copied companion and finalized asynchronous save handling.
   Additional loader/reset/BIOS coverage and universal generations remain pending.
   Existing IOP source bindings always require fresh revalidation.

## Scope limits

Source stepping and current-frame variables cover the documented EE subset;
IOP source/variable debugging is not implemented by runtime module association.
Neither a configured heartbeat stall nor an exception observation proves a
deadlock, fatal crash or root cause. A heartbeat must represent useful work in
the program, with legitimate waits signaled appropriately.

The latest debugging acceptance targets Windows PCSX2 v2.6.3. Earlier rendered
screenshot checks also used Linux/WSL; that does not validate every later
debugging feature on Linux. Emulator tests do not establish physical PS2 debug
support or playback/audio acceptance. See the feature contracts above for
their individual limits and the [consolidated validation record](debug-validation.md).
