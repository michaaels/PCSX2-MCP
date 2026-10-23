# Bounded native input movies

Implemented and tested on Windows/PCSX2 v2.6.3 on 2026-10-23. Both components
must be rebuilt; native capability `input_movies` is required. These tools use
PCSX2's `.p2m2` v1 pad format and `InputRecording`, with an owned CPU-thread loop.

| Tool | Behavior |
|---|---|
| `pcsx2_input_record` | Create a new power-on movie, reset and leave paused. |
| `pcsx2_input_replay` | Validate movie/ELF hashes, copy the movie, reset and leave paused. |
| `pcsx2_input_movie_status` | Read/wait by ID and verify a nonempty closed artifact. |
| `pcsx2_input_movie_stop` | Close only the selected owned movie and pause. |
| `pcsx2_input_movie_inspect` | Inspect/hash a complete local file without a connection. |

## Workflow and limits

Boot the matching ELF and pause. Enable PCSX2 recording tools, disable hardcore
mode and configure **both ports as DualShock2**, slot 1. No multitap support is
claimed. Start a record with, for example, `{"frames":120,"timeout_ms":15000}`.
Save its returned `operation_id`, `elf_sha256`, original ELF path/CRC and epoch.
Use `pcsx2_continue` to run and `pcsx2_input_movie_status` with that ID and
`wait_ms:15000` to obtain the closed file, actual frame count and SHA256.

To replay, boot/pause the same ELF first. Pass the closed artifact's absolute
`path`, its `movie_sha256` and the saved `elf_sha256` to `pcsx2_input_replay`.
Resume explicitly and wait by the new ID. `reason:eof`, `completed:true`,
`source_preserved:true` and the checked artifact identify successful completion.
Keep the report before starting another movie: native retention is **one** last
operation. Completed files remain on disk and are never deleted by these tools.

Recording supports 1–600 input intervals; default 120. Native wall lifetime is
100–30000 ms, default 15000, including paused time. Replay uses the entire
validated file, also limited to 1–600 records. There is one active movie per VM.
A wait timeout/cancellation leaves native lifetime in charge; stopping requires
the exact ID. An uncertain start attempts cleanup of its own generated ID only
and reports unconfirmed cleanup explicitly. Reconnecting preserves native
ownership; superseded IDs cannot control the replacement operation.

Each interval stores two 18-byte pad records. Frame zero is applied first;
the next input poll completes that interval. At the last boundary the native
file closes synchronously and the VM pauses before the GUI loop can change
replay into rerecording. Replay restores both saved controllers. A manual stop
between polls retains the last complete recorded pad record; that partial
interval is not evidence of completed execution. Counts describe input polling,
not unique rendered images or decoded media frames.

The source replay is opened read-only for copying. The private copy under
`<data-root>/mcp-input/<operation_id>.p2m2` also opens read-only; Windows denies
writes while allowing verification reads. The Node start checks the copied
SHA before returning, and closed status compares original SHA, source and copy.
The existing one-argument GUI playback APIs retain their behavior and ABI.
Existing output paths are refused. A partial pad read returns unavailable,
and native read/write failure ends the owned operation as `io_error`.

The inspector accepts a strict contiguous subset of v1; GUI files with trailing
or uncommitted records are rejected. It checks terminated strings, frame count and exact
length `570 + 36 * frames`; it rejects missing/trailing bytes. Stable bounded
file reads check replacement/mtime/ctime and hash actual bytes. No pad payload
or ELF contents are returned over MCP. Record verification establishes current
closed-file structure/hash; archive its report to compare later file versions.

## Identity, invalidation and exclusions

Start guards process/session, execution epoch and loaded ELF path/CRC. Node
validates the local ELF structure and CRC, handles the native `host:` prefix
and records its full-file SHA256. Replay additionally requires the supplied
movie/ELF hashes. The format itself carries no cryptographic ELF identity:
an external movie's build association is supplied by the caller. BIOS,
settings, external writes, asynchronous devices and network timing are not
attested, and deterministic game execution is **not established**.

The owned initial reset advances the execution epoch and invalidates prior
inspection/module state through the existing reset hooks. Another reset, ELF
reload, state-load attempt or shutdown closes the movie. Restore attempts now
also advance the EE execution epoch, cancel frame/guarded-step operations and
terminate pending EE observers; IOP observers retain `lifetime_changed` from
their observed restore boundary. Historical captured reports remain historical.
IOP registration tokens are not restored from a savestate; source bindings
still require [fresh revalidation](iop-bindings.md).

Frame/input automation, instruction stepping and DebugServer register/memory/PC
mutations refuse during an owned movie. Movie start refuses active GUI input
recording/replay or another execution operation. GUI create/play cannot replace
an active MCP movie. A GUI stop/mode or controller change can interrupt it;
cleanup checks the filename and never closes an unrelated GUI recording.
Manual pause leaves the movie active, bounded by its wall deadline.

**Starting from a savestate is pending and explicitly rejected.** The offline
inspector identifies its flag but does not validate the companion state.
Support for longer files, multitap, other format versions and archived native
operation history is also pending. The tools use the local emulator host's
filesystem; this is not a remote file-transfer or authentication protocol.

## Acceptance and provenance

Windows native build and TypeScript compiled. **163 Node tests passed**, with
11 new contract cases. **11 movie live checks** passed against an owned isolated
instance: real recording, two-port nonneutral replay, EOF, one-frame boundary,
source/copy preservation after resume, exclusion/reconnect, cancellation,
paused watchdog expiry, ELF reset, real PINE savestate restore, stale EE
inspection/EE+IOP observer invalidation and Windows read-only sharing.
The route is synthetic pad input evidence, not a Jellyfin network replay.

**33 regression checks** passed: 12 IOP bindings/provenance, 10 EE/IOP memory
observers and 11 frame/controller automation. The automation harness now forwards
its private port/data environment to both MCP children. The first regression
attempt exposed that harness omission; it is not counted as accepted.
Pristine integration, upgrade from `a0e5a16`, reapplication and the build checkout
agree across **25 native files**, without changing upstream object sizes.

| Evidence | Ignored local path |
|---|---|
| Movie live checks and files | `release/input-movie-live-20261023-release/validation.json` |
| Bindings and memory regressions | `release/input-movie-regressions-20261023-release/` |
| Automation regression | `release/input-movie-regressions-20261023-release/automation/live/results.json` |
| Integration equality | `release/input-movie-integration-20261023-release/integration.json` |
| Tested build/source/artifact hashes | `release/input-movie-acceptance-20261023.json` |

From `pcsx2-mcp-server`, after building both components:

```text
node test/input-movie-live.mjs <PCSX2> <homebrew-ELF> <configured-data-root> <new-output>
```

This writes only its new instance configuration/artifacts and stops its own
child. It copies an INI and references the existing BIOS without copying it.
GUI-owned preservation/mode-change branches, actual disk-full/read faults,
non-Windows hosts and physical PS2 have no separate live acceptance here.
No Bridge/SMS decoder, networking, A/V acceptance or binary release changed.

The candidate and EOF problem came from Noah/Ryubara's
[native recording work](https://github.com/Ryubara/PCSX2-MCP/commit/6148044) and
[EOF fix](https://github.com/Ryubara/PCSX2-MCP/commit/974cf222e0104a93facf8f70d4e5f4f64a7a23e5),
pinned in [the fork review](fork-review-2026-10-21.md). This implementation uses
its own bounded ownership loop, frame-zero handling and read-only copy, rather
than merging those patches. Upstream PCSX2 remains pinned to
`bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`; its recording sources retain their
PCSX2 Dev Team/GPL-3.0+ headers.
