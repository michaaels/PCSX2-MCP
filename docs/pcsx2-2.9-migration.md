# PCSX2 v2.9.147 migration — M1

Follow-up [M2](gs-replay-validation.md) accepts D3D11 replay for continuous
drawing on explicitly selected Intel/NVIDIA devices, with 18 further live checks.
The static no-transfer dump limitation and supervised GUI gate remain open.
The results below describe M1's original acceptance.

Validated on Windows on 2026-10-28. The supported target is now the exact
[PCSX2 v2.9.147 prerelease](https://github.com/PCSX2/pcsx2/releases/tag/v2.9.147),
commit `4c3f2eaacbd181f201c094781a79b1d0f996f954`, recorded in
[`tools/upstream.json`](../tools/upstream.json). This pin is not an assertion
about whichever upstream release is latest later.

Local compiled executable:

```text
D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe
SHA256 51042a6330a7e63184bf7fe976dfe19a6e7210043c83a7670eb0c8c132b6914f
```

It reports ProductVersion 2.9.147.0 and includes the native MCP server. The
official executable installed by the user remains unchanged at
`release/windows/pcsx2-qt.exe`; it does not contain these extensions. The Node
entry remains `pcsx2-mcp-server/dist/index.js`. Reconnect to the modified native
process; replacing Node alone cannot add the native integration to an official
binary. This delivery publishes source, not a packaged GitHub binary release.

## Native compatibility changes

- The memory reader/writer moved to `MemoryInterface` with `Read8/16/32`,
  validity pointers and boolean write results. A small compiled compatibility
  header preserves native failure results. A refused write now reports the
  actual completed byte count, including a partial write; no rollback is claimed.
- Backtrace uses the new upstream stack walker without `StackTop`; watchpoint
  hit counts use `totalHits`. Logging/both actions use upstream instrumentation
  and `continueOnHit` instead of the removed legacy logging enum.
- Private breakpoint cleanup also checks the new maximum-hit/instrumentation/
  log-format/continue fields. A changed option prevents owned cleanup. Actual
  GUI mutation acceptance remains pending; this is not a claim it was exercised.
- IOP IRQ register constants were renamed. The paused-dispatch boundary remains
  applied to the same register test. Existing cycle fields keep their legacy
  low-32-bit representation despite upstream widening its internal counter.
- Homebrew now reports a relative guest name such as `host:standalone.elf`.
  Native identity resolves it with the same HostFs path mapper used by the guest.
  All native ELF guards use that full mapped identity. No basename-only matching
  or path/CRC guard removal was introduced. A second file with identical bytes,
  basename and CRC in another directory is explicitly refused.
- FFmpeg 9 muxing discarded the final displayed frame of an owned short MP4
  when its packet duration was zero. Fixed-rate MCP video advances timestamps
  by one codec time-base tick per frame, so a missing duration is set to one
  before rescaling. This applies only to the exact owned MCP capture. Six encoded
  frames now decode as six; the verifier was not relaxed to accept five.

The compatibility header retains source adapters for the previous 2.6 APIs.
The legacy pristine/upgrade/reapply source check still passes. The current runtime
acceptance is 2.9.147; old 2.6 runtime receipts remain historical evidence.

## Build and runtime

Use the pinned checkout and the exact matching native dependency prefix in a
Visual Studio developer shell. Keep output separate from an installed emulator:

```powershell
rtk proxy git clone --depth 1 --branch v2.9.147 https://github.com/PCSX2/pcsx2.git release/upstream-v2.9.147
rtk proxy python tools/apply-debug-server.py release/upstream-v2.9.147
rtk proxy cmake -S release/upstream-v2.9.147 -B release/build-v2.9.147 -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=OFF -DENABLE_TESTS=OFF "-DCMAKE_PREFIX_PATH=D:/dev/PCSX2-MCP/release/windows-deps/deps" "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=D:/dev/PCSX2-MCP/release/windows-mcp-2.9.147"
rtk proxy cmake --build release/build-v2.9.147 --target pcsx2-qt --parallel 8
```

The paths above describe this machine. Obtain/build dependencies using the
[pinned upstream Windows dependency instructions](https://github.com/PCSX2/pcsx2/blob/v2.9.147/.github/workflows/scripts/windows/build-dependencies.bat)
and deploy their DLLs/Qt plugins, plus upstream `bin/resources`, beside the
executable. Do not mix arbitrary Qt DLL versions. This build used MSVC 19.51,
Qt 6.12.0 and FFmpeg 9.0.1 (avcodec/avformat 63, avutil 61, swresample 7,
swscale 10).

Verify/install capture DLLs directly from that same compiler dependency prefix:

```powershell
rtk proxy python tools/install-capture-runtime.py release/windows-mcp-2.9.147 --from-build-deps release/windows-deps/deps --cache release/capture-runtime-v2.9.147
```

The installer reads the ABI major from each version header, refuses different
existing DLLs, checks exported versions and records header/DLL/executable hashes.
This local-prefix mode makes no claim that these DLLs came from a downloadable
FFmpeg 9 package. The default pinned FFmpeg 8 download remains a legacy option.

## Acceptance

Windows and TypeScript builds and **255 Node tests** passed. The standalone
runner now performs **60 live checks** across eight native suites; seven added
checks cover exact mapped ELF identity, mapped/invalid/partial memory writes,
and actual break/log/both watchpoint behavior and hit counts. Prior screenshots,
video, SIF, EE/IOP steps, IRQ activity, reconnect, reset and state loads remain
covered. No project/media server is involved.

An additional **53 live regressions** passed: 13 IOP exception/module/reset,
11 guarded source-step, 11 input-movie, ten video/audio-capture and eight GS-dump
checks. The audio result verifies actual tracks and decoded PCM metrics, not
audible playback or A/V synchronization. The source-step and IOP adapters use
private data roots and ports. Every owned process was stopped.

**27 managed native files** match pristine/reapplied 2.9 integration and the
compiled checkout, including the new compatibility header. Separately, applying
the previous MCP on its pinned 2.6 upstream and upgrading it matches the new
script's pristine 2.6 output. These are comparisons within each upstream; files
from two different PCSX2 releases are not claimed to be identical.

The PNG from the main renderer and the GS software replay were visually inspected;
both show the standalone homebrew text.

## Excluded attempts and limits

- The first compile identified removed native APIs and was not accepted as a
  build. The retained build log describes the final successful compilation.
- The first runtime attempt refused a relative ELF identity, rather than
  bypassing the source guard. The next rejected an MP4 with six packet entries
  but five decoded frames; its final packet was marked discard. Both failures
  are retained. The accepted native correction preserves strict verification.
- The old IOP regression required a missing screenshot. On 2.9 a real frame
  already existed; it now verifies actual availability and the saved PNG when
  present. An initial source-step adapter failed to propagate its private port;
  the corrected isolated run passed.
- The capture ceiling test now explicitly flushes a bounded owned capture to
  exercise delayed encoder packets. The ceiling is unchanged; failed output is
  still unverified. Intermediate fixture/adapter assertions remain failed.
- Replaying this captured static homebrew GS dump using D3D11 did not yield a
  capturable frame. The accepted replay uses an explicitly selected software
  renderer, via `gs-dump-live.mjs ... --replay-software`. Capture still uses D3D11.
  D3D11 GS replay remains unaccepted; no general cause or hardware compatibility
  conclusion is inferred from this one dump.
- The supervised GUI ownership test remains pending. Its 2.6 prototype was
  retained locally when the user switched priority to migration. This delivery
  does not claim to have run that interaction. Native state-load interruption/
  rollback, arbitrary project/device coverage and physical PS2 remain separate.

Ignored evidence:

```text
release/v2.9.147-build-20261028.log
release/v2.9.147-acceptance-20261028/             # failed relative-ELF baseline
release/v2.9.147-standalone-fixed-20261028/       # failed MP4 baseline
release/v2.9.147-acceptance-final-20261028/       # accepted 60 live / 255 Node
release/v2.9.147-api-live-20261028/
release/v2.9.147-iop-regression-final-20261028/
release/v2.9.147-source-step-final-20261028/
release/v2.9.147-movie-regression-20261028/
release/v2.9.147-media-regression-accepted-20261028/
release/v2.9.147-gs-regression-software-final-20261028/
release/v2.9.147-integration-accepted-20261028/integration.json
release/capture-runtime-v2.9.147/installation.json
release/v2.9.147-delivery-20261028.json
```
