# Visual regression with tolerances and regions: 6A

Implemented and validated on Windows on 2026-10-24. Rebuild the Node server with
`npm ci` / `npm test` and restart the MCP server/client to discover the new tool
and scenario schema. The previously validated F5 native build is sufficient;
no new native, Bridge or SMS behavior is introduced.

## Offline comparison

`pcsx2_compare_screenshots` works without an emulator connection:

```json
{
  "baseline_path": "D:/ps2/reference.png",
  "baseline_sha256": "<64 hexadecimal SHA256 characters>",
  "current_path": "D:/ps2/current.png",
  "current_sha256": "<64 hexadecimal SHA256 characters>",
  "output_directory": "D:/ps2/evidence",
  "policy": {
    "channel_tolerance": 3,
    "max_changed_fraction": 0.001,
    "regions": [
      {"name":"content","x":0,"y":32,"width":320,"height":180}
    ],
    "ignore_regions": [
      {"x":280,"y":32,"width":40,"height":12}
    ]
  }
}
```

Paths must be absolute local paths. Both file hashes are required. Stable reads
check descriptor/path identity, size and nanosecond modification/change times.
The report identifies input copies by SHA and includes the normalized policy
and its SHA; a later change of reference bytes cannot silently become a new
baseline. Inputs are never overwritten or automatically approved.

Valid pixel differences return a structured result with `passed:false` and
MCP `isError:true`, retaining evidence. Invalid hashes/formats/policies return
a tool error. Different dimensions are a failed comparison with both input
copies and their dimensions, without a fabricated diff or image resizing.

## Metric and policy

Pixels use their decoded opaque eight-bit RGB samples. For each unmasked pixel,
compute `max(abs(Ra-Rb), abs(Ga-Gb), abs(Ba-Bb))`. A pixel is over tolerance only
when that value is **strictly greater** than `channel_tolerance` (0–255).
A region passes when `pixels_over_tolerance / compared_pixels` is **less than
or equal to** `max_changed_fraction` (0–1); 0.001 means 0.1%. Verdicts use the
unrounded ratio. Both defaults are zero, giving exact decoded-pixel comparison.

- `regions`: zero to 16 named, nonoverlapping rectangles. An absent/empty array
  means the entire image. Each region can override the two thresholds.
- `ignore_regions`: zero to 16 rectangles; overlapping ignores form a union.
  Ignored pixels are removed from the denominator. Every selected region must
  retain at least one pixel; fully masked comparisons fail validation.
- Coordinates are integer absolute pixels, top-left origin, exclusive right/
  bottom edges. Out-of-bounds regions, duplicate names and overlapping selected
  regions are rejected rather than clipped or double counted.
- The report retains raw differing-pixel count, maximum channel delta and mean
  absolute RGB-channel delta, even if the configured thresholds allow the change.
  Coverage states selected/ignored/compared/outside-region pixel counts.

This is an explicit sample-distance metric. No perceptual/semantic/gameplay
judgment, antialias classification, alignment, gamma/profile conversion or
automatic tolerance learning occurs. Choose a reference and policy suitable
for the intended renderer, frame dimensions and game state. Hashes identify
files, not visual correctness or baseline build provenance.

## Scenario assertion with sampled build identity

`pcsx2_run_scenario` accepts the new `assert_screenshot` action:

```json
{
  "scenario": {
    "name": "screen-check",
    "steps": [{
      "action": "assert_screenshot",
      "width": 320,
      "height": 240,
      "baseline_path": "D:/ps2/reference.png",
      "baseline_sha256": "<64 hexadecimal SHA256 characters>",
      "expected_elf_sha256": "<SHA256 of the current local ELF>",
      "policy": {"channel_tolerance":3,"max_changed_fraction":0.001}
    }]
  },
  "output_directory": "D:/ps2/evidence"
}
```

