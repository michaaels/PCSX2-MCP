# Application GUI control through MCP — U1

Latest additions: [managed window state/geometry](ui-window-management.md) and
[application-local asynchronous drag](ui-local-drag.md). These retain the seven-tool
catalog; the original U1 evidence below remains tied to its own executable.

Update U3a: managed top-level windows expose `window_state` and `set_geometry`,
with screen coordinates/bounds in snapshots. Real no-VM and paused-fixture
cases passed; minimized capture/input refuse. [Contract](ui-window-management.md).

Update 2026-11-03 / S4b2/U2: [real Qt source-step into/over/out replacement](source-step-qt-ownership.md)
is accepted under explicit bounded response latency. Native configuration changes
now reconcile paused Qt point tables, including deferral around active inline
editing. This closes those concrete cases; earlier pending statements below
record their historical scope, not a claim of universal GUI/backend coverage.

Update 2026-11-03 / S4b1: [actual Qt IOP in-flight ownership](iop-qt-ownership.md)
is now accepted for the IRQ-isolated fixture. The same delivery corrects native
cross-CPU breakpoint snapshot/ownership leakage. Seven new groups and 74 native
regressions passed; the source-step GUI replacement remains next. Earlier scope
statements below describe their original deliveries.

The modified PCSX2 **v2.9.147** frontend exposes seven additional MCP tools.
The Qt service starts inside the first-run wizard, before MainWindow or a VM
exists, and survives VM shutdown. Existing debugging tools retain their own
connection and semantics. This is application-local control; no Computer Use
connection or global Windows input is involved.

| Tool | Purpose |
|---|---|
| `pcsx2_ui_connect` | Connect to loopback UI port; optionally require the expected PID and data root |
| `pcsx2_ui_disconnect` | Close this UI connection without closing PCSX2 |
| `pcsx2_ui_status` | Inspect frontend service identity and features |
| `pcsx2_ui_snapshot` | List visible windows and inspect one window's controls, menus and bounded models |
| `pcsx2_ui_action` | Submit one action on an observed control; consumes its snapshot |
| `pcsx2_ui_action_status` | Read the originating connection's queued/running/completed/failed/expired receipt |
| `pcsx2_ui_screenshot` | Return a PNG of a known visible application window, dialog, menu or DisplaySurface |

## Build and connect

Use the [pinned native build](pcsx2-2.9-migration.md), applying the current
`tools/apply-debug-server.py` before compiling. The official unmodified emulator
does not have this service. The frontend now links **Qt6::Network**. On Windows,
install its matching DLL from the same dependency SDK:

```powershell
rtk proxy python tools/install-ui-runtime.py release/windows-mcp-2.9.147 release/windows-deps/deps/bin
```

The helper checks that the runtime and SDK `Qt6Core.dll` hashes match before
copying `Qt6Network.dll`, and refuses a conflicting existing DLL. Build Node with
`npm ci` / `npm run build` in `pcsx2-mcp-server`. Restart the modified emulator
and the MCP connection to load the executable and discover the new tool catalog.

The native service listens on **127.0.0.1:21513** by default. Set
`PCSX2_UI_PORT` in the emulator environment for another port, then pass that
port to `pcsx2_ui_connect` (or use the same variable in the MCP environment).
Assign a distinct UI port to each concurrent instance. It is independent of
`PCSX2_DEBUG_PORT` and PINE; deriving debug-port + 1 collided with sequential
Windows ephemeral PINE ports in a regression and was removed before delivery.
Binding failure is logged and does not advertise a usable UI endpoint.

Connect with the expected process identity, obtain a snapshot, choose a control
using its observed class/name/text and listed actions, then send one action:

```json
{"snapshot_id":"<snapshot UUID>","control_id":"c12","action":"set_text","text":"t0 == 0x42"}
```

Control IDs are opaque and valid only in that connection's current snapshot.
Never hardcode `c12` or reuse an earlier screenshot to invent a control ID.
Snapshot `window_id` selects a known window; the default root is the active
modal, popup or application window. Inspect `windows` when the desired dialog
is visible but not active. `truncated` means inspection reached a bound.

## Actions and result verification

Menus/actions use `trigger`; buttons use `click`. Fields support `set_text`;
buttons/groups `set_checked`; checkboxes `set_check_state` (0/1/2, partial only
on a tristate control); combos/tabs `select_index`; spins/sliders `set_value`.
Model items support `select`, `edit_text`, `expand`, `collapse` and context menus.
Each request must match the actions listed for that control. Popup actions and
dock tabs use local Qt mouse delivery to run their actual selection handlers.

Widgets support `focus`, one Qt `key` chord, `mouse`, `wheel` and `context_menu`.
Coordinates are **logical pixels local to the target**, not desktop coordinates
or necessarily PNG pixels. `mouse` sends local movement and a click, optionally
`double_click`; `button` is left/right/middle. Wheel takes local `x`/`y` and
integer `delta_y`, optional `delta_x`, each within ±1200. Key text is optional
and bounded; Meta chords are refused. Visible top-level controls support close.

