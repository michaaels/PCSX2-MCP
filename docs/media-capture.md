# Owned video/audio capture

F3 delivery, 2026-10-22. Requires the current TypeScript server and native PCSX2
v2.6.3 integration; restart/reconnect the MCP after rebuilding.

| Tool | Contract |
|---|---|
| `pcsx2_capture_start` | Queue a uniquely named MP4 with guarded VM identity, resolution, frame/time limits and encoded-payload budget. Optional audio; does not resume. |
| `pcsx2_capture_status` | Read/wait by ID after reconnect. Closed files are checked with ffprobe and hashed; open, failed and invalidated captures remain unverified. |
| `pcsx2_capture_stop` | Stop only this ID and await encoder finalization. Does not pause/resume or stop a GUI-owned capture. |

This adapts the capture idea reviewed from
[Ryubara commit 81708a0](https://github.com/Ryubara/PCSX2-MCP/commit/81708a0)
to our pinned backend, ownership and evidence contracts.

## Runtime setup

PCSX2's native recorder needs compatible FFmpeg DLLs, independently of the
ffprobe executable used by the Node verifier. Our build requires avcodec 62,
avformat 62, avutil 60, swscale 9 and swresample 6. The
[official PCSX2 setup guide](https://pcsx2.net/docs/setup/running/#downloading-and-running)
links its FFmpeg 8 package for this version range. Installing a standalone
ffmpeg/ffprobe executable does not supply these native DLLs automatically.

For the Windows build, from this repository:

```powershell
python tools/install-capture-runtime.py D:\path\to\pcsx2-directory
```

The helper downloads the official `ffmpeglibs-8.0.7z` asset, pins SHA256
`c4f8a5093997445fbb08c694be289b36eed660e46e02078d9371a2481453ae5a`, extracts only
the five required DLLs and verifies their exported ABI versions. It refuses a
bad archive or a different existing DLL before copying. Windows tar with 7z
support is required. Cache/provenance are kept under `release/capture-runtime-8.0`;
the helper does not change system PATH or publish binary dependencies.

Install ffprobe separately on the machine running the Node MCP server. The
verifier uses `ffprobe` from PATH, or `PCSX2_FFPROBE` as its executable override.
Capture start/stop do not require ffprobe; verification of a closed file does.
Missing/incompatible encoders and a missing verifier are explicit failures.

## Usage and bounds

Example start while a drawing program is already running:

```json
{"frames":120,"timeout_ms":15000,"width":640,"height":480,"audio":true,"max_payload_bytes":67108864}
```

Then query `pcsx2_capture_status`:

```json
{"operation_id":"<returned 32-character hex ID>","wait_ms":10000}
```

Bounds: 1–300 video frames; 100–30000 ms wall lifetime; width 64–1280 and height
64–1024, both multiples of eight; 1 KiB–128 MiB encoded packet payload. Defaults
are 120 frames, 15 seconds, 640×480, audio enabled and 64 MiB payload.

The payload ceiling counts compressed audio/video packets, **excluding MP4
container overhead**. It is not a hard final-file-size ceiling. Verification
allows at most the configured payload plus 16 MiB container allowance. Reaching
the payload ceiling fails the operation and leaves its partial file unverified.
Frame/time limits stop and finalize the recording; a file with no video frames
is failed rather than declared playable.

The file is `<instance-data-root>/mcp-media/<operation_id>.mp4`; existing files
are refused. Completed files survive subsequent recordings. Native report
retention is one operation until the next accepted start/server replacement.
Codec and bitrate preferences come from native capture settings. The per-request
audio flag and resolution do not modify persistent settings.

Starting while paused opens a recording without executing the game. Explicit
resume/frame advance is the caller's action. The native wall limit continues
while paused/disconnected. A status wait timeout/cancellation leaves recording
active until its native limit or an explicit stop. CPU/GS/encoder threads must
be responsive to finalize; an unconfirmed stop is never reported as completed.

## Ownership, identity and evidence

Native start guards PID, server session, execution epoch, ELF path and CRC.
Frame/payload hooks preserve native renderer object layouts. Encoding and file
closure are observed independently of finding a filename on disk. Stop checks
the exact filename under the encoder lock, then flushes packets/trailer and
closes the stream. Foreign IDs and competing starts preserve the retained owner.
ELF/VM reset and shutdown invalidate active recordings, including pending close.

Active states: `queued`, `recording`, `stopping`. Terminal states: `closed`,
`failed`, `invalidated`. A terminal file is not verified just because it exists.
For `closed`, the Node verifier checks actual MP4 video/audio tracks, resolution,
decoded video frame count against native delivery count, positive duration,
stereo 48000 Hz audio packets when requested, file size and SHA256. It rejects
changed files or changed operations during verification.

ffprobe runs without a shell, restricted to local MP4 input, bounded allocation,
output and 15-second runtime. The whole verification has a 30-second bound.
Results include stream timing and codec metadata, but retain
`audio_audibility: not_measured` and `av_sync: not_measured`. Audio packets can
contain silence; these checks do not establish audible playback, lip sync or
physical PS2 behavior. Save-state/module lifetime guards remain separate work.

6B1 adds the separate offline `pcsx2_analyze_capture_audio` tool. Pass the
closed capture's `path` and `artifact.sha256` to measure decoded PCM levels and
silence windows while preserving the source/PCM/report. This does not change
F3 verification or make a track audibly correct. See [audio measurements and
acceptance gates](audio-measurement.md) for definitions, bounds and remaining
SMS playback/listening/synchronization tests.

## Recorded validation

Windows PCSX2 v2.6.3, MSVC 19.51, Direct3D 11 and official FFmpeg 8 runtime:

- Native and TypeScript builds passed; 110 Node tests passed.
- 8 media live checks passed: exactly 60 H.264 frames with stereo AAC, paused
  behavior, ownership/reconnect and video-only frame cap, empty-recording expiry,
  payload rejection, explicit 10-frame stop, ELF reset and bounded retention.
- The positive MP4 was decoded with ffprobe: 320×240, 60 video frames, 46 audio
  frames at 48000 Hz stereo, 0.984318 seconds, 8061 bytes. An extracted video
  frame visibly contains the actual Jellyfin/SMS offline screen.
- All 8 GS dump live checks and 11 automation checks passed as regressions.
- Pristine, upgrade from `f779054`, reapplication and build checkout agree for
  20 integrated native files. No renderer/dump object size changes are needed.
- Runtime installation checked checksum refusal without target modification,
  refusal to overwrite a different existing DLL and idempotent repeat install.

The initial missing-runtime run failed explicitly; it is not an accepted capture.
The final accepted build/runtime and local receipts are:

| Evidence | Ignored local path |
|---|---|
| Media acceptance and MP4 files | `release/media-validation-20261022-accepted/validation.json` |
| Actual decoded video frame | `release/media-validation-20261022-accepted/captured-frame.png` |
| GS regression/replay | `release/media-gs-regression-20261022/validation.json` |
| Automation regression | `release/media-automation-regression-20261022/results.json` |
| Integration equality | `release/media-integration-20261022-accepted/integration.json` |
| Native binary/runtime hashes | `release/media-acceptance-20261022.json` |
| Installer negative/idempotence checks | `release/capture-installer-checks-20261022/validation.json` |

From `pcsx2-mcp-server`, use absolute paths and a fresh output:

```text
node test/media-live.mjs <PCSX2> <rendering-ELF> <configured-data-root> <new-output>
```

The live fixture waits for the reference SMS startup and uses isolated data and
owned processes. GUI-owned capture preservation, hardware encoders, actual
disk-full faults, long-run stability and non-Windows runtimes have no separate
live acceptance here. This adds no BIOS, media, credentials or binary release
to the public repository, and changes no Bridge/SMS decoder behavior.
