# Rendered capture window lifetime — U4c

A pending `pcsx2_ui_screenshot` now ends with
`Capture window was destroyed before readback completed` when its actual
DisplaySurface object is destroyed. It cancels the native request and keeps
the originating UI connection usable. It does not wait for the unsupported
backend timeout or substitute another window's pixels.

Each capture has a Qt-owned lifetime for its destruction subscription and
timeout. Completion, timeout and destruction share one completion guard; the
request's subscriptions/timer are disposed after finishing. A late queued
frame cannot write a second reply. The callback also replies with an explicit
failure if its QPointer is already gone, instead of silently discarding that
response. GPU work already executing is not preempted by this cancellation.

## Reproduction and actual acceptance

The prior U4b executable reproduced a **4499 ms** wait after an actual window
close. A separate baseline run recorded the misleading renderer-timeout error
after approximately 4502 ms while the frontend connection remained alive.
These are retained separately from accepted fixed-build results.

Two real MCP stdio peers now exercise six close/recreate races each with
D3D11 and D3D12. Valid captures that finish before close are accepted, both
original connections remain usable, closed-window capture under a fresh
snapshot refuses, and a recreated surface captures without reconnecting.

To exercise a genuinely pending request, a third run selects OpenGL, whose
presentation-capture backend remains unsupported. A live-window control first
confirms its normal bounded timeout. During six subsequent pending requests,
the other MCP peer destroys the surface after a deliberate 100 ms delay.
All six return the explicit destruction error in **155–166 ms from request
issuance**, including that delay, with both original connections still usable.
Recreation retains OpenGL's honest unsupported-capture contract. This accepts
pending-request cancellation; it does not implement OpenGL readback or claim
that a GPU-copy-in-flight race was forced by that control. No production delay,
fake event or test hook is used.

The new three-mode harness passes **12 live groups**. The final binary also
passes **81 GUI/debug regression groups**: 19 application groups and four ImGui
groups on each Direct3D backend, cross-control/local drag, window management,
first-run wizard, IOP and source-into/Qt ownership. Total: **93 groups**.
Owned native/stdio processes closed; original source INI and executable hashes
stay unchanged during each run.

The new binary repeated paired D3D12 guest/presentation resource probes for
**92.676 seconds**: 16 samples, two restores, one reset and four stdio children
closed. Peak native private memory **1037.41 MiB**, peak handles **624**, private
growth after warmup **8.51 MiB**, within existing budgets. The paused-guest
negative control fails on unchanged guest progress and closes. Earlier U4b
resource measurements remain associated with its earlier executable.

Windows compilation and pristine/reapply/upgrade/build integration across
**38 files** passed. Only the native executable and integrated Qt UI header
change among the 283 prior runtime entries; Node dist, DLLs and core debug/GS
sources are unchanged. The same source has **303 previously passed local Node
tests**; that local unit suite was not repeated for this native-only fix.
The final commit's actual Windows/Ubuntu CI logs are checked in its delivery
receipt, and CI syntax-checks the new live harness without launching PCSX2.

```text
release/capture-lifetime-baseline-20261112/validation.json
release/capture-lifetime-baseline-prompt-20261112/validation.json
release/capture-lifetime-d3d12-20261112/validation.json
release/capture-lifetime-d3d11-20261112/validation.json
release/capture-lifetime-pending-20261112/validation.json
release/capture-lifetime-soak-90-20261112/validation.json
release/capture-lifetime-soak-stall-20261112/validation.json
release/capture-lifetime-integration-20261112/integration.json
```

```powershell
rtk proxy node pcsx2-mcp-server/test/ui-capture-lifetime-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-data release/lifetime-new d3d12
```

Use a fresh output directory per run. `d3d11` repeats supported capture races;
`opengl` is the unsupported-backend pending-request control. Promptness numbers
describe these controlled local runs, not universal GPU/driver latency. Other
capture backends, cross-window docking and native file drag/drop remain work
to do. No SMS/Jellyfin, Computer Use or physical PS2 validation is involved.
