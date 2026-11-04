# Application-local pointer drag — U3b

The existing `pcsx2_ui_action` tool accepts `action: drag` on a widget or
DisplaySurface that lists it in a fresh snapshot. Supply integer `x`, `y`,
`end_x`, `end_y` in that control's logical Qt coordinates, `duration_ms` from
50 to 1000, and optionally `button: left | right | middle` (default left).
Both endpoints must remain inside that same control. Model-item targets do
not acquire this action; inspect their actual view/viewport instead.

```json
{
  "snapshot_id": "<fresh snapshot UUID>", "control_id": "c42",
  "action": "drag", "x": 7, "y": 12,
  "end_x": 160, "end_y": 12, "duration_ms": 600
}
```

The GUI thread receives a local move, button press, timer-driven moves with
the button held, and release. It stays responsive during the gesture. The
receipt remains `running` until release; inspect the result after completion.
Qt sliders expose `slider_down` and `orientation` as useful readback. Another
UI mutation, including from a different connection, refuses during a drag;
snapshots, screenshots and receipt/status reads remain available.

Disconnecting the originating peer stops movement and releases the button to
the original live receiver. A deadline, destroyed target, hidden/disabled or
modal-blocked control, minimized window, or endpoint invalidated by resizing
also ends the gesture with an explicit failure. A destroyed receiver cannot
receive a release. The native service independently validates endpoint,
duration and remaining deadline before pressing. It never grabs the OS mouse,
moves the desktop pointer or replays a gesture after reconnect.

This supplies Qt-local pointer dragging. It does not implement OS/OLE file
drag-and-drop, cross-widget/window docking, or infer a custom control's visible
effect from successful event delivery. DisplaySurface accepts local events;
an ImGui drag interaction has not yet received its own visual acceptance test.
Keep endpoints away from edges when labels/layouts resize during interaction.

## Actual acceptance

Six new groups passed with the real Windows 2.9.147 executable and MCP stdio:

- Toolbar slider press/move/release changes its actual value; its handle is
  down while the receipt is running and released when completed.
- An endpoint outside the control refuses before changing/pressing the slider.
- A second peer inspects the held handle while its conflicting mutation refuses.
- Disconnect during the held gesture releases promptly, stops movement and
  does not replay on reconnect; a later gesture and semantic edits work.
- A raw native request with insufficient remaining deadline refuses before
  pressing, independently of the frontend schema.
- The original value restores, a genuine application PNG is captured, and the
  configured source INI/executable remain unchanged during the test.

The expanded application suite uses the real Audio Settings volume slider while
its homebrew VM is paused. During and after dragging/restoring the value, both
CPU GPR/PC, sampled EE RAM, paused status and native identity stay unchanged.
This is a controlled paused fixture, not a running-game/focus-policy guarantee.

The final binary passed **47 live groups**: six new drag, 17 application GUI,
six window, five first-run wizard, seven IOP and six source-into/Qt groups.
302 local Node tests and Windows/TypeScript compilation passed. Integration
matches pristine/reapply/upgrade/build across 36 managed native files. Core
debug sources and runtime DLLs are unchanged. CI is checked against the published
commit and retained in the delivery receipt; earlier duration reports retain
their original executable hashes.

```text
release/ui-drag-20261103/validation.json
release/drag-application-ui-20261103-06/validation.json
release/drag-window-20261103/validation.json
release/drag-wizard-20261103/validation.json
release/drag-iop-qt-20261103/validation.json
release/drag-source-into-20261103/validation.json
release/drag-node-tests-20261103.log
release/ui-drag-integration-20261103/integration.json
```

Earlier application pilots remain separate failures: an unavailable toolbar
after boot, transient layout/table snapshots, and an edge endpoint invalidated
when the volume label narrowed its slider. The final harness opens Audio
Settings, lets initialization settle and uses an interior endpoint. It does
not retry refused mutations. Application PNGs were visually inspected; owned
native/stdio processes closed. No Computer Use, SMS/Jellyfin or physical PS2
validation is involved.

```powershell
rtk proxy node pcsx2-mcp-server/test/ui-drag-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-data release/drag-new
```

Further GUI coverage can exercise ImGui drag, more screens and other capture
backends individually; universal GUI coverage is not established by these tests.
