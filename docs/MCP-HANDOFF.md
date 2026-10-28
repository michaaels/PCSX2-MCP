# Context for a separate project-debugging chat

The MCP is maintained in `D:\dev\PCSX2-MCP`, fork
`https://github.com/michaaels/PCSX2-MCP`, branch `main`.

Local Windows components:

- Emulator: `D:\dev\PCSX2-MCP\release\windows\pcsx2-qt.exe`
- MCP entry: `D:\dev\PCSX2-MCP\pcsx2-mcp-server\dist\index.js`
- Independent test command: `tools/validate-standalone-mcp.py`
- Test contract and remaining limits: [standalone validation](standalone-validation.md)
- S2a contract: [bounded EE/IOP instruction control](instruction-control.md)
- S2b1 contract: [connection/reset/restore recovery](connection-recovery.md)
- Current delivery evidence: ignored `release/reconnect-delivery-20261027.json`
- S2a evidence: ignored `release/instruction-delivery-20261024.json`
- S1 evidence: ignored `release/standalone-delivery-20261024.json`

The current standalone suite passes 247 Node and 37 live checks. Connections
isolate old callbacks/queued commands, with actual reset/restore evidence. Step tools
accept CPU selection and bounded execution, returning structured/partial JSON.
The IOP instruction fixture isolates IRQ; arbitrary interrupt-active stepping
remains a separate gate. The standalone suite uses minimal homebrew programs. It covers launch, identity,
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
