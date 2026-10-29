# Standalone MCP validation — S1

Active scope changed by the user on 2026-10-24: validate the MCP independently;
debug the application in a separate chat. SMS, Jellyfin and media playback are
not prerequisites for this suite. Their incident recipes remain historical and
do not determine whether these MCP checks pass.

## M1: PCSX2 v2.9.147

The current target is pinned v2.9.147. **255 Node / 60 standalone live checks**
passed; seven new checks cover HostFs path identity, valid/invalid/partial
writes and break/log/both watchpoints. The command now runs eight native suites
using the same four fixtures. Native integration manages 27 files.
[Migration and 53 extra regressions](pcsx2-2.9-migration.md).

## S2b2b update (historical)

The current command runs **53 live checks and 255 Node tests**. Six new checks
use a fourth fixture with its own IOP thread, current IE enabled and a growing
VBlank callback count. The native fix preserves a breakpoint stop instead of
dispatching an IRQ after pause. Two restore cases abort after actual submission
and discard a real completion reply, then reconcile by receipt without retry.
Pass `--irq-fixture <directory>` to reuse its build; otherwise Docker builds it.
[Contract, extra 13 IOP regressions and GUI blocker](irq-pause-boundary.md).

## S2b2a update

The current runner adds eight native savestate checks, for **45 live checks and
255 Node tests**. Rebuild PCSX2 and Node for actual guarded load outcomes and
receipt status. PINE save/load acknowledgements remain unconfirmed. The suite
uses private states and tests empty/corrupt/missing-content files, exact restored
RAM, cancellation before dispatch, refusals and receipt retention/reconnect.
[Contract and limits](state-load-outcomes.md). GUI and native in-flight
interruption remain unverified.

## S2b1 update

The current command adds five native connection/reset/restore checks, for
**37 live checks and 247 Node tests**. It reuses the render fixture, configures
PINE only in its private INI and keeps generated savestates local. The Node
connection fix needs no native rebuild. [Recovery contract](connection-recovery.md).

## S2a update

The current runner also builds `build-instruction-fixture.py` and runs 14
instruction checks, for **32 live checks and 231 Node tests**. It accepts
`--instruction-fixture` alongside the render/SIF reuse options. MCP step tools
now support EE/IOP CPU selection, native execution budgets and partial JSON
results. IOP deterministic vectors clear the current interrupt-enable bit in
their own fixture. [Full contract and limits](instruction-control.md).

The S1 counts and observations below remain historical evidence of that delivery.

## Run on Windows

Use the current compiled PCSX2 integration and a private configuration root with
`inis/PCSX2.ini` referring to your own BIOS. Node/npm, Python and the source
debug backends must be available. The screenshot/capture checks require the
native FFmpeg DLLs and ffprobe described in [media capture](media-capture.md).
Docker builds the four homebrew fixtures using the already pinned PS2SDK image.

This absolute command works from another directory:

```powershell
rtk proxy python -X utf8 "D:\dev\PCSX2-MCP\tools\validate-standalone-mcp.py" --emulator "D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe" --data-directory "D:\dev\PCSX2-MCP\release\standalone-data" --output "D:\dev\PCSX2-MCP\release\standalone-check-new"
```

Choose a new output directory for each run. `release/standalone-data` is a local,
ignored configured root prepared on this machine, not distributed in Git.
Elsewhere, pass your configured root. Test processes copy the INI into their
own roots, use separate debug ports and stop only the emulators they launch.
BIOS files, local settings and generated artifacts are not published.

The command builds/tests TypeScript, builds the fixtures and runs eight native
suites sequentially. `validation.json` and separate build/suite logs record the
result and hashes. Reuse retained fixtures without Docker using both
`--render-fixture <directory>` and `--sif-fixture <directory>`; their manifests
and source inputs must match the current checkout. Also pass
`--instruction-fixture <directory>` to reuse the instruction fixture.

## What is actually checked

| Suite | Native checks | Evidence |
|---|---:|---|
| Rendered homebrew | 8 | Owned launch/PID/ELF SHA; imported symbols and exact source breakpoint; strict memory/registers/disassembly/backtrace and DWARF argument; unmapped/hash refusals; step/step-over ownership; three VSync steps and PNGs; verified six-frame video-only MP4; paused/running SIF guards |
| EE/IOP transfer fixture | 5 | Four separate processes compare actual IOP RAM, DMA writes, BCR/CHCR/FIFO state and interrupt count; repeated paused reads preserve state and owned processes close |
| SIF guard suite | 5 | Actual paused state; identical reads; stale EE/IOP identity refusal; running refusal without pause; ELF reset invalidates prior observations |

