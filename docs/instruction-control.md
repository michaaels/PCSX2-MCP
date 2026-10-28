# Bounded EE/IOP instruction control — S2a

The MCP tools `pcsx2_step` and `pcsx2_step_over` now select `cpu: "ee" | "iop"`.
EE remains the default. Rebuild the native integration and Node server, then
reconnect: the tools require the `bounded_instruction_step` feature.

```json
{"cpu":"iop","count":2,"timeout_ms":1000,"show_registers":true}
```

Use that input for `pcsx2_step`. `pcsx2_step_over` accepts the same CPU, timeout
and register options, without `count`:

```json
{"cpu":"ee","timeout_ms":250}
```

## Contract

- The VM must already be paused. `count` is an integer from 1 through 100.
  `timeout_ms` is an integer from 10 through 5000, default 1000. A sequence shares
  one execution budget; a new full budget is not assigned to every instruction.
  CPU-thread preparation, protocol and cleanup add latency to that budget.
- The Node operation owns its connection's exclusive session. Native requests
  validate process, server session, execution epoch, ELF path/CRC and starting
  selected CPU PC before executing. IOP additionally validates reset/lifetime
  epochs. Native replies and subsequent paused state/identity are checked.
- Identity is native session affinity, not a new SHA proof of RAM or IOP module
  contents. The general tools do not bind an IOP address to a particular IRX.
- Success returns JSON with `completed:true`, selected CPU, identity, requested
  count, exact native steps, execution budget and elapsed time. Each step retains
  old/new PC, opcode/disassembly, paused state and confirmed breakpoint cleanup.
  `show_registers` reads GPRs for the selected CPU after the final step.
- Errors return `completed:false`, an error and any confirmed completed steps
  under `partial.steps`. A later failure does not erase earlier execution.
  Cancellation is checked before/between commands. An in-flight native request
  is allowed to reach its deadline and cleanup; cancellation is not instantaneous.
- A native timeout pauses the same VM and removes only the owned private point.
  Foreign successor points are refused before execution; earlier foreign hits
  interrupt the operation and remain installed. Changed/replaced/overlapping
  ownership is preserved with an explicit unconfirmed-cleanup error. A changed
  VM/IOP lifetime is not paused during cleanup.
- Low-level legacy clients may omit expected identity, preserving the existing
  wire entry point; MCP tools always send guards. Native requests also enforce
  the 10–5000 ms range. Existing Node clients sending no explicit timeout now
  receive the native one-second default.

`step` retains the legacy PC+4 target convention. `step_over` targets PC+8 for
JAL/JALR and PC+4 otherwise. These are not universal MIPS branch/delay-slot
semantics. Use [guarded source stepping](source-stepping.md) for supported EE
branch control. IOP source stepping, exception returns, every branch form and
arbitrary interrupt-active instruction sequences are not accepted by this work.

The two MCP tools previously returned formatted text; they now return structured
JSON, including partial execution on errors. Existing tool names and EE defaults
remain. Consumers parsing the old text need to update.

## Defect reproduced independently

On the previous native SHA
`bad4ba4f2e1a532623932b0de7879862bb8a076ba4ac12aaf497ef2003ff3c28`,
step-over of a real JAL to a non-returning loop used a ten-second native wait,
the same as the client transport deadline. The retained baseline observed
`Command timeout: step_over` after 10014 ms and `connected:false`. It stays a
failed baseline; its subsequent reconnect attempt also failed, and the owned
emulator was stopped. No general reconnect fix is claimed.

With the new native execution limit, a requested 100 ms timeout in both EE and
IOP returns a native timeout error, leaves the VM paused, removes the private
target and permits another instruction on the same connection. Measured host
latency includes protocol/scheduling overhead; it is not guaranteed to equal
100 ms exactly. See the retained JSON for each observation.

## Independent fixture and acceptance

`tools/build-instruction-fixture.py <new-directory>` builds a small EE ELF and
resident IOP IRX with the pinned SDK. The fixture has known add-immediate, real
JAL/callee/return and non-returning-loop vectors. It reports actual relocated
IOP addresses. The harness checks symbol-relative addresses and actual RAM
instruction words against the debug IRX, applying the J/JAL R_MIPS_26 relocation
to their operands instead of comparing unrelocated bytes.

These tests intentionally redirect PC in their own fixture. The IOP portion
executes fixture-owned CP0 instructions to clear the current interrupt-enable
bit, retaining status before/after in IOP RAM; the EE is parked in a loop. This
is a controlled instruction test, not an application or kernel safety claim.
The public MCP tools do not perform this interrupt isolation.

An earlier IRQ-active run recorded the expected IOP breakpoint event, followed
by a paused PC at `0x80000080`; the tool refused success because the PC had moved.
The complete cause of that vector entry was not established. Those attempts
are excluded from deterministic IOP instruction acceptance. A fixture version
also failed a status-storage check due to its relocation sequence; the accepted
fixture uses one full address and ordinary offsets for both stored words.

**14 instruction live checks** passed: exact fixture/IRX identity; for each CPU,
two instruction effects, real JAL step-over, foreign successor refusal, earlier
foreign interruption, timeout/recovery and stale native identity refusal; plus
an IOP sequence retaining exactly one completed instruction on a later refusal.

The main standalone command now includes this fixture and suite:

```powershell
rtk proxy python -X utf8 "D:\dev\PCSX2-MCP\tools\validate-standalone-mcp.py" --emulator "D:\dev\PCSX2-MCP\release\windows\pcsx2-qt.exe" --data-directory "D:\dev\PCSX2-MCP\release\standalone-data" --output "D:\dev\PCSX2-MCP\release\instruction-check-new"
```

`--instruction-fixture <directory>` reuses a matching retained build, alongside
the existing render/SIF fixture options. Source inputs and manifests are checked.

The rebuilt Windows executable and TypeScript passed **231 Node tests** (eight
new) and **32 total live checks**. Pristine/upgrade from `67e2a46`, repeated
application and the build checkout agree across **26 managed files**. The suite
uses no SMS, Jellyfin or network server. No DMA transport, decoder, playback,
audio or physical PS2 acceptance changed.

Retained ignored evidence:

```text
release/instruction-baseline-20261024-02/validation.json
release/instruction-baseline-source-20261024.mjs
release/instruction-acceptance-20261024-final/validation.json
release/instruction-live-20261024-accepted/validation.json
release/instruction-integration-20261024/integration.json
release/instruction-delivery-20261024.json
```

Next S2b: reset/restore/GUI replacement and reconnect-generation coverage,
interrupt-active IOP observations and broader branch/device cases with separate
acceptance. CI and editor work follow supported capabilities, not assumed ones.

## S2b1 follow-up (2026-10-27)

The Node client now isolates sockets, queues and operation scopes across
reconnects. Actual reset/restore rejects old instruction identities and recovers
fresh inspection. [Recovery contract](connection-recovery.md) records 247 Node
and 37 live checks, with the same native executable. GUI replacement and broader
interrupt-active instruction behavior remain separate acceptance gates.

## S2b2b follow-up (2026-10-28)

[IRQ-active pause validation](irq-pause-boundary.md) adds a separate worker and
actual VBlank callback fixture without masking current IE. It reproduces and
fixes hardware IRQ dispatch after an IOP breakpoint has already paused the VM.
Six checks cover exact vectors, enabled IRQ activity, step/step-over and timeout
with callback progress/recovery. The full suite passes 255 Node / 53 live and
13 additional IOP regressions. The original S2a IRQ-isolated acceptance above
remains historical; no arbitrary game/branch/device or GUI coverage is inferred.
