# Bounded source stepping (EE)

`pcsx2_source_step` executes the paused EE recompiler against its loaded, local debug ELF.
Rebuild the Node server and apply/rebuild the native patch first. The native
`guarded_step` capability and `execution_epoch` are mandatory. Restart the MCP
client to refresh its tool catalog. This uses both the optional pinned Python
backend described in [source breakpoints](source-breakpoints.md) and the
[addr2line backend](source-debugging.md).

```json
{"mode":"over","max_instruction_units":512,"timeout_ms":5000}
```

| Mode | Stop condition |
|---|---|
| `into` (default) | First change of file/line, including entering a physical call. |
| `over` | First file/line change after physical calls made during this operation return. |
| `out` | Execute a physical `JR $ra` return from the initial function, after any nested calls return. |

All modes execute instructions in callees within the same budget. `over` and
`out` do not run freely to a guessed return-address breakpoint. Nested calls
track actual linked branches and verify their `PC+8` return addresses; a mismatch
stops the operation. This is an initial EE ABI subset, not a general DWARF unwinder.

## Source policy and identity

The tool verifies the ELF's complete SHA256 and PCSX2 CRC before execution. An
optional `expected_sha256` pins a known build. It reads all positive line-table
intervals for the initial PC's exact file/line, including discontiguous ranges,
then resolves the final PC using addr2line. Lines need not increase numerically
in optimized code. It does not open source files or infer missing lines.
SHA256 identifies the on-disk file; PCSX2 CRC is not a cryptographic proof of
the bytes already loaded in emulator memory.

The backend supports the same embedded, uncompressed ELF32 little-endian MIPS
DWARF2–5 subset as line breakpoints. Missing or ambiguous initial line information
rejects the operation while paused. A final address with no source is explicit.
File/line changes are the unit of progress; column/discriminator changes alone
do not constitute successful source progress.

Inline frames are included in source results. `over` follows file/line changes
through inlined code because it has no physical call to step over. `out` from an
inline frame is rejected before execution. Inlined-frame stepping and general
tail-call/nonstandard-return unwinding remain outside this subset.

Each native instruction operation validates process, session, ELF path/CRC, the
starting PC and an execution epoch incremented on reset, including same-ELF
resets. A VM change stops further execution. Same-connection exclusivity prevents
competing MCP operations; it is not a lock on the emulator UI or other processes.
Do not mutate registers/code or operate the debugger concurrently from another
client. Identity/final-state checks detect changes they can observe.

## Budgets, interruption and cleanup

`max_instruction_units` is 1–4096 (default 512). It reserves one decoded EE
instruction, or two for a branch and its executed delay slot; an annulled likely
delay slot reserves one. These are execution reservations, **not a hardware
retired-instruction counter**: a watchpoint may stop before the instruction
executes. An insufficient remaining budget rejects the next branch before resume.
IOP/VU instructions are not counted. The instruction limit ends same-line loops
without claiming a new source line.
The EE interpreter is rejected: upstream Release builds omit its instruction
breakpoint instrumentation, so successor breakpoints cannot enforce these steps.

`timeout_ms` is an execution deadline of 100–30000 ms, default 5000. Source
preparation and final symbolization have their own bounded subprocess timeouts
and are not included in `execution_elapsed_ms`. Each native operation has a
10–1000 ms watchdog deadline, independent of the TCP client. CPU-thread scheduling
and CPU/GS synchronization can delay a pause; this is not a real-time guarantee
against a wedged emulator. Failed communication/cleanup is reported as uncertain.

The native successor uses PCSX2's MIPS opcode analysis, including conditionals,
register jumps and delay slots. Syscall, ERET, invalid/noncanonical PCs/targets
and branches/syscalls in delay slots are refused. The EE exception hook stops
stepping after exception state is established, before continuing normal execution;
Cause/EPC are included in the instruction trace. This includes interrupts and is
not a classifier of fatal faults. A fault collector outside stepping is separate.

At most one private breakpoint is installed per instruction operation. It uses a
unique ownership marker and a non-temporary native record because the GUI clears
temporary breakpoints on pause. The operation removes its unchanged record only;
overlapping/replaced/modified records are preserved and cleanup is incomplete.
Existing breakpoints at a successor or delay slot cause refusal **before resume**,
even if conditional/disabled. Existing starting breakpoints are preserved and
skipped once; watchpoints on that same instruction remain active. EE/IOP
breakpoint hits, watchpoints, exceptions, external pauses, cancellation and reset
stop progression. The watchdog also cleans up an abandoned operation after a
client disconnects; cleanup is not confirmed to the disconnected caller.

The result contains `completed`, `reason`, initial/final source and PC, identity,
`paused`, `cleanup_complete`, execution reservations and the last 32 native steps
(opcode, predicted/observed PC, Cause/EPC). Success requires a changed source line
or physical return, confirmed paused state, matching identity and clean ownership.
Always inspect `completed` and `reason`; a valid JSON response is not completion.
The legacy instruction `pcsx2_step` / `pcsx2_step_over` commands are separate and
are not used by this implementation.

## Validation

Windows PCSX2 v2.6.3 / Direct3D 11, native Python 3.14 + pyelftools 0.33 and WSL
addr2line were used. Live tests boot to real source breakpoints, never assign PC:

```powershell
python tools/build-source-fixture.py release/step-test --wsl --dwarf-version 4 --stepping
# From pcsx2-mcp-server (use absolute paths):
node test/source-step-live.mjs <PCSX2> <ELF> <source-debug.c> 10 <artifacts> fixture
```

The call/loop fixture checks into, over, out, a conditional branch, same-line
instruction limits, preservation of a conditional foreign breakpoint, real memory
watchpoints (also at the starting execute breakpoint), an EE BREAK exception and
watchdog cleanup after disconnect. A separate DWARF5 inline fixture verifies
inline reporting and refusal of inline out. An optimized GCC DWARF2 SMS build
advanced `main.c:39` → `main.c:40` (`0x00105958` → `0x00105974`, seven units).
These coordinates describe that build, not general constants.

Local reports: `release/source-step-validation/*/source-step-*/validation.json`.
Automated protocol tests cover nested/mismatched returns, limits, cancellation,
deadline cancellation, identity changes and uncertain cleanup. IOP stepping,
all branch-likely/indirect-branch variants, host Linux and PS2 hardware have not
been validated by this acceptance run. No variables/locals support is implied.