The minimal renderer prints text with PS2SDK `libdebug`. Its retained PNG was
visually inspected. The transfer fixture uses known eight-word data and an
IOP-resident receiver; it loads no audio decoder or application modules. The
runner never connects to Jellyfin or UDPFS.

**18 live checks and 223 Node tests passed** on the rebuilt Windows executable.
Pristine integration, upgrade from `637266d`, repeated application and the
compiled checkout agree across **26 managed native files**. The existing IRX
header-restoration helper now accepts an optional stem; its default behavior
was independently checked against retained IRX bytes and remained identical.

## MCP defect found and fixed

Previously, `step` and `step_over` installed temporary breakpoints but depended
on Qt's asynchronous pause handling to clear them. The standalone reproduction
stopped one instruction later, found that breakpoint still active, then failed
the next frame operation with `paused_early` and zero frames advanced.

Both commands now prepare on the CPU thread, require a paused valid VM, refuse
an occupied successor without altering it, and use a uniquely described private
breakpoint. They remove only an exact, non-overlapping ownership match before
replying. A timeout pauses the same VM and performs that cleanup; a changed VM
is not paused. Replaced/overlapping points are preserved with an explicit
unconfirmed-cleanup failure. Interrupted steps no longer report success.

Live checks cover a normal instruction, ordinary step-over, physical JAL
step-over, an occupied target preserved on refusal, running-VM refusal and
subsequent frame/capture operations. Deadline, GUI replacement/reset and IOP
legacy stepping paths are not independently exercised by this suite. Ordinary
legacy `step` retains its PC+4 target convention; use [guarded source stepping](source-stepping.md)
for supported EE branch/delay-slot semantics. This fix does not establish
universal instruction or IOP stepping support.

## Emulator limits are separate from MCP evidence

The pinned upstream baseline has two independent transfer limitations:

| Case | Backing BCR at start | Eight words received | IOP IRQ callback | Result |
|---|---|---|---|---|
| Halfword BCR + EE DMA | `0x00000008` | No | 0 | EE QWC remains 2 |
| Full-word BCR + EE DMA | `0x00010008` | No | 0 | EE QWC remains 2 |
| Full-word BCR + EE programmed I/O | `0x00010008` | Exact match | 1 | IOP DMA completes |
| Halfword BCR + EE programmed I/O | `0x00000008` | Exact match | 0 | BCR becomes `0xffff0008`; DMA stays active |

The positive control proves the fixture's payload/receiver/interrupt path can
work in this emulator. Full-word BCR alone does not fix EE→IOP DMA. Passing this
baseline suite accepts the MCP observation, **not correct SIF2 DMA emulation**.
No DMA/PGIF transport semantics, SMS, Bridge or decoder were changed here.
No new game playback, audio quality or physical PS2 acceptance is claimed.

## Retained local evidence

```text
release/standalone-acceptance-20261024/          # builds fixtures from scratch
release/standalone-acceptance-20261024-final/    # retained fixture reuse + final guards
release/standalone-integration-20261024/integration.json
release/standalone-irx-helper-control-20261024/validation.json
release/standalone-delivery-20261024.json       # source/native/artifact hashes + publication
```

Earlier standalone smoke attempts are retained as failed: one queried symbols
before asynchronous import completed; subsequent runs reproduced the leaked
temporary breakpoint. An intermediate private-point attempt correctly refused
cleanup because upstream descriptions cannot be attached to temporary points.
The final implementation uses ordinary private points with ownership markers.
The first transfer fixture failed to link an unavailable EE `DelayThread` API;
the final fixture uses a bounded CP0-count observation loop. None of these
attempts is substituted for the accepted runs.

Next MCP work after S2b2b: GUI replacement and broader branch/device cases;
native synchronous-load interruption/rollback remains deferred;
then bounded long-run/CI tests and editor integration.
Application SIF2/audio investigation is a separate backlog; it is not the
automatic next task when continuing MCP development.
