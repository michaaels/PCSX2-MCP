# Debugger panel docking through MCP — U5

The seven GUI tools now operate PCSX2 2.9.147's actual KDDockWidgets panels.
`pcsx2_ui_action` adds `set_floating` and `dock`; both require native feature
`qt_debugger_docking`. An older integration is refused before dispatch.
These are semantic controller operations on the Qt thread, without desktop
input, a simulated OS drag or an extra Computer Use connection.

## Inspect and operate

Debugger panel rows in `snapshot.controls` retain `kind=widget` and expose a
`dock` object. It includes `unique_name`, `title`, `group` (ordered member
names), `layout_locked`, `floating`, `in_main_window`, `in_floating_window`
and `has_previous_location`.

A snapshot also returns `dock_targets`, with `d0`-style IDs and `window_id`s
for actual panels across the application's visible top-level windows.
Noncurrent tabs can appear with `visible=false`; destinations must be visible
and enabled when the action executes. The target window must also be present,
unminimized and unblocked. There are at most 128 destinations; controls plus
destinations share `max_nodes`. Truncation is explicit. The existing
connection/snapshot scope, expiration and process/data-root identity apply.

| Action on an inspected panel control | Required fields | Effect |
|---|---|---|
| `set_floating` | `floating: true` | Detach this panel into its own Qt window. |
| `set_floating` | `floating: false` | Return a single detached panel to its remembered main-window location. |
| `dock` | `dock_target_id`, `dock_location` | Place this panel relative to another inspected panel. |

Locations are `tab`, `left`, `right`, `top` and `bottom`. The destination ID
must come from the **same snapshot's** `dock_targets`; source `control_id`
comes from its `controls`. Inspect the source window first, including when
the source is already in a floating window. The destination can belong to a
different application window. Normal local pointer drag retains its existing
same-window rules; this extension does not turn it into global OS input.

Unlock the debugger layout using its actual checkable Layout Locked button
before placement changes. The service enforces the lock rather than changing
it automatically. It also respects panel docking restrictions and affinities.
It validates both source and destination object/window state again immediately
before acting. A changed destination, destroyed source window, hidden control
or blocking modal produces an explicit refusal. A queued/failed operation
consumes its snapshot; inspect again rather than blindly retrying.

KDDockWidgets' `floating` means a panel has a window of its own. Two panels
tabbed/split in one floating window have `floating=false` but
`in_floating_window=true`. Use the latter and `in_main_window` to distinguish
that state. Returning a grouped floating panel to a main-window target uses
`dock`; the previous-location shortcut requires a single detached panel with
a remembered location.

The controller's resulting containing window and group relationship are
checked after placement. If it refuses or does not reach the requested
relationship, the receipt fails and instructs inspection. This is not an
automatic layout rollback. A successful receipt is still followed by a fresh
snapshot to verify geometry/grouping and obtain current handles.

## Actual Windows acceptance

`test/ui-docking-live.mjs` drives two real MCP stdio peers and a private native
instruction fixture. Setup waits for the ELF and replays boot to its known
ready breakpoint; the docking checks then require unchanged paused EE/IOP
registers/PC, sampled EE/IOP RAM, breakpoint lists, status and native identity.
It verifies lock refusal, actual detached PNG and previous-location return,
unknown/self destinations, all four nonoverlapping side placements and
restored group order, cross-window split and tab placement, changed destination
and retired source-window refusals, real blocking About dialog and restored
groups/lock. Split-floating and restored debugger PNGs were visually checked.

A separate controlled running round intentionally resumes the owned fixture.
It requires observed running state before/during/after detach/restore, advancing
EE cycles, unchanged native identity/epochs and return to a stable paused
state with the original breakpoint lists/groups/lock. It does not use exact
paused CPU/RAM equality across intentional guest execution. This round does
not replace the independent rendered guest progress requirements of sustained
validation.

The first native compile attempt exposed KDDockWidgets' `window()` hiding
QWidget's method; final code explicitly obtains the Qt window. Early live
setup attempts stopped before the ELF/at its unrelated entrypoint, and one
stale-window pilot had already consumed its peer snapshot. All failed pilots
are retained separately and excluded from final acceptance.

The local scope is the tested Windows 2.9.147 runtime and its shipped docking
dependency. It does not establish every custom layout, other platforms/GPUs,
native OS drag-and-drop, sidebar/MDI operation, physical PS2 validation or
SMS/Jellyfin behavior. Native application drag-and-drop is the next GUI stage.

## Delivery evidence

Final native SHA-256: `a842b001c3a4f50a97523e7045374cb06f54586637629e63d076b66eaa9ff062`.
**154 live groups** passed: 11 docking groups plus 130 GUI/renderer regressions,
seven IOP/Qt and six source-into/Qt groups. **305 local Node tests** and
TypeScript/Windows compilation passed. Integration across **46 managed files**
matches pristine/reapply, upgrade from U4e and the build checkout. DLLs, GS and
core debug sources remain unchanged.

The D3D12 paired guest/presentation run completed **93.408 seconds**,
16 probes, two restores and one reset, with four stdio children and its native
process closed. Native peak private memory was **1039.99 MiB**, peak handles
**622**, and final private growth from the warmup baseline **9.62 MiB**,
within existing budgets. Its paused negative control rejected `counter unchanged`
and closed. This bounded run does not establish new ten-minute/multi-hour or
leak-freedom acceptance. Docking's running round is separately identified above.

The delivery receipt records the commit, matching remote SHA, clean tree and
actual Windows/Ubuntu CI logs. Failed pilots are not counted in the 154 groups.

```text
release/docking-ui-live-20261112-06/validation.json
release/docking-ui-regression-20261112.json
release/docking-ui-soak-90-20261112/validation.json
release/docking-ui-soak-stall-20261112/validation.json
release/docking-ui-node-tests-20261112-02.log
release/docking-ui-integration-20261112/integration.json
release/docking-ui-delivery-20261112.json
```
