# MCP development progress

Updated: 2026-10-21. This records the debugging extensions after `origin/main`
commit `8f9bf45`. Each implementation remains in a separate commit so its
behavior, native integration and tests can be reviewed together.

## Delivered improvements

| Area | Commits | Result and contract |
|---|---|---|
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

## Operational improvements

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
`michaaels/PCSX2-MCP`, with the remote HEAD checked. Native input replay remains
dependent on reset/save-state identity and module lifetime handling.

1. **Bind an exact IRX artifact to an observed IOP load.** Validate file identity
   and loaded bytes while accounting for relocations. Name/version or an assumed
   load bias is insufficient. Source lookup must use guarded validated bindings.
2. **Define IOP module lifetime/revalidation.** Handle unload/reload, software
   `SifIopReset` and save-state restore before reusing old load identities.
   Current IOP reset epochs cover native CPU resets only.
3. **Correlate project diagnostics.** Relate EE/IOP events and emulator/build
   identity to application/network logs, preserving cross-process clock uncertainty.
4. **Add measured PS2 diagnostics.** Expose verified SIF/RPC, DMA and A/V state
   where available, and measure instrumentation overhead. Missing metrics are
   unavailable rather than zero.
5. **Extend regression and editor workflows.** Tolerant visual comparison,
   defined audio criteria, long-run/recovery tests, CI separation and a DAP
   adapter over capabilities the backend actually supports.

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
