# Automatic EE exception evidence

Rebuild both PCSX2 (integration script + native build) and `pcsx2-mcp-server`
(`npm run build`). Restart the MCP client to discover these tools. The native
capability is `ee_exception_watch`; this is a PCSX2 backend, not a physical PS2
debugger or a no-progress detector.

## Use

Connect to a loaded ELF, preferably at a breakpoint before the code of interest:

1. `pcsx2_exception_watch_start` with, for example,
   `{"exception_codes":[4,5,9,12],"timeout_ms":30000,"screenshot":true}`.
   Keep the returned `watch_id`. Arming does not resume the VM.
2. Resume normally or use the existing bounded source/frame tools. A matching
   native EE `cpuException` observation pauses execution and schedules its own
   evidence capture. No report request is required to trigger collection.
3. `pcsx2_exception_report` with
   `{"watch_id":"<returned ID>","wait_ms":5000,"output_directory":"<local directory>"}`.
   The optional directory receives a unique subdirectory with `exception.json`
   and `frame.png` when a rendered GS frame is available. Saved responses replace
   screenshot base64 with an empty string and identify its PNG artifact path.
4. `pcsx2_exception_watch_cancel` with that ID disarms an unused watch. It does
   not resume, clear breakpoints, or delete a report when capture already won.

There is one native watch and one retained report. A new watch supersedes the
previous ID after capture/cancel/expiry; a second active watch is rejected.
Active source/frame execution must finish before arming. An already armed watch
may then observe those operations. Process/session/ELF/CRC/execution epoch are
checked at start; reset invalidates an armed watch. A captured report is frozen
and survives same-process ELF reset, until another watch or VM shutdown.

`exception_codes` contains 1–32 integers in 0–31; duplicates are removed.
Defaults: 4, 5, 6, 7, 9, 10, 11, 12, 13. Interrupts (0), TLB codes (1–3) and
syscalls (8) are excluded by default because normal software uses them. Explicit
selection observes them without claiming they are fatal. This hook sees only
exceptions that upstream PCSX2 actually raises through EE `cpuException`;
selecting a code does not add missing exception emulation to the recompiler.

## Evidence and limits

The hook freezes its entry PC, post-exception handler PC, raw code, incoming BD
argument, previous EXL, Cause/EPC/BadVAddr/Status, 32 GPRs and 32 CP0 registers.
`exception_pc` specifically means **PC received at `cpuException` entry**. The
response's `pc_semantics` and `branch_delay_semantics` make this explicit. It is
not independently verified as the faulting instruction. EPC may refer to an
older exception when EXL was already set; BadVAddr is relevant only for the
reported address/TLB exception codes. No register value alone proves root cause.

Extended collection runs on the CPU thread after safe exit. It checks pause,
VM/ELF/epoch, the MCP inspection revision, PC and GPRs against the frozen stop.
If those checks fail, only the frozen core and recent event history are retained;
RAM and live context are withheld. Mutations outside the MCP revision hooks are
not a general transactional memory snapshot guarantee.

For a matching stop, collection adds a 64-byte code window, 256 bytes at SP,
existing context/registers, heuristic backtrace, at most 100 console logs and
32 recent events. Memory is read byte-valid from canonical EE RAM below 32 MiB;
MMIO, ROM, aliases, wrapping or unavailable reads produce a reason, never
fabricated zero bytes. It does not unwind locals at the pre-handler frame or
apply source DWARF to the handler PC as if it were the fault site.

Screenshots are optional, bounded to 640×480, and require a rendered GS frame.
No frame is a partial report with CPU evidence, not a fabricated image. One-shot
capture bounds frequency; native report size is capped at 3 MiB, retaining core
only on overflow. Artifact directories are unique and are not auto-pruned.
Callers must choose retention if repeatedly saving reports.

Native TTL is 100–300000 ms, default 30000. It continues after disconnect; the
watchdog checks about every 10 ms and schedules CPU-thread work. Deadlines are
subject to CPU/GS scheduling, not hard real-time guarantees. Read waits are
0–30000 ms and do not own execution, so another call may resume the VM. A wait
timeout/cancellation leaves the native watch armed until explicit cancel or TTL.
Reconnect with the ID while that VM still exists. Lost start replies trigger
cleanup of the chosen ID only; unconfirmed cleanup returns `pending_watch_id`.

States: `armed`, `capturing`, `captured`, `expired`, `cancelled`, `vm_changed`,
`vm_stopped`. Fetch after shutdown/another watch can fail with unknown ID or a
lost connection. `complete` describes evidence collection; it does not classify
the exception as a crash. Always inspect `partial_reasons` and state.

## Windows validation and known upstream behavior

Windows PCSX2 v2.6.3 / D3D11, a freestanding Clang DWARF5 ELF:

```powershell
# From the repository root; use a new output directory:
python tools/build-source-fixture.py release/exception-test --wsl --exceptions --dwarf-version 5
# From pcsx2-mcp-server; use absolute paths:
node test/exceptions-live.mjs <PCSX2> <ELF> <artifacts>
```

The fixture reaches a real source breakpoint, never a manually assigned PC.
Normal BREAK froze an entry PC pointing to BREAK bytes, Cause=9 and matching
context/RAM, preserving foreign breakpoints. Capture completed while the native
client was disconnected, before any report polling; reconnect retrieved it.
Reset preserved captured evidence and invalidated an armed watch. Tests also
cover expiry, foreign-ID cancellation, conflict, supersession and a nonmatching
BREAK under an arithmetic-only filter. A fixture without GS initialization
confirmed an explicit missing-frame partial report. PNG persistence is tested
with a valid synthetic PNG; this fixture does not validate positive GS capture.

The **delay-slot BREAK probe exposed an upstream limitation**: this recompiler
passed the branch PC and `bd=false` to `cpuException`; execution state also
changed before deferred capture. The collector preserves the raw core and
withholds mismatching extended state. It does not repair guest exception
semantics or claim verified fault PC/BD in this case. The probe checks truthful
reporting, not correct PS2 delay-slot exception emulation. Precise instruction
provenance remains pending. Unknown opcodes that upstream merely logs are also
outside this hook's coverage.

70 Node tests passed, plus the existing 11-check source-stepping live regression
including BREAK and watchpoints. Local reports: `release/exception-validation/`.
IOP exceptions, independent no-progress monitoring, comprehensive exception-code
coverage, Linux host and physical PS2 remain pending. No deliberate fault was
injected into SMS and no playback/audio acceptance is claimed by this fixture.
