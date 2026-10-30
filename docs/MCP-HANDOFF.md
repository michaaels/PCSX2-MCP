# Context for a separate project-debugging chat

The MCP is maintained in `D:\dev\PCSX2-MCP`, fork
`https://github.com/michaaels/PCSX2-MCP`, branch `main`.

Local Windows components:

- Emulator: `D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe` (modified native build)
- MCP entry: `D:\dev\PCSX2-MCP\pcsx2-mcp-server\dist\index.js`
- Independent test command: `tools/validate-standalone-mcp.py`
- Test contract and remaining limits: [standalone validation](standalone-validation.md)
- S2a contract: [bounded EE/IOP instruction control](instruction-control.md)
- S2b1 contract: [connection/reset/restore recovery](connection-recovery.md)
- S2b2a contract: [actual state-load outcomes](state-load-outcomes.md)
- S2b2b contract: [IRQ pause and dispatched restore reconciliation](irq-pause-boundary.md)
- M1 contract: [pinned PCSX2 v2.9.147 migration](pcsx2-2.9-migration.md)
- M2 contract: [controlled D3D11 GS replay](gs-replay-validation.md)
- Guided GUI preparation: [operator steps and receipt semantics](gui-ownership-test.md)
- Application/debugger capture: [targets, rebuild/restart and limits](application-screenshots.md)
- In-flight EE GUI ownership: [supervised case and limits](inflight-gui-ownership.md)
- Current delivery evidence: ignored `release/inflight-gui-delivery-20261030.json`
- S3 evidence: ignored `release/application-capture-delivery-20261029.json`
- Guided preparation evidence: ignored `release/guided-gui-delivery-20261029.json`
- M2 evidence: ignored `release/gs-replay-delivery-20261028.json`
- M1 evidence: ignored `release/v2.9.147-delivery-20261028.json`
- S2b2b evidence: ignored `release/irq-delivery-20261028.json`
- S2b2a evidence: ignored `release/state-load-delivery-20261027.json`
- S2b1 evidence: ignored `release/reconnect-delivery-20261027.json`
- S2a evidence: ignored `release/instruction-delivery-20261024.json`
- S1 evidence: ignored `release/standalone-delivery-20261024.json`

S3 passes 260 Node, the same 60 standalone checks and seven
new application-window live checks; native integration now manages 29 files.
Use `pcsx2_application_screenshot` with `target: "debugger"` or `"main"` for
Qt application widgets, and `pcsx2_screenshot` for the rendered PS2 frame.
Restart the MCP Node server after updating and launch the rebuilt executable.
The following M1/M2 history records earlier scope:

The M1 standalone suite passed 255 Node and 60 live checks on PCSX2
v2.9.147, plus 53 extra source-step/IOP/input/capture/GS live regressions, with a
rebuilt native executable and 27-file integration. M2 adds 18 live checks:
continuous-drawing GS replay produces real PNGs on explicit Intel/NVIDIA D3D11
devices. The static no-transfer dump still needs software for a captured frame.
M2 leaves native and Node runtime unchanged. `release/windows/pcsx2-qt.exe` currently holds
the user's official executable without MCP extensions; use the modified path above.
A pending IOP hardware IRQ waits for resume after a
debugger stop; a dedicated fixture proves IRQ-enabled stepping and timed recovery.
Actual restore abort/lost-reply tests retain or reconcile completion without retry.
Guarded native state loads report the
actual result and retain the last receipt for status queries. PINE save/load
acknowledges only submission. Pre-dispatch cancellation sends no load; a native
load already dispatched cannot be cancelled. Earlier GUI attempts failed due
to computer-use native-pipe connection failure (error 2, including after reset).
The guided harness has five verified preparation/negative checks; it does not
claim an actual GUI edit. The subsequent S2b2c1 guided run did exercise the
operator-confirmed Qt description edit: five checks passed and its instance
stopped. Source-group cleanup preserves the changed point and refuses repeat
removal. S2b2c2 subsequently passed real Qt replacement during an EE `step_over`:
three checks, same paused VM and preserved `GUI-OWNED`; its owned process
stopped. A native application screenshot captured the visible point without
changing state. Native/Node runtime retains S3 hashes. Other GUI options,
IOP and source-step ownership remain outside those accepted cases.
See the guide above for scope and commands.
Connections
isolate old callbacks/queued commands, with actual reset/restore evidence. Step tools
accept CPU selection and bounded execution, returning structured/partial JSON.
The original instruction fixture isolates IRQ; the separate IRQ fixture exercises
its own enabled-IRQ worker/callback. Arbitrary interrupt/device/branch behavior
remains unaccepted. The standalone suite uses minimal homebrew programs. It covers launch, identity,
breakpoints, memory/register/source/argument reads, instruction control, real
screenshots/video and SIF observation guards without SMS/Jellyfin. It is not
proof that an arbitrary project or every PS2 instruction/device works.

For a project debugging session, provide the project root and its own AGENTS.md,
build command, exact unstripped debug ELF, matching sources and a reproducible
symptom. Preserve build/ELF SHA and source mappings. Keep project acceptance
separate from MCP tool acceptance; use source stepping for supported EE branch
semantics. Reconnect the MCP after updating the local executable/server.

If returning to the existing application, its context remains in
`D:\dev\PS2\ps2_multinet\docs\DEBUG-ROADMAP.md`, `DEBUGGING.md` and
`SIF-DIAGNOSTICS-2026-10-24.md`. The playback/audio gate remains failed. The Atom
with 1 GB RAM is user-provided context for possible video cuts, not an established
diagnosis. This standalone suite neither uses nor benchmarks that server.

Future MCP continuations should use `docs/IMPLEMENTATION-PLAN.md` and
`docs/development-status.md`, independently of that application backlog.
