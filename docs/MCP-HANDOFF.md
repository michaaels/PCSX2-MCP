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
- Bounded repetition/source CI: [commands, evidence and T2 limits](stability-ci.md)
- Sustained rendered progress/resources/recovery: [T2 contract](sustained-validation.md)
- DAP protocol/native backend: [D1 contract](dap.md)
- Actual VS Code integration: [D2 acceptance and install/configuration](editor-integration.md)
- D2 evidence: ignored `release/editor-delivery-20261102.json`
- Savestate companion preflight: [F5a offline inspector](input-state-inspection.md)
- Actual state-start movies: [F5b save receipts/private copies/native outcomes](input-state-movies.md)
- F5b evidence: ignored `release/input-state-movies-delivery-20261102.json`
- Atomic conditions / CPU-selectable points: [S4a / pending S4b real Qt](conditional-points.md)
- S4a evidence: ignored `release/conditional-points-delivery-20261102.json`
- F5a evidence: ignored `release/input-state-delivery-20261102.json`
- D1 evidence: ignored `release/dap-delivery-20261101.json`
- Current delivery evidence: ignored `release/stability-ci-final-delivery-20261101.json`
- T2 duration/resources evidence: ignored `release/soak-delivery-20261101.json`
- In-flight GUI evidence: ignored `release/inflight-gui-delivery-20261030.json`
- S3 evidence: ignored `release/application-capture-delivery-20261029.json`
- Guided preparation evidence: ignored `release/guided-gui-delivery-20261029.json`
- M2 evidence: ignored `release/gs-replay-delivery-20261028.json`
- M1 evidence: ignored `release/v2.9.147-delivery-20261028.json`
- S2b2b evidence: ignored `release/irq-delivery-20261028.json`
- S2b2a evidence: ignored `release/state-load-delivery-20261027.json`
- S2b1 evidence: ignored `release/reconnect-delivery-20261027.json`
- S2a evidence: ignored `release/instruction-delivery-20261024.json`
- S1 evidence: ignored `release/standalone-delivery-20261024.json`

S4a rebuilds native/Node: six basic point tools now accept cpu=ee/iop; invalid
conditions fail before changing points/ownership. Native conditions require
`atomic_point_conditions`, with old-build refusal proved. 295 Node and 91 native
acceptance/compatibility groups passed; three old-bug groups stay separate.
Point lists expose supported condition/logging/max-hit metadata. Real Qt matrix
S4b still needs an available Computer Use connection (native pipe error 2 even
after reset); user chose reconnection. No new GUI action/acceptance occurred.

F5b enables `pcsx2_input_record` with `start:savestate` and replay with explicit
`state_path/state_sha256`. 289 Node/eight new native/MCP groups and eleven
power-on regressions passed, plus 60 standalone and six native DAP regressions
(85 native checks total). Native is rebuilt: restart the Node server and use
the modified pinned executable. Saves stay paused until finalized and verified;
replay hashes private copies before actual load. RAM/EOF/pads/invalidation and
save/load failures are tested; rollback and deterministic execution are not.
Next audit/extend remaining local GUI/IOP and loader/reset/BIOS coverage; physical
PS2 still requires its separate console/transport gate. Keep SMS separate.

F5a added offline `pcsx2_input_state_inspect` with SHA/pinned ZIP/payload CRC checks;
283 Node and five actual MCP checks on a genuine historical v2.9.147 state passed.
Native remained unchanged in F5a; no new emulator/state-load run was claimed by
that prerequisite. Its later F5b implementation/evidence is described above.

D2 accepts original stage 7 for the trusted Windows/EE fixture: installed VSIX,
actual VS Code 1.144.0 project config/mappings, source Continue/Step Over,
same-pause MCP/GPR/argument/RAM cross-checks and graceful detach. Four editor
groups, 278 Node and six repeated native DAP groups passed; adapter/editor exit
0 and owned roots stopped. Native remains unchanged. The user's global editor
profile is not configured by this delivery. Next: scoped savestate-start input
movies; physical PS2 remains a separate hardware gate.

D1 adds `node pcsx2-mcp-server/dist/dap.js` / `pcsx2-dap` as a separate stdio
protocol. 272 Node and six actual DAP/native/MCP groups passed, including source
next/out/into and frame-0 data cross-checks. It attaches to an existing VM,
preserves changed source-point owners and never kills that attached emulator.
Native and previous executable MCP JavaScript retain T2 hashes. A generated
`project-diagnostics.d.ts` has property-order-only emission changes; the
2026-11-02 audit reproduces its T2 hash when compiling without DAP and retains
both hashes/diff. See the DAP contract for this explicit declaration exception.
Two DAP processes/MCP/
native test process stopped. D1 originally left actual editor acceptance for
D2, which is now accepted above with its own installed-package/editor evidence.

T2 passed a 604.884-second duration run with 104 RAM/rendered-pixel probes,
521.908 seconds in running windows, ten restore/ten reset and twenty native
reconnect/stdio replacements while running. All 21 MCP children and the native
process stopped. 262 local Node tests passed; the actual paused-guest negative
control failed as expected and cleaned up. Process resource/periodic artifact
budgets held. Production native/Node hashes remain unchanged. This accepts a
supervised ten-minute fixture, not multi-hour/game/leak or hung-core recovery.
Next: original stage 7, DAP plus actual editor breakpoint/source/data acceptance.

T1 passed 100+500 repeated EE cycles, 600 native reconnects and 60 rounds of
timeout/foreign-breakpoint/stdio restart/actual MCP PNG capture. Both emulators
and all 62 stdio children stopped. The new local TypeScript/260 Node run passed;
native/dist/runtime hashes retain S3. Hosted CI tests Node 22 on Windows/Ubuntu,
without BIOS/native execution. These are 13.117/71.345-second repetition loops,
not prolonged soak/resource-leak acceptance. The later T2 acceptance is above.

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
