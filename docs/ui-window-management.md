# Application window state and geometry — U3a

`pcsx2_ui_action` now supports two additional actions on managed top-level Qt
application windows. The seven-tool catalog remains unchanged.

- `window_state`, with `state: normal | minimized | maximized`.
- `set_geometry`, with `geometry: {x, y, width, height}` in logical Qt screen
  coordinates. Restore normal state first. The rectangle must fit within one
  available screen area and respect the window's own minimum/maximum size.

Snapshots expose `screens[].available_geometry`, device pixel ratio and each
managed window control's `geometry`, `window_state`, size bounds and
`can_minimize`/`can_maximize`. Coordinates may be negative for another monitor;
service bounds are ±32768 for x/y, width 160–4096 and height 120–2160. This is
Qt client geometry, not necessarily the PNG's pixel coordinate system.

Use a fresh snapshot and the control's listed actions, then poll the receipt
and inspect actual geometry/state. A completed receipt alone does not establish
the visible effect. The controller changes only windows in its own connected
PCSX2 process. It injects no global desktop input.

Normal/dialog/tool windows support management; popup/tooltip windows and embedded
DisplaySurface objects do not acquire these actions. Fullscreen stays under
the application's existing menu/renderer control: the generic state action
refuses to bypass that mode. Fixed-size dialogs still enforce their bounds.
Disabled or modal-blocked targets retain their prior refusal rules.

A minimized window remains inspectable/restorable by its known window ID.
Screenshot and child-control input refuse until restored; they cannot silently
type into a minimized application. Invalid/out-of-screen geometry refuses
before changing the window. UI lifetime and process identity remain independent
of VM boot/shutdown.

## Actual acceptance

Six new live groups passed before any VM/DebugServer started: geometry/screen
inspection and PNG, exact move/resize readback, off-screen refusal with unchanged
geometry, maximization and geometry-while-maximized refusal, minimization with
capture/input refusal and unchanged text, and exact original geometry restoration
under the same frontend identity. Both owned native and stdio processes closed;
the source INI/executable hashes stayed unchanged during the run.

The expanded application GUI suite also maximizes, restores, minimizes and
restores while its own fixture is paused, requiring unchanged native identity,
both CPU GPR/PC, paused status and sampled EE RAM after every transition. Its
private configuration has PauseOnFocusLoss=false; other user focus policies or
arbitrary running-game behavior are not inferred from this case.

The final build passed **40 live groups**: six window groups, 16 application GUI,
five first-run wizard, seven IOP and six source-into/Qt reconciliation regressions.
302 Node tests passed, including expanded window-input validation, and native
integration matches pristine/reapply/upgrade/build across 36 files. Existing
core/DLL source behavior remains unchanged; earlier duration/100-cycle reports
belong to their explicitly named executables, not a new duration run here.

```text
release/ui-window-20261103/validation.json
release/window-management-application-ui-20261103/validation.json
release/window-management-wizard-20261103/validation.json
release/window-management-iop-qt-20261103/validation.json
release/window-management-source-into-20261103/validation.json
release/window-node-tests-20261103.log
release/window-geometry-integration-20261103/integration.json
```

Repeat with a new output directory:

```powershell
rtk proxy node pcsx2-mcp-server/test/ui-window-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-data release/window-new
```

Native Windows compilation and TypeScript build passed on the unchanged PCSX2
v2.9.147 pin. Maximized/restored PNGs were visually inspected. The next GUI step
is bounded application-local drag. System dialogs, other rendered-capture
backends, every monitor/window combination and physical PS2 remain outside this
acceptance. SMS/Jellyfin are separate.
