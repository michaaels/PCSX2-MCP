# Drag across controls in one application window — U4a

`pcsx2_ui_action` accepts optional `end_control_id` for a `drag`. It identifies
a destination **widget in the same fresh snapshot/window**. Start `x/y` belong
to the source widget; `end_x/end_y` belong to the destination. Without this
field, the existing same-control widget/DisplaySurface behavior is retained.
Duration remains 50–1000 ms. Each widget exposes `bounds_in_window`, in logical
Qt coordinates relative to the inspected root, to compose endpoints accurately.
These coordinates are distinct from managed top-level screen geometry and
physical PNG pixels/device pixel ratio.

```json
{
  "snapshot_id": "<fresh snapshot UUID>", "control_id": "c42",
  "action": "drag", "x": 2, "y": 150,
  "end_control_id": "c40", "end_x": 180, "end_y": 150,
  "duration_ms": 600
}
```

The native service advertises `qt_cross_control_drag`. The MCP client refuses
cross-control requests before dispatch if its native peer lacks this capability;
an older integration must not silently reinterpret destination coordinates as
source-local. Update/restart the modified PCSX2 process to expose the feature.
Normal same-control drag stays compatible with U3b's service.

Both targets must still match their observed snapshot and be visible/enabled
widgets in this root. Unknown IDs, model-item/action destinations, outside
destination points or paths outside the application window refuse. A target
destroyed, reparented out of the root, hidden/disabled or invalidated by layout
ends the gesture with a release to the surviving source. Disconnect/deadline,
modal guards, one active gesture and explicit receipts retain U3b semantics.

Interpolation uses stable root-window coordinates and maps each event into the
current source widget. This matters for splitter handles: the handle itself
moves during dragging. It avoids adding that movement again to each successive
point. The destination is resolved live, with local endpoint/window bounds
checked throughout the gesture. There is no global OS input or desktop target.

## Actual acceptance

Five new live groups use the real Qt file picker's narrow `QSplitterHandle`:
inspect its geometry, refuse unknown and out-of-destination endpoints without
movement, move it **60 logical Qt units** into its parent, then reverse and
restore its original position. Readback is x=122→182→122 in the retained run;
the width stays four units. Genuine before/after/restored PNGs were visually
reviewed, and the blocking picker exits under the same frontend identity.

The application suite additionally verifies real mid-gesture invalidation:
the Audio volume percentage label widens, narrowing its slider and invalidating
an edge endpoint. The receipt fails explicitly, the handle releases, and both
paused CPUs, sampled EE RAM and native identity remain unchanged. A subsequent
interior drag succeeds and its original value restores.

The final binary passed **57 live groups**: five cross-control, six local-drag,
four ImGui-drag, 18 application GUI, six window, five first-run wizard, seven
IOP and six source-into/Qt regressions. **303 Node tests** include a capability
compatibility test proving an old native peer receives no mutation and a capable
peer receives the exact destination fields once. Windows/TypeScript compilation
and pristine/reapply/upgrade/build integration across 36 managed files passed.
Core debug sources and runtime DLLs are unchanged. All owned native/stdio
processes closed. Publication/CI are recorded against the final commit SHA.

```text
release/cross-control-drag-20261103-03/validation.json
release/cross-drag-local-20261103/validation.json
release/cross-drag-imgui-20261103/validation.json
release/cross-drag-application-ui-20261103-02/validation.json
release/cross-drag-window-20261103/validation.json
release/cross-drag-wizard-20261103/validation.json
release/cross-drag-iop-qt-20261103/validation.json
release/cross-drag-source-into-20261103/validation.json
release/cross-drag-node-tests-20261103-02.log
release/cross-control-drag-integration-20261103/integration.json
```

```powershell
rtk proxy node pcsx2-mcp-server/test/ui-cross-drag-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-data release/cross-drag-new
```

This accepts the moving splitter interaction in one Qt window. Cross-window
docking, Qt/OLE native file drag-and-drop, arbitrary custom drag handlers and
other renderer capture backends remain separate work. Earlier duration runs
retain their own executable hashes. No SMS/Jellyfin or physical PS2 validation
is involved.
