# Configured EE heartbeat observation

Rebuild PCSX2 with `tools/apply-debug-server.py` and the native build, rebuild
the Node server, then restart the MCP server/client. Capability:
`ee_progress_watch`. Requires a booted EE ELF and the EE recompiler. This is
an emulator observation tool; it does not implement a physical PS2 watchdog.

## Choose a real progress signal

Select an aligned 32-bit word in canonical EE RAM below 32 MiB whose masked
value changes when the operation makes useful progress. For a program you own,
a `volatile` counter updated after completed work is a useful starting point.
Use the address from the exact loaded ELF/build. This tool does not resolve
variable names or infer useful work from repeated PCs, FPS or changing registers.

An optional second RAM word marks when progress is expected. Observation is
enabled only while `(word & active_mask) == active_value`; other values mean an
expected wait and restart the detection window. The program must maintain this
signal correctly. No signal is injected into SMS or a user game by these tools.

Example, replacing the addresses with those of your own build:

```json
{
  "heartbeat_address": "0x00101000",
  "heartbeat_mask": 4294967295,
  "active_address": "0x00101004",
  "active_mask": 1,
  "active_value": 1,
  "sample_interval_ms": 100,
  "stall_ms": 2000,
  "timeout_ms": 30000,
  "max_samples": 64,
  "screenshot": true
}
```

1. Call `pcsx2_progress_watch_start` and keep `watch_id`. Arming never resumes.
2. Resume normally. Native sampling continues without report polling, including
   after client disconnect. A qualifying observation pauses and captures once.
3. Fetch with `pcsx2_progress_report`, e.g. `watch_id`, `wait_ms: 5000`, and
   optionally `output_directory`. The directory gets unique `progress.json`
   and `frame.png` artifacts when a rendered frame exists.
4. Use `pcsx2_progress_watch_cancel` to disarm that ID. It never resumes, clears
   breakpoints or deletes an already captured report. Cancelling a report wait
   leaves the watch armed until explicit cancellation or wall TTL.

There is one progress watch and one retained progress report. A new progress
watch supersedes its previous ID. A captured report remains immutable through
MCP memory writes and ELF resets, until another progress watch or VM shutdown.
Active exception watches and progress watches are mutually exclusive; refusal
does not cancel the existing owner. Arming also refuses an active source/frame
operation. A completed watch of the other type retains its own frozen report.

## Criterion and bounds

Sampling occurs on the CPU thread, with at most one pending watchdog callback.
The heartbeat must stay unchanged for `stall_ms` and at least three consecutive
qualifying sample intervals while the VM is running, EE cycle values change,
and the optional active signal matches. The observation is explicitly
`configured_heartbeat_stall`, with undetermined cause.

Pauses/resumes, real breakpoints, expected waits, no cycle change, active guarded
source/frame operations, MCP register/memory/PC writes, and a sample gap larger
than four requested intervals reset the window. Paused samples do not read the
heartbeat and contain null memory values. Sample phases explain the qualification
decision; unreadable memory terminates as `memory_unavailable` without pausing
or fabricating a value. Resuming starts a fresh baseline, even if no sample ran
during a short pause. Mutations through other emulator APIs are not covered by
the MCP write hooks.

| Setting | Bound |
|---|---|
| Heartbeat/active address | Aligned word, `0x00000000`–`0x01fffffc`; no aliases, MMIO or ROM |
| Masks | Unsigned nonzero 32-bit integers; active value must fit its mask |
| Sample interval | 50–1000 ms; default 100 |
| Stall threshold | At least 3 intervals, at most 60000 ms; default 1000 |
| Wall TTL | 100–300000 ms; default 30000; includes pauses and waits |
| Retained samples | Ring of 8–64; default 64; total/dropped counts remain visible |
| Optional frame | At most 640×480; requires an existing rendered GS frame |
| Native report | At most 3 MiB; retains criterion/samples/events on overflow |

