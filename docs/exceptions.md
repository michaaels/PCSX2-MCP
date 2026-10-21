# Automatic EE exception evidence

Rebuild both PCSX2 (integration script + native build) and `pcsx2-mcp-server`
(`npm run build`). Restart the MCP client to discover these tools. The native
EE capabilities are `ee_exception_watch`, `ee_break_provenance` and
`ee_syscall_provenance`; this is a PCSX2
backend, not a physical PS2 debugger. Configured heartbeat observation uses the
separate [progress watch tools](progress-watches.md).

IOP capture is now available through the same tools with `cpu: iop` and capability
`iop_exception_watch`. See [IOP identity, registers and validation](iop-exceptions.md)
for its different Status/reset semantics and explicit unknown module identity.
The EE-specific provenance below continues to apply to EE only.

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

For **EE recompiler BREAK and SYSCALL**, `core.instruction` additionally freezes the
JIT call-site PC, opcode and delay-slot flag. The emitter passes these constants
to a wrapper that calls the original interpreter operation without modifying guest
PC/CP0/BD. The wrapper reads only aligned canonical EE RAM to compare the
instruction word immediately before the operation. Its CPU-thread POD record is consumed
by `OnEEException` before any pause/safe exit, including unselected exceptions;
normal return and reset also clear it. No RAII lifetime crosses the safe exit.
The source is `ee_recompiler_break` or `ee_recompiler_syscall`; CPU, exception
code and opcode must agree. A SYSCALL opcode's immediate field is not the PS2
syscall dispatch number in GPR v1. The collector does not infer a dispatch name
from the opcode or assume that v1 is unchanged by upstream HLE.

Constant-v1 FlushCache/iFlushCache retain the JIT's original fast path: no
wrapper or guest exception is emitted. The original interpreter also has HLE
early returns, which clear the temporary witness without producing a report.
Only an actual matching `cpuException` freezes provenance. Runtime-loaded v1
can take a different upstream path from a constant value; the watcher preserves
that behavior rather than fabricating equivalent exceptions.

`instruction_evidence.status` is `verified` when that opcode matched RAM,
`unverified` when bytes were excluded/unreadable/changed, or `unavailable` on an
uninstrumented path or old native build. `verified` describes that JIT call site
and opcode comparison, not correct architectural exception emulation. Its
`consistency` compares entry PC, BD argument, EPC and Cause.BD with the JIT
origin. Disagreement is reported without rewriting any raw fields. EPC and
Cause.BD comparisons are `null` for previous EXL, since an older exception may
own those architectural fields. Other EE exception codes and interpreter-only
execution have no instruction provenance in this delivery. IOP BREAK/SYSCALL
now have their own [CPU-specific provenance](iop-exceptions.md), never an EE
witness. The node parser accepts old reports with no `core.instruction`.

Example from the original 4B1 delay-slot fixture: JIT instruction `0x00100068`, opcode
`0x0000000d`, delay slot true; upstream exception entry PC/EPC `0x00100064`,
incoming BD false. The report preserves both observations. The ordinary
64-byte code window still centers on the raw exception-entry PC; provenance is
frozen separately and remains available even if extended context is withheld.

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
`vm_stopped`, plus `cpu_reset` for an armed IOP watch whose CPU resets. Fetch after shutdown/another watch can fail with unknown ID or a
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

The **delay-slot BREAK probe exposed an upstream limitation** in 4A: this recompiler
passed the branch PC and `bd=false` to `cpuException`; execution state also
changed before deferred capture. The collector preserves the raw core and
withholds mismatching extended state. It does not repair guest exception
semantics. 4B1 now supplies the independent JIT BREAK origin described above,
while keeping the inaccurate raw entry PC/BD visible. The probe checks truthful
reporting, not correct PS2 delay-slot exception emulation. Precise provenance
for exception paths beyond BREAK/SYSCALL remains pending. Unknown opcodes that upstream merely
logs are also outside this hook's coverage.

78 Node tests passed, plus 16 live EE exception checks, 9 IOP checks and the
existing 11-check source-stepping live regression including BREAK and
watchpoints. Independent ELF assembler labels/PT_LOAD opcodes confirm EE
normal/delay-slot BREAK and SYSCALL origins. Guest fixtures set EXL and EPC
`0x00101234` before either instruction; old EPC stays intact and architectural
comparisons remain unknown. Delay-slot SYSCALL yielded JIT PC `0x00100110`,
delay=true versus raw entry PC `0x0010010c`, bd=false. The raw core is preserved.

The live test also reaches a following BREAK without code-8 capture after both
constant FlushCache variants and HLE GetOsdConfigParam2 (zero-byte read, pinned
retail BIOS). A runtime-loaded FlushCache does raise code 8 with verified
provenance. These are specific upstream paths, not general HLE coverage.
Unverified opcodes and malformed/cross-CPU provenance are unit-tested, not a
live stale-JIT case. Pristine integration, upgrading the previous integration
and repeated application produced identical hashes for all 13 native files.
Local reports:

- `release/exception-validation/trap-provenance-ee/exception-z2UVWo/validation.json`
- `release/exception-validation/iop-sdk5/iop-exception-NTfUz4/validation.json`
- `release/exception-validation/trap-provenance-step/source-step-4fwrhQ/validation.json`
- `release/exception-validation/trap-integration.json`

IOP exceptions were added in 4B2 and JIT provenance in 4B3. Configured EE heartbeat
observation is available in 4C through separate tools. Comprehensive exception-code coverage, Linux host and physical PS2
remain pending. No deliberate fault was
injected into SMS and no playback/audio acceptance is claimed by this fixture.
