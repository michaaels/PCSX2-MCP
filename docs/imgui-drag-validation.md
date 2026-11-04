# Big Picture / ImGui drag acceptance — U3c

The existing application-local drag action has now been exercised on the
actual Big Picture **Audio → Standard Volume** slider in modified Windows
PCSX2 v2.9.147. No native/server/runtime changes were needed after U3b.

The retained D3D11 presentation PNGs show the popup starting at **100%** and
ending at **158%**. After closing Big Picture, the independent Qt Audio Settings
widget reports **158**, then restores the original **100**. A changed PNG hash
alone is not the acceptance criterion. The source configured INI/executable
remain unchanged, the frontend identity stays the same, and no VM/DebugServer
starts. Both owned native and MCP stdio processes close.

Four live groups verify navigation/capture without VM, running/completed drag
receipts and changed presentation, independent Qt value readback, and exact
restoration/unchanged source files. Source Node/DLL/native runtime hashes match
U3b's receipt. Its 302 local Node tests/47 GUI groups remain attributable to
that identical runtime; only this new four-group harness was run locally here.
The published commit's Windows/Ubuntu CI is checked separately in its receipt.

```text
release/imgui-drag-20261103/validation.json
release/imgui-drag-20261103/dialog-before.png
release/imgui-drag-20261103/dialog-after.png
```

```powershell
rtk proxy node pcsx2-mcp-server/test/imgui-drag-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-data release/imgui-drag-new
```

The harness uses a private dark/default-start Big Picture configuration and
calibrated fractions of the logical DisplaySurface size, independent of PNG
device pixel ratio. It uses the existing MCP UI tools; it neither fabricates
semantic ImGui controls nor injects global OS input. Retained screenshots were
visually reviewed against the pinned upstream slider implementation.

The first calibration directory is named `imgui-drag-probe-20261103`; its
PowerShell probe environment assignment failed, so it executed the full
three-group pilot instead. The final harness removes that probe switch and
adds explicit absence-of-VM checks. Its accepted report is the fresh directory
above; the pilot is retained separately.

This accepts this slider interaction on the actual D3D11 RGBA8/BGRA8 UI path.
It does not establish arbitrary ImGui controls, all layouts/locales/renderers,
native OS drag-and-drop, cross-window docking or physical PS2 behavior.
SMS/Jellyfin remain separate. Further work can cover moving across control
boundaries/dock handles and other rendered-capture backends individually.
