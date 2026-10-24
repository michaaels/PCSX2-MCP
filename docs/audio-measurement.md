# Decoded audio measurement and acceptance gates

6B1 delivery, 2026-10-24. Requires rebuilding/restarting the TypeScript MCP
server; the accepted F5 native executable is sufficient. This delivers sample
measurements and defines the remaining acceptance gates. It does not add a
scenario audio assertion or declare SMS playback/audio fixed.

## Tool and capture recipe

`pcsx2_analyze_capture_audio` works offline, including before connecting to a VM.
It accepts one local SHA256-pinned MP4 with exactly one AAC stereo 48000 Hz audio
track and optionally one video track. First record with the existing
[owned capture tools](media-capture.md), wait for `state:closed` and
`artifact.verified:true`, then pass its path and SHA:

```json
{
  "capture_path": "D:/ps2/captures/owned-capture.mp4",
  "capture_sha256": "<64 lowercase hexadecimal characters from capture_status>",
  "output_directory": "D:/ps2/audio-evidence",
  "policy": {
    "window_ms": 20,
    "silence_rms_dbfs": -60,
    "near_full_scale_amplitude": 0.999
  }
}
```

The tool itself does not check a native operation or an ELF. Keep the original
capture status, process/session/epoch, ELF SHA, test stimulus and selected
interval beside the returned report when attributing it to an execution.
`source.vm_identity:not_observed_offline` preserves that distinction. File
hashes establish byte identity, not who generated the file or whether its
content is correct.

The output is a unique `pcsx2-audio-*` directory containing:

- `capture.mp4`: private snapshot checked against the supplied SHA.
- `audio.f32le`: interleaved channel 0/channel 1 float32 little-endian PCM at
  48000 Hz; no WAV header. The report records its byte count and SHA.
- `measurement.json`: source hash, decoder version strings, selected stream
  metadata, algorithm/policy hash, per-channel aggregates and window metrics.
  The response also supplies the saved JSON's path/SHA/byte count.
- `failure.json` on refusal after folder creation. A partial snapshot can remain;
  a failure folder is not an accepted measurement. Existing evidence is preserved.

Install standalone `ffmpeg` and `ffprobe` on PATH, or configure executable paths
with `PCSX2_FFMPEG` and `PCSX2_FFPROBE`. These are independent of the native DLLs
installed for F3. Validated here with both CLIs at 8.0.1. Version strings are
recorded, not a cryptographic attestation of those executables. No packages or
decoder dependencies were changed in this delivery.

## Measurement definitions

For each channel and window containing N decoded samples x:

| Metric | Definition |
|---|---|
| RMS | sqrt(sum(x²)/N), including DC |
| RMS dBFS | 20 log10(RMS), full-scale amplitude 1 |
| Peak | max(abs(x)); float overshoot above 1 is retained |
| DC offset | sum(x)/N; no high-pass filtering |
| Near-full-scale count | abs(x) >= configured amplitude, inclusive |
| Silent window | RMS <= 10^(silence_rms_dbfs/20), inclusive |
| Silent fraction | Frames in silent windows / all decoded frames, per channel |
| Longest silent run | Consecutive silent windows, weighted by actual frame count |

Digital zero has RMS/peak 0 and JSON `null` dBFS representing negative infinity.
Nonfinite PCM is refused. `exact_zero_samples` counts exact float zeros, not
samples below a threshold. Window origins are aligned to decoded sample zero;
the last partial window contributes only its real samples. There is no gain,
normalization, channel downmix or requested sample-rate conversion. Floating
point aggregation can differ at rounding precision when window sizes change.

Default 20 ms windows contain 960 samples per channel. Policy bounds are
10–1000 integer ms, -120 to -20 dBFS silence threshold and 0.5–1 inclusive
near-full-scale amplitude. These thresholds configure **measurements**, not
universal good/bad sound criteria. Stereo channels are evaluated independently.
A quiet channel, a legitimate pause or a sustained tone can be correct content.

Near-full-scale samples do not prove clipping/distortion. Low-RMS windows do
not prove a buffer underrun, packet loss or an emulator/SMS defect. AAC delay,
padding and energy spreading affect the decoded duration and gap boundaries.
Raw PCM output concatenates decoded samples; it does not establish timestamp
continuity or recover missing packet intervals. MP4 start/duration metadata is
kept separately and is not a measured A/V offset.

Results therefore retain `acceptance:not_evaluated`,
`audio_audibility:not_measured`, `av_sync:not_measured`,
`dropout_cause:not_determined` and `physical_ps2_validation:not_performed`.

## Bounds and failure behavior

At most 144 MiB compressed input and **480000 decoded stereo frames** (ten
seconds). Output exceeding 3840000 PCM bytes fails instead of publishing a
truncated success. Capture fewer than ten seconds to allow AAC padding; F3's
300-frame capture limit remains unchanged. Empty/incomplete PCM, different
sample rates, mono, extra streams and non-AAC audio fail explicitly.