The existing runner pauses the VM. The assertion checks the reference before
direct frame capture, verifies the running absolute local/HostFs ELF's file
SHA/CRC and rechecks the file after capture. It requires native process/session/
execution epoch and unchanged paused PC/cycles around the screenshot request.
The saved observation includes those fields and a host capture-time bracket.
The file SHA is not a cryptographic proof of all loaded guest memory.

A GS frame is a rendered observation, not an atomic CPU/game-state snapshot.
The reference remains caller selected: its build/renderer provenance is not
independently inferred from the PNG. `width`/`height` are native capture bounds;
capture can scale/crop according to the existing screenshot contract. Comparison
does no further resize; use matching capture bounds and actual dimensions.

If a visual assertion fails, its comparison result remains in the failed step,
later actions do not execute and the runner attempts its usual failure context.
The scenario stays paused when its identity is still valid. Epoch joins the
runner's process/session/ELF guards; a fresh identity check precedes failure
diagnostics, so detected reset/epoch changes skip diagnostics and final pause
against the changed VM. Legacy `screenshot.expected_sha256` continues comparing
encoded PNG bytes. [Scenario workflow](workflows.md).

## Evidence and bounds

Each comparison creates a unique `pcsx2-visual-*` directory:

| Artifact | Meaning |
|---|---|
| `baseline.png`, `current.png` | Exact copies of the selected/captured inputs, with SHA/byte counts. |
| `diff.png` | Red: pixels over channel tolerance; yellow: differing pixels within tolerance; dim gray: equal; dark blue: ignored; black: outside selected regions. Red pixels can still fit a region's fraction budget. |
| `comparison.json` | Dimensions, metric/policy/hash, region verdicts, coverage, input/diff hashes and sampled scenario observation or explicit offline identity absence. |

Only noninterlaced eight-bit RGB/RGBA PNGs with fully opaque decoded pixels are
supported, up to 1280x1024 and 6 MiB per file. CRC/chunk ordering/extents, APNG/
unsupported critical chunks and decompressed scanline bounds are checked before
the decoder. The codec is pinned [pngjs 7.0.0](https://github.com/pngjs/pngjs),
MIT; its package license and lockfile integrity are retained. Comparison yields
between row batches for cancellation. Sync decoding and outstanding file/native
I/O can outlast the cancellation instant; partial folders may remain. Prior
reports and source files are preserved. Local images can contain private game/
catalog content: the harness artifacts stay ignored and are not published.

## Acceptance

TypeScript compiled and **193 Node tests passed** (19 new). They cover decoded
RGB/RGBA equivalence, inclusive thresholds, region/mask coverage, format/CRC/
decompression limits, hash guards, cancellation and scenario failure/epoch guards.

**Ten checks with actual native SMS captures passed**, including two-region
exact match, channel tolerance, fraction boundary, ignored patch and unchanged
paused CPU state. A controlled 4x4 perturbation of a **reference PNG fixture**
caused exactly 16 over-tolerance pixels in one region, preserved diff/input
evidence and prevented the next frame-execution action. No guest code/data was
altered to cause a visual bug. A no-VM offline call compared equal RGB/RGBA
encodings and refused a stale reference hash. Seven existing workflow live
regressions also passed with private data/port and confirmed owned cleanup.

| Evidence | Ignored MCP-local path |
|---|---|
| Ten visual checks and reports | `release/visual-live-20261024-accepted/validation.json` |
| Seven workflow regressions | `release/visual-workflow-regression-20261024/results.json` |
| TypeScript/193-test output | `release/visual-node-tests-20261024.log` |
| Source/build/PNG/report hashes and publication | `release/visual-acceptance-20261024.json` |

Run the live harness from `pcsx2-mcp-server`:

```text
node test/visual-live.mjs <PCSX2> <project-manifest> <configured-data-root> <new-output>
```

The native executable/plugin retain the previous acceptance hashes, so Windows
native/Bridge builds were not repeated. This does not establish deterministic
game-state replay, A/V quality or physical-console behavior. Next is 6B:
define audio capture/measurement and acceptance criteria before automated audio
assertions. E11 and intermittent audio remain separate unresolved incidents.