Time is host monotonic elapsed time between CPU-thread samples, not guest time.
Scheduler gaps are excluded rather than credited as a frozen guest. CPU queue
and GS scheduling can delay sampling, expiry and capture. If the emulator CPU
thread cannot service callbacks, this tool cannot diagnose or capture that host
hang; it does not report that scheduling failure as a guest stall.

Sampling can miss changes that return to the same masked value, including
counter wrap or a narrow mask. A slow operation, unmarked legitimate wait or
poorly selected signal can meet this criterion. Configure the signal, gate and
threshold for the operation; this is not proof of deadlock, a fatal exception,
network failure or any particular root cause. IOP monitoring is not implemented
by this capability, and an EE word does not automatically identify IOP progress.

## Evidence

The immutable report identifies session, EE ELF/CRC and execution epoch, the
exact criterion, unchanged duration/interval count, bounded samples with PC,
cycle word, masked heartbeat/active value and phase, then the paused stop PC and
cycles. It adds existing CPU context/registers/heuristic stack, up to 100 logs,
32 events, 64 code bytes and 256 stack bytes using valid canonical RAM reads.
Collection checks that identity, pause revision and PC/cycles still match;
changed context is withheld. No exception PC or CP0 fault provenance is invented.

`streak_fully_retained` distinguishes an entirely retained streak from a ring
that lost its beginning. The Node parser checks retained unchanged intervals,
cycle changes, ordering, gap bounds, identity and context, but cannot reconstruct
dropped samples. A cropped streak start, missing frame or unavailable context/
RAM is explicit partial evidence. `complete` describes evidence collection,
not a proven fault. Saved PNG bytes are separate; their base64 is removed from
the saved JSON. Directories are unique and not automatically pruned.

States: `armed`, `capturing`, `captured`, `expired`, `cancelled`, `vm_changed`,
`vm_stopped`, `memory_unavailable`. ELF reset invalidates an armed watch;
captured reports retain their original identity. After VM shutdown or a new
watch, the old ID may be unavailable. Save-state identity guards remain outside
this contract.

## Isolated Windows validation

```powershell
# Repository root; use a new directory:
python tools/build-source-fixture.py release/progress-test --wsl --progress --dwarf-version 5
# From pcsx2-mcp-server, using absolute paths:
node test/progress-live.mjs <PCSX2> <ELF> <artifacts>
```

The freestanding fixture reaches a real source breakpoint, then runs a loop
with an explicit counter and expected-work flag. Tests write only its controls;
they never assign PC to simulate a stop. Ten live checks cover stale identity,
no-resume/TTL, owner/conflict handling, healthy counter, expected wait, separate
short runs and long pause, real breakpoint, automatic pre-poll capture/reconnect,
masked words, bounded history/partial frame and saved evidence, captured-report
immutability across writes/reset, supersession and armed reset invalidation.
No-frame and cropped-history cases deliberately return partial evidence.

Unit tests additionally cover malformed criteria/reports, incomplete cleanup,
wait cancellation/concurrency, cycle/sample-gap checks and PNG persistence.
The live fixture does not force an unreadable RAM word, a nonservicing CPU
thread, a scheduling gap, stale JIT or a positive rendered GS frame. It does not
validate performance overhead, long sessions, SMS playback or hardware.

Windows PCSX2 v2.6.3 / Clang DWARF5 acceptance: native and TypeScript builds,
86 Node tests, 10 progress live checks, 16 EE exception checks, 9 IOP exception
checks and 11 source-step checks passed. The IOP loader used the existing pinned
fixture with HostFs temporarily enabled; the portable INI was restored byte for
byte. Reapplying integration left the native sources unchanged. Local reports
under `release/progress-validation`:

- `final/progress-0ZqQul/validation.json`
- `ee-regression/exception-7ctYZZ/validation.json`
- `iop-regression/iop-exception-3Knn5b/validation.json`
- `step-regression/source-step-xOaBLm/validation.json`
- `acceptance.json`: source/binary/fixture hashes and report checks.
