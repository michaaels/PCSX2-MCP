# OpenGL application presentation capture — U4e

`pcsx2_ui_screenshot` now reads OpenGL's actual presentation framebuffer after
ImGui and before `SwapBuffers`, on the owning GS context. It returns
`capture_method=opengl_present_buffer_with_imgui`. The existing D3D11/D3D12,
[Vulkan](vulkan-ui-capture.md) and Qt widget capture paths remain available.
The same seven GUI tools inspect/control the application; capture uses no
desktop pixels or global OS input.

## Readback contract

The source must be a bounded default presentation framebuffer with normalized
8-bit RGB, optional 8-bit alpha, no stereo and no multisampling. Unsupported
formats or states return an explicit error. Window size comes from the current
GS surface; the existing 16-megapixel source, 2560×1600 output, 4-MiB PNG and
expiring window-scoped request limits apply. HDR/10-bit/stereo presentation
is not accepted by this path.

Readback selects the default framebuffer's back buffer when double-buffered,
or front buffer when single-buffered. It saves/restores the previous read FBO,
the default FBO's read-buffer selection, pixel-pack buffer binding, alignment,
row length, skipped rows/pixels and byte-swap state. Draw-FBO and cached draw
state are untouched. Client-memory `glReadPixels` supplies owned RGBA pixels;
rows are flipped to top-down order and output alpha is opaque. Qt scales and
encodes only that owned image. A pending GL error or a readback error is surfaced
explicitly. No buffer allocation or GL readback occurs without a matching live
request.

Paused captures retain current-frame redraw without resuming either guest CPU.
The [window lifetime contract](ui-capture-lifetime.md) still cancels a pending
capture on actual surface destruction and preserves the UI connection. A
timeout/cancellation cannot preempt a hung GL driver or recover a hung core.

## Validation procedure and scope

Renderer-aware live harnesses accept `opengl`. They verify actual ImGui volume
drag by independent Qt readback and restoration; paused guest capture against
an independent rendered reference and unchanged CPU/RAM/identity; and six
two-peer close/recreation races under the same strict 1.5-second deadline.
Each race establishes presentation before starting its timer. Original U4c/U4d
OpenGL unsupported-backend controls remain historical evidence tied to those
binaries. The current harness expects working capture on all four backends,
without forcing a request to remain pending or introducing a native test hook.

The sustained harness accepts `ui-opengl` and pins a per-instance frontend
identity across stdio replacement. Presentation probes alternate with actual
guest screenshot/RAM/core-pixel progress and reset/restore recovery. Its paused
negative control must reject `counter unchanged`; ImGui/OSD cannot stand in for
guest progress. This interleaves the existing OpenGL guest download path with
the new default-framebuffer capture.

Local acceptance applies to the tested Windows PCSX2 2.9.147 runtime/GPU.
Other GPUs/platforms and formats are unvalidated. Docking between windows and
native drag-and-drop remain subsequent GUI work. SMS/Jellyfin and physical PS2
validation are separate.

## Actual Windows 2.9.147 acceptance

Final native SHA-256: `d4a9b6963c98c61fce5a98d8721e48489ccdbde2bbae954fa98c0fb6efea7325`.
**130 live groups** passed: 19 application, four ImGui and four close/recreation
groups each on OpenGL/Vulkan/D3D11/D3D12; five cross-control drag, six local drag,
six window and five wizard groups. Actual OpenGL paused guest and ImGui PNGs
were visually checked. Both CPUs, sampled RAM, paused status and native identity
remained unchanged through paused GUI operations.

The paired OpenGL run completed **92.621 seconds**, 16 guest/presentation
probes, two restores and one reset. Four stdio children and the native process
closed. Native peak private memory was **1085.10 MiB**, peak handles **818**,
and final growth from its warmup baseline **10.30 MiB**, within existing
budgets. Its paused negative control rejected `counter unchanged` and closed.
These are bounded runs, without a new ten-minute or leak-freedom claim.

**303 local Node tests**, TypeScript/Windows compilation and integration across
**45 managed files** passed, including pristine/reapply, upgrade from U4d and
the actual build checkout. Runtime DLLs, Qt and core debug sources are unchanged.
The delivery receipt records the commit, remote SHA and actual Windows/Ubuntu
CI logs. No new failed native pilot preceded this final OpenGL build.

```text
release/opengl-ui-application-opengl-20261112/validation.json
release/opengl-ui-imgui-opengl-20261112/validation.json
release/opengl-ui-lifetime-opengl-20261112/validation.json
release/opengl-ui-soak-90-20261112/validation.json
release/opengl-ui-soak-stall-20261112/validation.json
release/opengl-ui-node-tests-20261112.log
release/opengl-ui-integration-20261112/integration.json
release/opengl-ui-delivery-20261112.json
```
