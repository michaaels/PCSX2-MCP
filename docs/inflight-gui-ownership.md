# In-flight EE step ownership — S2b2c2

Accepted on Windows with modified PCSX2 v2.9.147 on 2026-10-30. The real Qt
breakpoint dialog replaced the private target of an executing MCP EE
`pcsx2_step_over`. The MCP returned `completed: false` and
`Step breakpoint changed ownership; preserved, cleanup unconfirmed`.
It preserved the enabled `GUI-OWNED` breakpoint at `0x00100364`, with the same
process, session and execution epoch, and left the VM paused at `0x00100370`.
No runtime change was required.

## Reproduce the supervised test

Build the Node server and the standalone instruction fixture first; use a
configured local data root with your own BIOS as described in
[standalone validation](standalone-validation.md). Use a new output directory.

```powershell
rtk proxy node "D:\dev\PCSX2-MCP\pcsx2-mcp-server\test\inflight-gui-live.mjs" "D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe" "D:\dev\PCSX2-MCP\release\instruction-fixture-20261024-final" "D:\dev\PCSX2-MCP\release\standalone-data" "D:\dev\PCSX2-MCP\release\inflight-gui-new"
```

The harness launches only its own private `-debugger` instance and checks its
PID, debug port, data root and hash-verified fixture. A 100 ms unchanged-target
control must time out, remove its own breakpoint and leave the VM paused.
It then waits up to 20 minutes. Read `session.json` for the current `target`
and `step_pc`; do not copy addresses from a different build.

1. In that instance's EE **Breakpoints** view, right-click the empty table,
   choose **New**, select **Execute**, enter the session's `target` and
   description `GUI-OWNED`. Keep Enable selected, Max Hits at None, condition
   empty and logging disabled. Leave the dialog open without applying it.
2. Edit the output's `control.json` to
   `{"sequence":1,"action":"start","delay_ms":15000}`. The harness publishes
   `countdown`, then `running_step`. During the countdown no breakpoint may
   exist. During `running_step`, the real MCP step owns the private return
   breakpoint for at most five seconds while the fixture spins in a call that
   never returns. Apply **OK** within that window.
3. Require `awaiting_human_confirmation` in `session.json`. This phase requires
   the native ownership error, preserved point, paused VM and unchanged
   process/session/execution epoch. An early or missed edit is not acceptance.
4. Only after the actual Qt action, write
   `{"sequence":2,"action":"confirm","actor":"human"}`. A supervisor using
   Windows Computer Use instead records `actor: "computer-use"`. Attestation
   does not substitute for the native assertions. The harness rechecks the
   preserved point, records `accepted` / `passed: true`, and stops its process.

Each new control command needs a higher integer sequence. To stop a waiting
run, write `{"sequence":3,"action":"stop"}`. Stop, expiry and a missed edit
exit unsuccessfully; `passed` may remain `null`, which is not acceptance.
If a point was created too early or late, preserve that attempt and restart
with a new output rather than clearing unrelated breakpoints. Do not reset,
resume or close the emulator during the test.

## Evidence and limits

The accepted run used Windows Computer Use for the actual Qt input. The
prepared dialog was applied after the running debugger displayed the private
`legacy-step:2` marker. The MCP returned after about 4434 ms with the ownership
error; the native point remained enabled, non-temporary and non-stepping.
Three harness checks passed: unchanged-target cleanup control, native
ownership preservation, and explicit actor confirmation. The owned emulator
stopped and the harness exited 0.

A separate capture using the existing `DebugServerClient` application-capture
API saved a real 1920×1178 debugger PNG showing `GUI-OWNED`. Paused status,
cycles, PC, native identity and breakpoint list matched before and after that
capture. It was visually inspected. This is native protocol capture; the
previous S3 suite separately tested the MCP stdio image envelope.

```text
release/inflight-gui-live-20261030-02/validation.json
release/inflight-gui-live-20261030-02/capture.json
release/inflight-gui-live-20261030-02/debugger.png
release/inflight-gui-delivery-20261030.json
```

The preceding attempt `release/inflight-gui-live-20261030/validation.json`
was stopped after the operator interrupted Computer Use, with no GUI
acceptance. It remains excluded. The accepted harness received only a usage
comment correction after execution; its executable statements were unchanged.

Native executable, 29 integrated native sources, Node dist and runtime DLLs
are checked against S3 hashes. The historical 260 Node / 60 standalone / seven
application checks are not new runs in this test-only delivery. No new build
was needed. No SMS, Jellyfin or physical PS2 participated.

This accepts one EE instruction `step_over` description-replacement case,
alongside the separately accepted [paused source-group GUI edit](gui-ownership-test.md).
It does not accept all GUI options: condition, logging, max-hit changes, IOP
ownership, source-step replacement, every branch/device combination and native
savestate interruption/rollback remain outside these runs. Stability/CI work
can now use these two explicit GUI cases without claiming that broader matrix.
