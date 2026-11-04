# Real IOP Qt ownership and CPU-isolated points — S4b1

The MCP Qt service now verifies replacement of an IOP step-over breakpoint
through the actual debugger, without manual input or Computer Use. This also
exposed and fixed a pinned-upstream bug affecting every native point snapshot
that requested temporary points.

## CPU isolation correction

In upstream v2.9.147 `CBreakPoints::GetBreakpoints(cpu, true)` constructs a
CPU-filtered vector but returns the global vector when `includeTemp` is true.
An EE point therefore appeared in IOP lists and could falsely block an IOP
step whose target happened to have the same numeric address. Ownership guards
could likewise count a different CPU's point.

`DebugServer::Compat::GetBreakpoints` now filters the copied native result by
its actual CPU while preserving requested temporary points. All seven MCP
native list/ownership call sites use this adapter. The upstream GUI manager
and pinned revision remain unchanged. No JavaScript runtime change is needed.

The previous U1 executable was retained with its exact SHA. An actual baseline
run reproduced an EE point leaking into IOP's list; it is failed evidence,
not acceptance. New native cross-checks install coincident numeric addresses
in the other CPU and require successful execution on the intended CPU while
preserving the exact foreign point, in both directions.

## Actual Qt IOP case

`test/iop-inflight-qt-live.mjs` uses only its own hash-verified instruction
ELF/IRX, process, ports, INI and stdio MCP. It checks the retained fixture sources,
resident-module address report against debug IRX symbol relocation, PID/data
root and real native ELF. For this instruction-vector test the owned fixture
masks IOP IRQ; that scope is explicit and does not accept arbitrary IRQ-active
game execution.

Seven groups passed:

1. Resident IOP addresses and the exact quiet IRQ-isolation stop.
2. IOP listing and step-over ignore/preserve an EE point at the same return address.
3. EE listing and step-over ignore/preserve an IOP point at the same return address.
4. Unmodified nonreturning IOP call times out, pauses and cleans its own point.
5. Qt selects R3000 (IOP)/Breakpoints and prepares a real New Execute dialog
   without creating its point early.
6. A real MCP IOP step starts. The independent native event stream confirms
   resume, and Qt's live model shows the exact private `legacy-step` marker and
   target. While the step is still pending, the GUI applies `GUI-OWNED-IOP`.
   MCP refuses successful cleanup and preserves that permanent enabled IOP point,
   alongside an exact coincident EE control point, in the same paused VM.
7. The actual IOP view and PNG retain the point. Capture leaves both CPU GPR/PC,
   identity, sampled EE RAM and sampled IOP RAM unchanged after the operation.

Ordinary native queries serialize behind legacy step, so this harness does
not poll `list_breakpoints` during that command. Event long-polls and the
independent Qt service supply the in-flight evidence. Receipt completion alone
does not establish the GUI result. Actor is recorded as `mcp_qt_ui`.

The accepted operation returned after about 560 ms, with IOP spinning at
`0x000452b8` and the preserved point at `0x000452ac` in this retained build.
Addresses are derived at runtime; do not hardcode them for another fixture.
Both native and MCP child processes closed.

```text
release/iop-inflight-qt-20261103-04/validation.json
release/iop-inflight-qt-20261103-04/preserved-iop-point.png
release/iop-inflight-qt-baseline-20261103-02/validation.json
release/iop-cpu-filter-integration-20261103/integration.json
```

Previous pilots are preserved separately: an invalid JSON assumption for the
textual connect response, a native-query observation blocked by step's command
serialization, the actual cross-CPU list failure, and a backup launched outside
its DLL directory. None is counted as accepted GUI coverage.

Repeat with a new output directory:

```powershell
rtk proxy node pcsx2-mcp-server/test/iop-inflight-qt-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/instruction-fixture-20261024-final release/standalone-data release/iop-qt-new
```

The final binary passed 60 standalone, six DAP and eight state-movie regression
groups. Its bounded resource/recovery run passed 93.826 seconds with 15 RAM/pixel
probes, two restores, one reset and all four stdio children/native process closed.
Resource limits held. The prior U1 606-second result belongs to the previous
executable and is not silently attributed to this fix. Evidence:
`release/iop-cpu-filter-standalone-20261103/validation.json`,
`release/iop-cpu-filter-dap-20261103/validation.json`,
`release/iop-cpu-filter-state-movies-20261103/validation.json`, and
`release/iop-cpu-filter-soak-90-20261103/validation.json`. The 302 Node tests belong to unchanged Node sources/
runtime and are also checked by Windows/Ubuntu source CI. Source-step GUI
replacement, additional IRQ/device paths and physical hardware remain separate.
SMS/Jellyfin are not involved.
