# Guided GUI breakpoint ownership test — S2b2c preparation

Prepared on 2026-10-29 for the modified PCSX2 v2.9.147. The guided harness
launches a private instance with `-debugger`, verifies PID/port/data root/ELF,
and pauses actual homebrew at its source breakpoint. It uses the existing MCP
and native protocol. It does not automate Qt or change an existing user instance.

**Stable source-group GUI acceptance passed on 2026-10-29.** The operator opened
the EE debugger, changed the description at `0x00100220` to `GUI-OWNED` and
explicitly confirmed the edit. Native cleanup preserved that exact point,
reported incomplete cleanup and refused a second removal without CPU movement.
All five checks in the guided run passed and its owned instance stopped.
Receipt: `release/gui-ownership-manual-20261029/validation.json`.
The prior five preparation/negative-control checks remain separate evidence.

## Run the preparation check

These absolute commands work from another directory. Use your own configured
data root/BIOS and a new output directory. Node dist and the pinned Python
source resolver must already be built/installed as described in
[standalone validation](standalone-validation.md).

```powershell
rtk proxy node "D:\dev\PCSX2-MCP\pcsx2-mcp-server\test\gui-ownership-live.mjs" "D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe" "D:\dev\PCSX2-MCP\release\standalone-acceptance-20261024\render-fixture" "D:\dev\PCSX2-MCP\release\standalone-data" "D:\dev\PCSX2-MCP\release\gui-preflight-new" --preflight
```

This checks real execution and complete removal of an unchanged source group,
then prepares a fresh group and closes its own process. `passed: true` refers
only to preparation; `preflight: true` and `gui_accepted: false` remain explicit.
No supervisor attestation can turn a preflight into a GUI acceptance run.

## Perform the manual GUI edit

1. Start the guided run without `--preflight`:

   ```powershell
   rtk proxy node "D:\dev\PCSX2-MCP\pcsx2-mcp-server\test\gui-ownership-live.mjs" "D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe" "D:\dev\PCSX2-MCP\release\standalone-acceptance-20261024\render-fixture" "D:\dev\PCSX2-MCP\release\standalone-data" "D:\dev\PCSX2-MCP\release\gui-guided-new"
   ```

2. Wait for `PHASE awaiting_gui_edit`. Read `session.json` in that output.
   It identifies `pid`, `data_directory`, `gui_target` and the current source
   group marker. The retained fixture's target is currently `0x00100220`, but
   always use the address from the new session. Do not resume/reset the VM.

3. In that instance's Qt debugger, select the EE breakpoints view. Edit the
   breakpoint at `gui_target`, whose description starts with `MCP source group`.
   Change only its **Description / Descripción** to **`GUI-OWNED`** and apply.
   Do not use an MCP command to make this edit. The VM stays paused while you
   work; there is no five-second editing race. The session allows 20 minutes.

4. After making the Qt edit, run this from a second terminal:

   ```powershell
   rtk proxy python "D:\dev\PCSX2-MCP\tools\control-gui-ownership.py" "D:\dev\PCSX2-MCP\release\gui-guided-new" verify --confirm-gui-edit
   ```

   The explicit flag is your attestation that the change was made in Qt.
   The helper only writes a sequenced local control file; it never edits a
   breakpoint. Without the flag it refuses. A confirmation with no actual
   observed `GUI-OWNED` point remains unaccepted and triggers no group cleanup.
   You may correct the GUI edit and submit another verify command.

5. An accepted result requires both the operator attestation and native evidence:
   the same paused CPU/VM identity, the changed point preserved unchanged in
   the native list, incomplete MCP cleanup with the exact preserved address,
   only unchanged owned points removed, and a second removal refused without
   erasing the GUI point. It records `gui_accepted: true` and
   `operator_confirmed_gui_edit: true`, then stops only its owned process.

To stop a waiting run without acceptance:

```powershell
rtk proxy python "D:\dev\PCSX2-MCP\tools\control-gui-ownership.py" "D:\dev\PCSX2-MCP\release\gui-guided-new" stop
```

Stop/expiry without a verified GUI edit returns `passed: false`,
`gui_accepted: false` and a nonzero exit. No clear-all-breakpoints fallback is
used. A failed connection, changed identity, CPU movement, wrong point or cleanup
failure cannot satisfy acceptance. Inputs, hashes and private reports stay local.

## Evidence and scope

The final preparation run passed three actual setup/control checks and two
negative checks: an attested control command without a GUI replacement caused
no cleanup, and the unexercised run stopped its owned emulator with exit 1.
The helper's missing-attestation refusal was also exercised. Both final owned
instances stopped. Native executable, integrated source, Node dist and runtime
DLLs retain their M1/M2 hashes; no runtime rebuild or full suite rerun was needed.

An earlier preflight failed because the harness tried to parse the human-readable
`pcsx2_connect` response as JSON. That response is now checked as a connection
result; its failed receipt is retained and is not accepted.

The Windows computer-use module now imports, but listing windows fails with
`Computer Use native pipe is unavailable: failed to connect native pipe: El
sistema no puede encontrar el archivo especificado. (os error 2)`. Reset and
reinitialization produced the same result. No automated GUI input occurred.

This stable source-group scenario does not test replacement during the bounded
step's private-breakpoint lifetime, conditional/logging/max-hit GUI options,
IOP GUI ownership, or native savestate interruption/rollback. Those remain
separate acceptance work. SMS/Jellyfin and physical PS2 are not involved.

Ignored evidence:

```text
release/gui-ownership-preflight-20261029/validation.json       # failed harness baseline
release/guided-gui-preparation-20261029-final/validation.json   # five preparation checks
release/guided-gui-preparation-20261029-final/preflight/validation.json
release/guided-gui-preparation-20261029-final/unconfirmed-negative/validation.json
release/guided-gui-delivery-20261029.json
```