Opening a blocking file dialog returns a **queued receipt** before entering
its nested Qt event loop. The opening action can remain `running` while new
snapshots and actions operate its dialog. `completed` means its Qt handler
returned; inspect the actual UI or native debugger state to verify the effect.
A timeout/disconnect is not rollback. Never blindly replay a mutation.

Destroyed, disabled, hidden, changed or stale controls refuse. Snapshots expire
after 120 seconds; one action consumes the current snapshot before dispatch.
Dispatch expires after four seconds at the client; native accepts deadlines no
more than five seconds ahead and converts them to a monotonic deadline. Each
peer retains at most 128 receipts, eight in flight. Text is limited to 16384
UTF-8 bytes; model/window traversal and transport buffers are bounded.

While UI clients are connected, the application requests Qt file dialogs so
they are inspectable. The original native-dialog preference returns on the last
disconnect. System/driver dialogs outside PCSX2 are not exposed. Password fields
are redacted and authentication-dialog input is refused.

## Rendered UI and capture

`DisplaySurface` represents the real QWindow used for Big Picture and rendering.
It offers local keyboard, mouse, wheel, focus and close actions. ImGui elements
are **not invented semantic widgets**: use its image and logical surface bounds
for visual navigation, then verify another capture.

Qt widget captures use `QWidget::grab`. DisplaySurface capture reads the actual
**D3D11 RGBA8/BGRA8 swapchain after ImGui and before Present** on the GS thread,
with a single queued expiring readback and the exact application window handle.
There is no desktop-region fallback. Backend/format support is explicit: other
renderers/HDR formats do not have an accepted readback backend and time out with
an error. The Qt thread remains available during the bounded capture wait.
Source images are limited to 16 megapixels, output to 2560×1600 and PNG to 4 MiB.
`capture_method` distinguishes widget rendering from D3D11 presentation.
Use existing `pcsx2_screenshot` for the guest framebuffer without application UI.

## Verified scope and evidence

Windows/local modified 2.9.147 acceptance comprises **15 actual MCP/GUI groups**
and **five first-run groups**, with both owned native and stdio processes closed:

- Main-window inspection/PNG before boot; disabled action and consumed-ID refusal.
- About modal, text/key readback, combo and toolbar slider changes/restoration.
- Blocking file picker, tree expand/collapse/select, actual owned-directory
  rename/restoration through its model, and boot of the exact fixture ELF.
- Debugger opening and dock-tab selection. Real condition, logging and max-hit
  edits preserve the original MCP marker; exact native cleanup preserves the
  edited point and refuses repeat removal, with both GPR/PC and sampled EE RAM
  unchanged. Checkbox state changes are read back and restored before applying.
- VM shutdown leaves the same frontend service available. Big Picture PNG was
  visually checked: landing page, F1 About and a mouse-opened Interface Settings
  page. Wheel delivery and out-of-bounds mouse refusal are checked separately;
  universal scrolling behavior is not inferred from receipt completion.
- First-run wizard without MainWindow: PNG, Next/Back, nested cancellation No,
  confirmed exit, cross-peer snapshot refusal and wrong-PID handshake rejection.

Local evidence, not committed binary/user data:

```text
release/application-ui-live-20261103-16/validation.json
release/application-ui-bootstrap-20261103-ports/validation.json
release/ui-control-node-tests-20261103-ports.log
release/ui-control-integration-20261103-ports/integration.json
release/ui-control-standalone-20261103-ports/validation.json
```

The final GUI binary also passed a 606.311-second duration run: 96
RAM/pixel probes, ten restore/ten reset recoveries and all 21 stdio children
plus the native process stopped. Native peak private memory was
1041.86 MiB with 651 handles; final private growth
91.00 MiB remained within the harness limits. Evidence:
`release/ui-control-soak-600-20261103-ports/validation.json`. This is a bounded
homebrew run, not a multi-hour or leak-freedom claim.

33 regenerated declarations differ only in object-property/literal-union order;
the prior source was rebuilt to its exact receipt hashes and the declaration
ASTs compared with only those two orderings normalized. Existing unrelated
JavaScript runtime modules remain unchanged.

302 Node tests passed. Native integration matches pristine/reapply/upgrade/build
across 35 managed files. Fifteen GUI groups include the three EE option edits;
they do not prove IOP in-flight ownership or source-step replacement. Those
remain next in [the plan](IMPLEMENTATION-PLAN.md). This does not claim that every
screen/control/renderer/platform has an individual acceptance test, nor cover
global OS dialogs, arbitrary scripts, drag-and-drop or physical PS2 debugging.
Failed pilot captures, the visual rejection of the desktop-region pilot and
the initial PINE collision remain separate from accepted evidence. SMS/Jellyfin
are not involved.

Repeat using new output directories:

```powershell
rtk proxy node pcsx2-mcp-server/test/application-ui-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-acceptance-20261024/render-fixture release/standalone-data release/ui-live-new
rtk proxy node pcsx2-mcp-server/test/application-ui-bootstrap-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/ui-wizard-new
```
