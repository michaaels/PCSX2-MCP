# SMS playback audio: measured failure and SIF2 wait evidence

6B2a, 2026-10-24. The live recipe now drives the actual SMS menu, prepares a
known clip through UDPFS/Bridge/Jellyfin and captures its PCM. **Playback audio
is not accepted:** the measured attempt stalls and remains a failing test.
The separate evidence verifier accepts only the integrity of that incident.

This delivery adds test/diagnostic recipes using the existing MCP tools, not a
new runtime tool or a general sound-quality assertion. Native PCSX2, Bridge,
SMS and decoders are unchanged. The accepted F5 Windows executable is reused.

## Observed result

The external Linux Jellyfin 12.2.0 was reachable directly using the existing
dedicated nonadministrator credentials. They remain in the project's ignored
`.env`. The test owns its fresh Bridge/cache, UDPFS and emulator; it preserves
the external Jellyfin and other emulator instances.

The user reports an Atom server with 1 GB RAM. The inspected Bridge downloads
original bytes using `Static=true` and runs FFmpeg on the separate PC before
publishing for UDPFS. These runs use one short clip/request at a time. No
server CPU/RAM measurements were collected; this incident is not attributed
to the Atom's capacity. Future checks must preserve this deployment constraint
and avoid assuming server-side transcoding or heavy background extraction.

The retained build is `7a4a8cee9f5f9008`, ELF SHA256
`6d6e7f689ab82c1c1109c29be5ba0bb5f38f897a774b17fe612dd1c1e911b321`,
CRC `0xbbb5a5ee`. The known eight-second synthetic MPG has SHA256
`45e37deb7e198e212f9ed8289eac64ca2a1c97d3cded57fae94b88385382dd8d`.
Its decoded stereo reference has a dominant 440 Hz tone, about 0.0621 RMS
amplitude in both channels. The actual file published by this run's Bridge is
checked against that complete-file hash before capture.

The measured run reaches the real player entry, and then all four source
milestones: player-control initialization, queue fill call, `StopSync(1)` and
the first player input loop. An actual `player_enter` event joins console and
persisted Bridge fields by build/boot/session/sequence. These observations
prove entry and control flow, not successful playback.

Two separate closed 180-frame native MP4 recordings contain digital-zero PCM
in both channels. Between recordings, the VM runs for an additional five wall
seconds. Three paused DWARF-backed samples show nonzero audio/video clocks
that stop changing, while CPU cycle observations differ. The final screenshot
shows a frame of the synthetic clip. There is no accepted return-to-catalog or
audible result.
Exact counts and raw clock values belong to the local receipts, not constants
used by the live driver.

A separate boot traces the first `SPU_PlayPCM` SIF2 header acknowledgment:

| Evidence | Meaning |
|---|---|
| `SMS_SPU.c:194` reached in this build | Before the first `WaitSema(s_SemaPCM)` after sending the SIF2 header |
| Runtime LW effective address | Matches the hash-checked DWARF address of `s_SemaPCM` |
| Runtime JAL target | Matches the retained ELF's `WaitSema` symbol |
| Following source marker | Four bytes after JAL + 8, with one verified intervening LUI; not the exact return PC |
| Following marker times out after 10000 ms | That continuation was not observed within the bounded interval |

For this build the wait is at `0x00134518`, JAL at `0x0013451c`,
`WaitSema` at `0x00190d80`, return site `0x00134524`, following marker
`0x00134528`, semaphore object
`0x002b9820`. The script derives these from the selected artifact and actual
instructions; it does not hardcode them for another build. The evidence
narrows the observed EE progress boundary around the first header wait. It
does not observe execution at the exact return PC or prove which IOP/interrupt/emulator
component failed to deliver the acknowledgment or that this explains physical
intermittent audio or the separate E11 updater issue.

## Recipe inputs and bounds

`test/project-transport-live.mjs` retains its ordinary transport mode. When
`PCSX2_AUDIO_FIXTURE` is set to an absolute local JSON filename, it invokes
`test/project-playback-audio.mjs` after ordinary fresh transport validation.
The service owner must also set `PCSX2_AUDIO_PUBLISHED_DIRECTORY` to its exact
fresh published directory. Example fixture (replace placeholders locally):

```json
{
  "library_id": "<32 lowercase hexadecimal characters>",
  "item_id": "<32 lowercase hexadecimal characters>",
  "reference_path": "D:/project/artifacts/known-tone.mpg",
  "reference_sha256": "<64 lowercase hexadecimal characters>",
  "repetitions": 2,
  "capture_frames": 180,
  "input_frames": 12,
  "trace_sif2": false
}
```

