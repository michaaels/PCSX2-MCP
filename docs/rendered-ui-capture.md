# D3D12 application presentation capture — U4b

`pcsx2_ui_screenshot` now captures a D3D12 DisplaySurface after ImGui renders
and before the current swapchain buffer is rotated/presented. It retains
D3D11 presentation capture and normal Qt widget rendering. `capture_method`
identifies the actual path that supplied the PNG:

| Source | Method |
|---|---|
| Qt window/dialog/menu | `qt_widget_render` |
| D3D11 presentation with ImGui | `d3d11_present_buffer_with_imgui` |
| D3D12 presentation with ImGui | `d3d12_present_buffer_with_imgui` |

There is no desktop fallback. Both Direct3D paths require single-sample
RGBA8/BGRA8 presentation and reject other formats before copying. The existing
16-megapixel source, 2560×1600 output, 4-MiB PNG, exact window-handle matching
and bounded asynchronous request limits remain. Unsupported surface backends
still return an explicit timeout; Qt widgets do not require a running VM.

D3D12 uses the pinned download-texture implementation on the GS thread. It
ends the render pass, copies the current presentation resource with state
restoration, submits/waits for its own fence, and copies mapped rows into the
owned RGBA frame. Qt only receives the result and encodes/scales it. No copy
or GPU wait occurs when there is no matching live capture request. A request
timeout is not GPU-driver preemption or hung-core recovery.

A paused guest may not present again by itself. The frontend now queues a
CPU-thread check and calls the existing `MTGS::PresentCurrentFrame` only while
the VM remains paused and the capture request remains live. This redraws the
existing GS texture without resuming EE/IOP or advancing a guest instruction.
Idle Big Picture and running VMs continue to present normally.

## Actual Windows 2.9.147 acceptance

**81 live groups** passed on the final executable: 19 application groups each
for explicit D3D12 and D3D11, four ImGui-drag groups each, five cross-control
drag, six local drag, six window, five first-run wizard, seven IOP and six
source-into/Qt regressions. The two renderer suites independently confirm a
nonblank guest texture, capture its paused presentation and require unchanged
both CPU GPR/PC, sampled EE RAM, paused status and native identity. The fixture
is allowed to submit its first display before stopping at its early tick.

Retained Big Picture PNGs show actual landing/settings/volume UI, including
100%→158% slider change confirmed independently in Qt and restored to 100.
Guest-reference and presentation images were visually inspected. A decoded PNG
or OSD alone is not evidence that the guest has drawn its first texture.

The extended sustained harness additionally uses `ui-d3d12`: it connects to an
explicit per-instance UI port, pins frontend PID/data root/service identity
across stdio replacement, and requires the D3D12 capture method in every
presentation probe. The final run completed **92.484 seconds**, 16 paired
guest/presentation probes, two restores and one reset, with four stdio children
and its native process closed. Native peak private memory was **1042.36 MiB**,
peak handles **628**, and private growth after the warmup baseline **9.50 MiB**,
within the existing budgets. The paused-guest negative control failed with
`counter unchanged` and closed, despite a working presentation capture path.
This is a bounded 90-second request, not a new ten-minute or leak-freedom claim.

**303 local Node tests**, TypeScript/Windows compilation and integration across
**38 managed files** passed. Integration covers pristine, reapply, upgrade from
U4a and the build checkout. DebugServer/core debug sources and runtime DLLs
remain unchanged; two integrated D3D12 files are added. CI/publication are
recorded against the published commit in the delivery receipt.

```text
release/d3d12-ui-application-20261112-04/validation.json
release/d3d12-ui-d3d11-regression-20261112-02/validation.json
release/d3d12-ui-imgui-final-20261112/validation.json
release/d3d12-ui-imgui-d3d11-20261112/validation.json
release/d3d12-ui-soak-present-90-20261112/validation.json
release/d3d12-ui-soak-present-stall-20261112/validation.json
release/d3d12-ui-node-tests-20261112.log
release/d3d12-ui-integration-final-20261112/integration.json
```

The initial paused-surface pilots timed out before the redraw change. A first
redraw build tried a private EmuThread slot and failed compilation; the final
implementation uses the public CPU/MTGS scheduling path. Earlier successful
screenshots before first-texture preparation and the non-presentation 90-second
pilot remain separate evidence, not the final paired-presentation acceptance.

Repeat with fresh output directories:

```powershell
rtk proxy node pcsx2-mcp-server/test/imgui-drag-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-data release/imgui-d3d12-new d3d12
rtk proxy node pcsx2-mcp-server/test/application-ui-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/standalone-acceptance-20261024/render-fixture release/standalone-data release/ui-d3d12-new d3d12
```

For sustained presentation probes, use a private configured root with the pinned
`EmuCore/GS Renderer=15`, set a free, distinct `PCSX2_UI_PORT`, and append
`ui-d3d12` to `test/soak-live.mjs` after its duration/optional `stall-control`.
The default harness mode remains guest-framebuffer-only for prior contracts.

Vulkan/OpenGL/Metal presentation capture, HDR, other hardware/driver combinations,
cross-window docking and native OS drag-and-drop remain separate work. No
Computer Use, SMS/Jellyfin or physical PS2 validation is involved.