One pipeline runs per MCP process; competing requests fail without spawning
another decoder. Every process has a 15-second runtime bound, stdout cap and
128 KiB stderr cap; the operation also has a cooperative 60-second deadline.
Regular-file reads are streamed/bounded and cancellation-aware. Blocking OS I/O
and an unresponsive OS are not a hard real-time guarantee.

External programs run without a shell, with hidden Windows subprocesses, local
MOV/MP4 demuxing, external data references/absolute aliases disabled and a
file/pipe-only protocol list. Decoder allocation/probe/output are bounded.
Decoding uses FFmpeg's `-xerror` to stop on reported errors; detected AAC damage
is refused instead of accepting a partially decoded sample set.
The original is checked while copying and reread before publishing; the
private decoder input is also rehashed. Refused/changed sources leave no
successful measurement JSON. A trusted caller/output directory is assumed;
these filesystem checks are not protection against a privileged process that
transiently replaces files and restores them between checks.

## Acceptance gates before sound assertions

| Gate | Required evidence | Current status |
|---|---|---|
| 6B1 instrument correctness | Known PCM levels/channels/DC/thresholds/gaps, real AAC pipeline, failure controls and native capture integration | Proven in the scope below |
| 6B2 emulator playback | Fresh recording of a known permitted clip actually played by SMS, exact build/boot/session and source interval, known expected sound/channel behavior, repeat measurements with justified per-content limits | Not accepted: 6B2a reaches the actual player but records zero PCM/stalled clocks; SIF2 wait observed. [Incident](sms-playback-audio.md) |
| Audible quality | Listening evidence for the exact capture and output route, content expectations and observed defects; quantitative levels alone cannot pass this gate | Pending |
| A/V timing | A source with known coincident visual/audio markers, verified video/audio timestamp alignment and an explicitly agreed offset/drift tolerance; include encoder/capture uncertainty | Pending; stream metadata alone is insufficient |
| Physical console | Independent acquisition/listening with console model, capture device, sample rate, interval and repeated playback/recovery evidence | Pending for this MCP delivery |

Before automating a content assertion, retain source/interval hashes, allowed
silent intervals and active channels, warm-up exclusions, level/gap budgets,
decoder settings, repetition count and failure evidence. Derive tolerances
from an accepted reference and repeated runs; do not silently promote the
measurement defaults to universal audio acceptance. Long-run/recovery, clock
calibration and physical intermittent audio remain separate work.

## Recorded validation

- TypeScript build and **208 Node tests** passed (15 new). The new tests verify
  zero, coherent 1 kHz tone, independent channels, DC, float overshoot, inclusive
  thresholds, aligned gaps/partial windows, invalid data, cancellation,
  source/output bounds and subprocess failure limits. No FFmpeg/BIOS is needed
  for this Node suite.
- **10 real AAC/MCP checks** passed without a VM. The host-generated one-second
  fixture has a 0.5-amplitude 1 kHz channel-0 tone, a known 200 ms gap and silent
  channel 1. AAC decoded to 48128 frames; channel 0 RMS was about -10.0127 dBFS,
  peak 0.54819 and the longest aligned silent run 180 ms. Channel 1 remained
  exact zero. This is host fixture evidence, not PS2 playback. Policy changes,
  source/PCM/report hashes, competing requests, actual source mutation, stale
  SHA, 44100 Hz refusal, damaged AAC and over-ten-second rejection were verified.
- **10 native media checks** passed, including the existing eight F3 capture
  regressions and two new analysis/refusal checks. A fresh SMS menu capture
  produced 60 video frames and 47104 decoded audio frames (0.981333 s). Both audio
  channels were exact zero; the analyzer accurately reports that observation,
  without diagnosing playback failure or claiming audible acceptance. Actual
  native video-only input was refused; VM running/paused state was preserved.
- Native/Bridge sources and accepted executable hashes are unchanged; those
  components were not rebuilt. There is no new hardware, A/V-sync, long-run or
  SMS playback-audio acceptance.

Local ignored evidence:

| Receipt | Path |
|---|---|
| Build/Node suite | `release/audio-node-tests-20261024.log` |
| Host AAC/protocol controls | `release/audio-fixtures-20261024-final/validation.json` |
| Fresh native capture/analysis/regressions | `release/audio-native-20261024-final/validation.json` |
| Tested file hashes/publication | `release/audio-acceptance-20261024.json` |

Reproduce from `pcsx2-mcp-server` with fresh output folders:

```text
npm test
node test/audio-live.mjs <new-output>
node test/media-live.mjs <PCSX2> <rendering-ELF> <configured-data-root> <new-output>
```

The initial host-fixture run stopped on an overly strict bitwise equality
check across window policies. The accepted harness uses a 1e-12 RMS tolerance
and still requires identical decoded PCM SHA; that earlier run is not counted
as accepted. Fixtures/evidence/binaries remain local, with no BIOS, credentials
or private media committed.
