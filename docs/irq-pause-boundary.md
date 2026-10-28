# IRQ-active IOP stops and dispatched restore reconciliation — S2b2b

Validated on Windows on 2026-10-28, without SMS/Jellyfin. Rebuild/restart native
PCSX2 for the IOP pause correction. The Node runtime remains unchanged from
S2b2a; this delivery adds live coverage and an independent IRQ fixture.

## Reproduced IOP defect

An actual VBlank-enabled IOP fixture hit its own worker breakpoint at
`0x00045650`, as recorded by the native breakpoint event. The paused IOP PC then
read `0x80000080`. This reproduced the earlier unexplained vector-entry symptom
with a separate resident module, a real thread/stack and a growing IRQ callback
counter. The failed baseline remains retained and is not accepted as a pass.

The native EE event loop calls `iopEventTest()` after `psxCpu->ExecuteBlock()`
returns. An IOP breakpoint pauses the VM and exits that block, but its final
event test could still dispatch a pending hardware interrupt through
`psxException(0, 0)`, changing PC/CP0 after the stop had already been reported.

The integration now defers only that hardware interrupt dispatch when the MCP
server is active and the VM is paused. It preserves the interrupt-controller
status, CP0 enable bits, counter/event scheduling and normal running path. The
pending interrupt can be handled on resume. No paused-PC rollback, forced PC
rewrite, IRQ mask or instruction-semantic change is added to the public tools.
Existing provenance and software exception hooks remain in place.

## Independent fixture and actual checks

`tools/build-irq-fixture.py <new-directory>` builds an EE loader and a resident
IOP module with the existing pinned PS2SDK image. The module registers a VBlank
callback and starts its own low-priority thread. The callback records Status
and increments shared RAM; the worker records its initial current IE bit.
The fixture never clears that bit. Tests redirect only this fixture worker's PC
to its known vectors, retaining a valid thread/stack for interrupt handling.
This does not prove that redirecting arbitrary kernel/application PCs is safe.

The callback declaration/imports were checked against the pinned SDK headers;
the corresponding [PS2SDK VBlank API](https://github.com/ps2dev/ps2sdk/blob/master/iop/system/vblank/include/vblank.h)
and [implementation](https://github.com/ps2dev/ps2sdk/blob/master/iop/system/vblank/src/vblank.c)
explain the registration and callback convention. The installed pinned headers,
not current upstream ABI assumptions, were used for compilation.

Six live checks passed:

1. Manifest/IRX/runtime instruction bytes and relocated symbols match; thread
   creation, start and VBlank registration succeeded.
2. Four video frames increase the actual callback count. The worker records
   current IE enabled; the callback records current IE disabled in its context.
3. The worker breakpoint leaves the paused IOP PC at its reported address.
4. Five two-instruction MCP sequences produce exact PC/register effects and
   remove their owned breakpoints, with IRQ delivery enabled.
5. A real JAL/callee step-over reaches its physical return with the exact effect.
6. A non-returning call times out under a 250 ms native budget while the actual
   callback counter grows, pauses/cleans its point, and permits another step.

The final fixture fixes an earlier test layout that placed the infinite-loop
entry at the call's return target; that version correctly stopped there and was
excluded from timeout acceptance. An earlier high-priority worker starved its
loader; the final worker priority is 126. An initial build failed to link an
implicit `memset`; field initialization replaced it. These are fixture failures,
distinct from the retained paused-PC defect. No failing run was counted as passed.

## Restore cancellation after dispatch and lost replies

The existing state-load live suite adds two real loopback fault cases. A proxy
forwards the genuine load request to native PCSX2, aborts the caller after the
socket write, and either forwards or discards the actual native completion.
It never synthesizes a successful native load or resends the request.

- With the reply delivered, the result remains `loaded`, records
  `cancellation_requested:true`, restores the exact saved counter and exposes
  the native receipt through the public MCP status tool.
- With the actual successful reply discarded, the wrapper returns `unknown`
  and `loaded:null`. RAM nevertheless matches the saved value. A subsequent
  read-only status query proves completion with that exact native receipt.
  Each case forwarded exactly one load request.

These use the same wrapper/AbortSignal as the MCP handler and a real emulator.
They prove cancellation after submission and reconciliation of a lost reply;
they do not measure whether the signal preceded native deserialization, test
SDK cancellation-notification delivery, or implement interruption/rollback of
the synchronous native loader. Forcibly abandoning a partially applied state
has no supported cancellation boundary in this integration. That feature remains
deferred; the tool must continue reporting actual completion or uncertainty.

## Acceptance and retained evidence

Windows/TypeScript builds and **255 Node tests**, **53 standalone live checks**
(six IRQ and two restore fault cases added), **13 extra IOP exception/module/reset
regressions**, and **26-file pristine/upgrade/reapply/build integration** passed.
The extra regression uses copied hash-verified fixtures and a private data root;
an initial adapter omitted HostFs when its INI had no EmuCore section, failed
module load with -203, and remains excluded. All owned emulators were stopped.
Native SHA256:

```text
0ac98690349d815b5dc5fd4786e23d3a7d7821b136e101ebad8dcfa3462e8e46
```

The standalone command now accepts `--irq-fixture <built-directory>`; otherwise
it builds this fourth fixture with Docker. It runs seven native suites. Reuse
the render/SIF/instruction options as before; all fixture source manifests must
match the checkout. [Runner instructions](standalone-validation.md).

Ignored local evidence:

```text
release/irq-live-20261028-02/validation.json       # paused-PC failed baseline
release/irq-live-20261028-fixed/validation.json    # fixed stop; fixture timeout excluded
release/irq-fixture-20261028-05/manifest.json
release/irq-live-20261028-final/validation.json
release/state-fault-live-20261028/validation.json
release/irq-acceptance-20261028/validation.json
release/irq-exception-regression-20261028-02/
release/irq-integration-20261028/integration.json
release/irq-delivery-20261028.json
```

## Still pending

GUI breakpoint ownership replacement remains untested. Retrying the installed
computer-use runtime on this turn, including reset/reinitialization, again
failed with `failed to write kernel assets: El sistema no puede encontrar la
ruta especificada. (os error 3)`. No GUI action occurred. This is an execution
environment failure, not evidence of correct or faulty PCSX2 GUI ownership.
Resume that gate when the runtime works.

Native in-progress load interruption/rollback, a hung core, arbitrary IOP
interrupt/device/branch semantics and physical PS2 validation remain unaccepted.
The next independent work after the GUI gate is bounded long-run/CI coverage,
then editor integration over supported capabilities. SMS playback stays in its
separate project backlog.
