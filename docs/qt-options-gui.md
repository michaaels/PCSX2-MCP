# Qt point-options ownership — S4b preparation

Update 2026-11-03 / S4b1: [actual Qt IOP in-flight ownership](iop-qt-ownership.md)
is now accepted for the IRQ-isolated fixture. The same delivery corrects native
cross-CPU breakpoint snapshot/ownership leakage. Seven new groups and 74 native
regressions passed; the source-step GUI replacement remains next. Earlier scope
statements below describe their original deliveries.

Update 2026-11-03: the three real EE option edits are now accepted through the
new [MCP Qt GUI service](application-ui.md), preserving the original marker and
cross-checking exact native point options, both CPU GPR/PC and sampled RAM.
Actor is `mcp_qt_ui`, not a person or Computer Use. Evidence:
`release/application-ui-live-20261103-16/validation.json`. IOP in-flight and
source-step cases remain open. The following records the earlier supervised
preparation and its external input limitation.

Prepared on Windows with modified PCSX2 v2.9.147. **Real Qt acceptance remains
pending.** The native Computer Use connection now lists windows and opens the
breakpoint editor. Its modal input still failed: current accessible controls
returned `element ... is not available in cached app state` or `coordinate
input geometry is unavailable`; coordinate clicks, focus navigation and an
accessible value edit produced no observed condition change. Reset/rebinding
did not establish a usable edit. The native process reported Responding=true.
This is an input-control limitation, not evidence of a PCSX2 deadlock.
The user chose another Computer Use restoration rather than manual edits.

## Supervised matrix

`test/gui-options-live.mjs` launches its own debugger, data root, port and MCP.
It checks the fixture manifest and current C/Makefile sources, stops genuine
homebrew execution at a source breakpoint, and first removes an unchanged
source group completely. Three fresh groups then isolate these Qt edits:

| Case | Required change | Required unchanged configuration |
|---|---|---|
| `condition` | `t0 == 0x42` | Original description, enabled/temporary/stepping and logging/hit options |
| `logging` | Log When Hit enabled, literal format `GUI-LOG-S4` | Original description, condition, hit limit, Continue on hit |
| `max_hits` | Max Hits = 2 | Original description, condition and logging options |

All point fields are compared by value, independently of JSON key order.
A qualifying real edit plus explicit actor attestation is required before
cleanup. Cleanup must report incomplete, preserve the exact edited point,
remove only other unchanged group points and refuse a second group removal.
Both CPU GPR/PC snapshots, paused status, native identity and a 256-byte EE RAM
sample must remain equal throughout. This is a sampled memory invariant, not
a claim that every RAM byte is compared. A native debugger PNG is retained
before cleanup; the input actor must independently establish the actual Qt edit.
Only after preservation proof does the harness explicitly remove its disposable
test point. It never clears all points or operates on another native instance.

Each case allows 20 minutes. Stop, expiry, machine movement, mismatched options
or missing actual GUI evidence cannot become a GUI pass. Owned native/MCP
closure is required. No emulator/Node production behavior changed here.

```powershell
rtk proxy node pcsx2-mcp-server/test/gui-options-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-acceptance-20261024/render-fixture release/standalone-data release/qt-options-new
```

Read `session.json` for the current `gui_case`, `gui_target` and full expected
point. Keep the VM paused. After the real Qt change, submit an attestation:

```powershell
rtk proxy python tools/control-qt-options.py release/qt-options-new verify --case condition --actor human --confirm-gui-edit
```

Use `--actor computer-use` only for an actual Computer Use edit, and the current
case for subsequent edits. The helper only writes a sequenced control file;
it never edits Qt or native points. To stop without acceptance:

```powershell
rtk proxy python tools/control-qt-options.py release/qt-options-new stop
```

## Verified preparation

Append `--preflight` to the harness command to run without GUI input. Five real
native/MCP checks passed: genuine source stop, unchanged-group removal, and
three negative controls that reject acceptance/cleanup when each required edit
is absent. The unchanged groups subsequently remove completely. Preflight
records `passed:true`, **`preflight:true`, `gui_accepted:false`**. Its synthetic
negative actor is accepted only in that mode and cannot attest to a GUI action.

Three helper checks also passed: missing attestation exits 2 without changing
the control file; preflight confirmation is refused; explicit stop exits the
harness with 1, GUI unaccepted and native/MCP stopped. The eight preparation
checks do not exercise the successful GUI preservation branch.

Ignored evidence:

- `release/qt-options-preflight-20261102-final/validation.json`
- `release/qt-options-helper-20261102.json`
- `release/qt-options-helper-20261102/validation.json`
- `release/qt-options-gui-availability-20261102.json`
- `release/qt-options-preparation-delivery-20261102.json`

Two earlier interactive attempts were explicitly stopped without acceptance;
their reports remain separate. A key-order comparison was corrected before
the final preflight. No production rebuild or repeated local 295-test run was
needed; hosted CI still runs the 295 Node tests and syntax-checks this harness.

S4b remains open for these three real Qt edits, IOP in-flight ownership and
source-step replacement. API conditions, preparation checks and screenshots
alone do not close it. SMS/Jellyfin, physical PS2 and synchronous loader
interruption/rollback remain outside this acceptance.