The reference is an authorized known MPEG clip with exactly one stereo 48000
Hz audio track, at most 16 MiB and ten decoded seconds. This particular recipe
requires a sustained narrowband tone in both channels. Other content needs
its own criteria; it must not be silently treated as this fixture.

The driver resolves nine menu statics from a fixed DWARF CU profile and checks
their symbol addresses, types, writable ranges and ELF SHA. It navigates with
controller input, verifies the selected library/item IDs before CROSS and
never writes guest data/registers or assigns a PC. The known item must be on
the current page; unsupported/ambiguous metadata or a missing ID fails.
Buttons are held and released for 6–30 VSync intervals (default 12), not assumed
to be consumed just because a frame operation completed.

Repetitions are 1–3, captures 60–240 frames; existing native wall/byte/ownership
bounds remain. There is a bounded readiness loop and ten-second milestone
waits. The first missing milestone or missing tone stops the run with JSON,
CPU/thread/context evidence and a PNG where available. Owned breakpoint groups
are removed and the owner stops its emulator/services. A failed cleanup is
explicit. Unsupported metadata does not fall back to guessed struct offsets.

The twelve selected player members use direct CU static location, verified
DWARF structure/member types and extents, and symbol/segment agreement.
Only constant/legacy GCC `DW_OP_constu`/`DW_OP_plus_uconst` member offsets are
supported. Signed 64-bit clocks remain decimal strings alongside raw RAM.
These are fixture helpers, not a new general global-variable MCP API.

For tone presence, the helper searches 100–2000 Hz on a short 4096-sample
overlapping coarse window, then refines in 1 Hz increments using up to one
second of decoded PCM. A known-frequency projection is checked after an
explicit one-second decoded warmup. The content-specific exploratory gate is
projected tone power >= 0.5 of AC power and RMS >= reference RMS / 100 in both
channels. It is a tone-presence gate, not accepted distortion, latency or sound
quality. Projection ratios have finite-window/leakage limitations. PCM analysis
does not align source samples, video timestamps or clocks across processes.

With `trace_sif2:true`, a separate incident run follows header wait, the supported
following source marker and the payload wait instead of the normal main-loop trace.
The observed header-wait timeout stops it before a playback measurement; it
must not be counted as a completed playback cycle. Recipe source hashes are
saved in the JSON to distinguish harness versions.

## Project orchestration and verification

The project command `tools/validate-diagnostic-transport.py` accepts
`--playback-audio <fixture.json>` and `--direct-http`. The latter bypasses
HTTP proxies only for the explicit private Jellyfin IP and test subprocesses;
it does not modify global settings. Ordinary mode remains available without
the audio option. Updater incident mode and audio mode are mutually exclusive.

Run the project owner command with a new evidence directory. An audio failure
returns nonzero and keeps `passed:false` in both SMS and service receipts.
To verify already collected incident artifacts from the MCP server directory:

```text
node test/verify-sms-audio-incident.mjs <measured-playback.json> <sif2-trace.json> <new-receipt.json>
```

The verifier checks source identity, complete reference/published hashes, both
MP4/PCM hashes and zero samples, raw/decoded clock agreement, exact event join,
four milestones, the verified semaphore/JAL/following marker and cleanup.
Its receipt deliberately retains `playback_audio_accepted:false` even when
`diagnostic_evidence_verified:true`.

## Validation and next work

- TypeScript build and 215 Node tests passed, including seven new tone/fixture
  checks. These require no BIOS, FFmpeg or private clip.
- Eight separate real-DWARF controls passed: updater/menu/player/SIF2 profiles
  and stale-ELF hash refusals. They require the pinned pyelftools environment
  and retained SMS debug ELF; they do not execute a console.
- The original four-check real transport flow passed against Linux Jellyfin.
- Seven offline incident-evidence checks validate the two failing live runs;
  they do not turn them into successful playback tests. Earlier short-input,
  ambiguous milestone and exact-return probe attempts are excluded. The latter
  did not produce a valid exact-return observation; no such result is claimed.
- Native/Bridge/SMS/decoder code is unchanged and was not rebuilt. No new
  package dependencies, BIOS, private media or credentials are committed.

Local ignored receipts are recorded in `release/playback-acceptance-20261024.json`
and `release/playback-incident-verified-20261024.json`; the live project evidence
stays under its `artifacts/debug-validation/` directories. The public repository
contains the recipe, controls and contract, not these private artifacts.

**Next is 6B2b:** investigate the SIF2 header acknowledgment path in the IOP and
PCSX2 with independent state evidence. A fix needs an actual repeated known-clip
playback/audio result and regression checks. Listening, A/V alignment, long-run
stability and physical-console acceptance remain the separate gates in
[audio measurement](audio-measurement.md). Do not modify optimized decoders
or change runtime based only on this bounded EE wait observation.
