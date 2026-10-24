# Paused SIF/PGIF observations — 6B2b1

`pcsx2_sif_snapshot` reads SIF0/1/2 EE DMA registers, the corresponding IOP
backing words, SBUS/interrupt storage, backend FIFO counters and PGIF control
state. It also returns the last 64 observed 16/32-bit PGIF DMA writes. Call it
with `{}` after explicitly pausing a connected VM.

Rebuild the native integration and Node server, then reconnect the MCP client.
The native `sif_snapshot` feature is required; the existing release download
does not automatically contain this addition. This delivery rebuilt the local
Windows executable. No SMS, decoder or Bridge behavior changed.

## Contract

- Native sampling runs on the CPU thread with an already paused valid VM.
  Process, server session, execution/IOP epochs and native ELF path/CRC must
  match. Node checks identity and paused EE PC/cycles before and after sampling.
  It refuses a running VM without pausing it.
- Reads access backing storage and existing structs directly. No MMIO read
  handlers, FIFO payload reads, guest memory/register writes or resume commands
  are issued. Backing words are distinguished from effective hardware semantics.
- Each channel includes raw EE CHCR/MADR/QWC/TADR, IOP CHCR/MADR/BCR/TADR and
  backend busy/end/counter/FIFO positions. PGIF includes raw control/status,
  FIFO capacity/count/head/tail and linked-list/to-GPU/to-IOP activity.
- The observer wraps the existing `psxDma2GpuW` dispatch in IopHwWrite.cpp.
  The original handler still executes exactly once. Each record preserves its
  actual address, value, width, aligned backing word before/after, raw IOP PC,
  IOP cycles, sequence and epochs. It observes only this 16/32-bit path while
  DebugServer is active and the VM valid; it is not a general DMA or bus trace.
- History is bounded at 64 records, with explicit observed/dropped counts.
  Server start, VM reset and savestate-load attempt clear history. IOP-only
  lifetime boundaries retain explicitly historical entries. They do not bind
  old PCs to a current module, and history is not restored from a savestate.
- Raw PCs are execution context, not independently verified writer instructions.
  EE and IOP cycles are separate wrapping 32-bit counters. Native ELF affinity
  does not establish a local file SHA or an IOP module identity.
- Decoded flags and FIFO consistency checks retain their original values.
  A `simple_merge_word` comparison describes the result of merging the requested
  halfword/full word into backing storage. A mismatch alone does not prove
  invalid MMIO behavior, transfer completion, ACK delivery or root cause.

## Observed SMS incident on Windows, 2026-10-24

Two new executions used the retained SMS debug ELF SHA
`6d6e7f689ab82c1c1109c29be5ba0bb5f38f897a774b17fe612dd1c1e911b321`
and the pinned eight-second 440 Hz reference MPG. Separate boots are preserved:
one measured playback, another traced the first header ACK wait. Jellyfin Linux
served original bytes; conversion remained on the Windows Bridge host. The
user reports an Atom with 1 GB RAM; that specification was not measured here.

Both boots recorded this sequence without dropped observations:

| Dispatch | Requested value | Backing word before → after |
|---|---|---|
| 16-bit `0x1f8010a4` | `0x0008` | `0x00000000` → `0x00000008` |
| 16-bit `0x1f8010a6` | `0x0001` | `0x00000008` → `0x00000008` |
| 32-bit `0x1f8010a8` | `0x01000200` | `0x00000000` → `0x01000200` |

The simple merged BCR would be `0x00010008`; retained storage is `0x00000008`.
This directly observes the high-half write failing to change storage. The
pinned upstream PGIF implementation explicitly lacks 8/16-bit PGPU access and
its DMA-write switch has no `0x1f8010a6` case. That explains the observed backing
word result, but does not yet establish the complete SMS ACK/audio failure.

At the stalled pauses: EE SIF2 CHCR `0x00000101`, QWC `2`; IOP CHCR
`0x01000200`, BCR `8`; backend EE busy, IOP not busy, FIFO zero words. PGIF
to-IOP is active and both FIFO counts are zero. SIF2/PGIF state and write
history remain unchanged through three measured pauses separated by additional
execution, including five seconds running. The source trace reaches
`SMS_SPU.c:194` before WaitSema, but does not reach the source marker one LUI
after its return within ten seconds. This is not an exact-return observation.

Both native 180-frame captures decode to 143360 stereo PCM frames (2.986667 s),
all zero in both channels. DWARF-backed AudioTime/VideoTime remain 530/580 while
the three CPU cycle samples differ. Playback acceptance remains **failed**.
No audibility, A/V synchronization, E11 causality or physical PS2 claim follows.
See [the playback contract](sms-playback-audio.md).

## Validation and retained evidence

- TypeScript build and **223 Node tests** passed, including eight new protocol,
  bounds, identity, cancellation and read-only behavior tests.
- Native Windows build passed. Pristine integration, upgrade from `a81ffb6`,
  repeated application and compiled checkout agree across **26 managed files**.
- **Five native/MCP checks** passed: actual paused state, identical repeated
  reads, stale identity rejection, running-VM refusal without pause, and ELF
  reset invalidating history. Native history overflow and savestate clearing
  are not independently exercised by this live suite.
- **Five SIF evidence checks** and **seven existing audio-incident checks**
  passed on the new recordings. These validate evidence, not playback.
- Earlier attempts with a nested CPU dispatch timed out; they are excluded.
  The initial reset test also failed because it did not resume the paused new
  boot to establish its CRC. The corrected test runs the boot and passes.

Ignored local evidence:

```text
MCP release/sif-node-20261024.log
MCP release/windows-compile.log
MCP release/sif-integration-20261024-final/
MCP release/sif-live-20261024-accepted/validation.json
MCP release/sif-evidence-verified-20261024.json
MCP release/sif-audio-incident-verified-20261024.json
MCP release/sif-acceptance-20261024.json
Project artifacts/debug-validation/sif-snapshot-20261024-measured/
Project artifacts/debug-validation/sif-snapshot-20261024-trace-final/
```

The project fixture accepts `sif_snapshots:true`. It retains snapshots at player
entry, after each capture, after the five-second interval and at a reached SIF2
source marker or failure. Native/Bridge children owned by both runs were stopped;
the external Jellyfin server was preserved. Credentials and media are not
published. The reproducible evidence checks are:

```text
node test/verify-sms-audio-incident.mjs <measured.json> <trace.json> <new-audio-receipt.json>
node test/verify-sms-sif-evidence.mjs <measured.json> <trace.json> <new-sif-receipt.json>
```

Next **6B2b2**: review the EE→IOP SIF2/PGIF routing and halfword-write handling
against pinned source and a focused transfer fixture before proposing a runtime
fix. A high-half merge alone is not assumed sufficient. Then rerun the exact
clip/ACK recipe and retain failures until tone and player progression are
demonstrated. Listening, A/V timing, stability and hardware remain separate gates.
