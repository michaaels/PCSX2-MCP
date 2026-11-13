# Vulkan application presentation capture — U4d

`pcsx2_ui_screenshot` captures the current Vulkan DisplaySurface, including
ImGui, through the same seven GUI tools. It returns
`capture_method=vulkan_present_buffer_with_imgui`. Normal Qt rendering and
the D3D11/D3D12 paths remain available. No desktop pixels or global input are
used, and a paused guest uses the existing current-frame redraw without
resuming EE or IOP.

## Submission and limits

The swapchain requests `VK_IMAGE_USAGE_TRANSFER_SRC_BIT` only when the surface
supports it. Rendering remains available without that optional capability;
capture then returns an explicit error. Capture also requires an identity
surface transform and RGBA8/BGRA8 presentation. Rotation and other formats
are refused. Swapchain images are single-sampled by the pinned implementation.
The existing 16-megapixel source, 2560×1600 output, 4-MiB PNG and expiring
window-scoped request limits apply.

The GS thread records a download-texture copy after ImGui's render pass ends.
The pinned copy restores the source image layout and records a host-read
barrier. The normal presentation submission retains its image-available wait
and rendering-finished semaphore. Only after that submission and command-buffer
rotation does readback wait for the copy's previous fence and read mapped rows.
It does not force an intermediate submission without the acquisition semaphore.
BGRA rows are converted into owned RGBA pixels; Qt scales/encodes them.
No download buffer, copy or readback wait is added without a matching live
request. A failed submission is refused without attempting to read its fence.

This retains the [window-destruction cancellation](ui-capture-lifetime.md)
contract. Timeouts/cancellation do not preempt a hung GPU driver or recover a
hung emulator core. Non-Windows and additional GPUs are not validated here.

## Validation procedure

The renderer-aware Windows harnesses accept `vulkan`, in addition to the
existing Direct3D choices. They use real MCP stdio clients and private native
instances. The application suite independently checks a rendered guest
reference and unchanged paused CPU/RAM/identity. The ImGui suite checks
100%→158% volume by an actual gesture and independent Qt readback, then restores
100%. Close/recreation races use two connected MCP peers and a strict
1.5-second result deadline after the close race starts.

Presentation is verified before each close race: a visible startup QWindow
alone may be replaced while the GS renderer opens. This setup check occurs
before race timing. Audio restoration also uses a fresh snapshot after the
settings dialog settles. Stale-target refusals remain enabled. Failed pilots
are retained separately, including the intermediate-window close attempt and
a D3D12 restoration refused after its target changed.

The sustained harness accepts `ui-vulkan` and requires an explicit per-instance
`PCSX2_UI_PORT`. Every presentation is paired with an independent guest frame,
RAM counter and core-pixel progress; ImGui/OSD animation cannot satisfy guest
progress. Reset/restore and stdio replacement retain the frontend identity.
The paused negative control must fail with `counter unchanged`, despite
working presentation capture. Bounded duration/resources are recorded in the
delivery evidence; they do not establish multi-hour stability or leak freedom.

OpenGL remains an unsupported capture backend in this delivery and supplies
the genuine pending-request close control. Docking between windows and native
drag-and-drop are subsequent GUI work. SMS/Jellyfin and physical PS2 validation
are outside this acceptance.

## Actual Windows 2.9.147 acceptance

The final native SHA-256 is
`7c5ff85021ccfafe73b79be522e15c0e3ce1e390087cc27a611a6147c03604fa`.
**107 live groups** passed: 19 application groups on each of Vulkan/D3D11/D3D12,
four ImGui groups on each, four close/recreation groups on each plus OpenGL's
pending control, five cross-control drag, six local drag, six window and five
wizard groups. Vulkan's final six close races returned in 37–124 ms, including
three explicit window-destruction cancellations. This is a natural scheduling
race; it does not establish a forced GPU-copy-in-flight cancellation.
Retained Vulkan ImGui and paused guest presentation PNGs were visually checked.

The paired Vulkan run completed **93.266 seconds**, 16 guest/presentation probes,
two restores and one reset, and closed four stdio children and its native
process. Native peak private memory was **1208.07 MiB**, peak handles **722**,
and final private growth from its warmup baseline **0.90 MiB**, within the
existing budgets. Its paused negative control rejected `counter unchanged`
and closed. No new ten-minute or leak-freedom claim is made.

**303 local Node tests**, TypeScript/Windows compilation and integration across
**43 managed files** passed, including pristine/reapply, upgrade from U4c and
the actual build checkout. Runtime DLLs, Qt and core debug sources are unchanged.
The Node tool description identifies the new backend. The delivery receipt
records the published commit, remote SHA and actual Windows/Ubuntu CI logs.

```text
release/vulkan-ui-application-20261112/validation.json
release/vulkan-ui-imgui-vulkan-20261112-03/validation.json
release/vulkan-ui-lifetime-vulkan-20261112-02/validation.json
release/vulkan-ui-lifetime-opengl-20261112-02/validation.json
release/vulkan-ui-soak-90-20261112/validation.json
release/vulkan-ui-soak-stall-20261112/validation.json
release/vulkan-ui-node-tests-20261112.log
release/vulkan-ui-integration-20261112/integration.json
release/vulkan-ui-delivery-20261112.json
```
