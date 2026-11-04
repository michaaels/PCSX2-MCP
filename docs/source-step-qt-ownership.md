# Qt source-step ownership and live point-table synchronization — S4b2/U2

Real MCP source stepping in **into, over and out** now has explicit Qt ownership
acceptance. The same work fixes a reproduced frontend cache bug: after native
cleanup, the paused Qt table could retain a private marker that no longer
existed in the native breakpoint list.

## Real source-step matrix with explicit transport latency

`test/source-step-qt-live.mjs` launches its own process, ports, data root and MCP
with the retained hash-verified standalone C/DWARF ELF. A test-only transparent
relay first passes all native traffic unchanged: the normal source-step control
must complete (`source_changed` for into/over, `returned` for out), clean its
points and remain paused.

Qt then prepares a real New Execute dialog for the known first LUI successor,
without creating the EE point early. A coincident numeric-address IOP control
point stays isolated. The relay holds **one genuine `guarded_step` response**,
byte-for-byte, for at most a scheduled 700 ms. Native registers, memory, replies
and the emulator are not mocked, patched or suspended. The actual manual holds
were 65.077 / 66.912 / 75.766 ms for into / over / out.

The held native response identifies an active private operation. Independent
native events establish resume and the real successor breakpoint hit; the Qt
model shows that exact `MCP guarded step <operation_id>` marker. While the MCP
source call is still pending, its actual Qt dialog applies `GUI-SOURCE-OWNED`.
The coordinator then releases the original response bytes.

All three modes report `completed: false`, `reason: cleanup_incomplete`,
`cleanup_complete: false`, a paused matching EE VM and a trace tied to that
same native operation ID. The exact enabled permanent GUI EE point and
coincident IOP point remain. This accepts replacement under the recorded
bounded response latency; it does not claim a naturally timed race at every
instruction, arbitrary caller/inline frame behavior or rollback.

## Frontend synchronization fix

The prior binary's native point list was correct, but Qt retained both the
new GUI row and the obsolete private row. That discrepancy is preserved in
`release/source-step-qt-20261103-06/validation.json` and its PNG. Its ownership
assertions passed; its **Qt synchronization is not accepted**.

An optional frontend notification now runs after actual
`CBreakPoints::Update` configuration changes. Core code copies the registered
handler outside its mutex and only queues frontend work. Qt coalesces updates
for 25 ms and refreshes **existing attached breakpoint models**, without
constructing models or loading saved points. `refreshData` retains the upstream
CPU-read/UI-update dispatch. No guest resume, PC write or native point edit is
performed by the refresh.

An active inline editor defers its model's reset; retry after 100 ms reconciles
even when Escape cancels editing without a `dataChanged` event. The actual
`QExpandingLineEdit` was tested through its observed text/action capabilities,
not assumed to have the exact base-class name `QLineEdit`.

Six groups per mode passed: normal source control, genuine Qt preparation,
private-point replacement with native refusal/preservation, a deduplicated real
Qt view/PNG and unchanged final CPU/RAM inspection, native create/remove while
paused updating Qt, and preservation/reconciliation of an actual inline editor.
The final view has no obsolete private marker. Actor is `mcp_qt_ui`; Computer
Use and operator attestation are not involved.

## Validation and limits

The final binary passed 18 source/Qt groups, 15 application-GUI groups, five
first-run groups, seven IOP/CPU-isolation groups, 60 standalone regressions,
six DAP and eight state-movie groups. A separate repetition suite passed 100
EE instruction/JAL cycles, 100 socket replacements, ten timeout/foreign-point
controls and ten stdio/capture rounds; all owned processes closed.

Its bounded resource/recovery run passed **91.731 s**, with 16 RAM/pixel probes,
two restores, one reset and four stdio children plus its native process closed.
Limits held. This run is not U1's earlier ten-minute result. Native integration
matches pristine/reapply/upgrade/build across **36 managed files**. Node runtime
and DLLs remain unchanged; 302 source tests retain their previous local evidence
and are rechecked by Windows/Ubuntu CI.

```text
release/source-step-qt-into-20261103/validation.json
release/source-step-qt-over-20261103/validation.json
release/source-step-qt-out-20261103/validation.json
release/point-refresh-integration-20261103-02/integration.json
release/point-refresh-application-ui-20261103/validation.json
release/point-refresh-wizard-20261103/validation.json
release/point-refresh-iop-qt-20261103/validation.json
release/point-refresh-standalone-20261103/validation.json
release/point-refresh-dap-20261103/validation.json
release/point-refresh-state-movies-20261103/validation.json
release/point-refresh-stability-100-20261103/validation.json
release/point-refresh-soak-90-20261103/validation.json
```

Earlier pilot failures remain separate: widget/model-item name ambiguity, an
identity baseline taken before the normal control, startup pausing before ELF
load or hitting debugger startup's entry stop, and an exact-class predicate
missing the actual inline-editor subclass. No failed pilot is accepted as the
complete matrix. Fixtures, BIOS references and execution artifacts stay local.

Run from the repository root with a new output directory for each mode:

```powershell
rtk proxy node pcsx2-mcp-server/test/source-step-qt-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/dap-fixture-20261101 release/standalone-data release/source-qt-new into
```

Replace the final argument with `over` or `out` for those cases. The pin remains
PCSX2 v2.9.147. Broader screen/backend coverage, GUI drag/window geometry,
universal IOP loaders/IRQ stepping and physical PS2 remain explicit follow-ups.
SMS/Jellyfin are separate.
