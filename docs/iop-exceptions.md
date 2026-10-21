# IOP exception watches

Rebuild PCSX2 with `tools/apply-debug-server.py` and the native build, rebuild the
Node server (`npm run build`), then restart the MCP client. The capability is
`iop_exception_watch`. Both EE and IOP recompilers are required; interpreter
configurations are rejected before arming.

Use the same three [exception tools](exceptions.md), selecting the CPU:

```json
{"cpu":"iop","exception_codes":[9],"timeout_ms":30000,"screenshot":true}
```

`cpu` defaults to `ee`. There is still one watch/report for the VM, covering one
selected CPU, not simultaneous EE and IOP monitors. Arming does not resume.
Resume through the existing controls, then fetch with `pcsx2_exception_report`
and the returned `watch_id`. Fetch/cancel require only that ID. TTL, disconnect,
artifact directories, 3 MiB report cap and one-shot retention work as documented
for EE. An EE-only watch ignores IOP exceptions, and vice versa.

## Identity and registers

IOP reports explicitly identify `cpu: iop` and
`elf_role: ee_boot_affinity_only`. The `elf`/CRC fields identify the VM's EE boot
context; they are **not** the executing IRX's ELF, symbols or source map.
`module_identity: null` and `iop_module_identity_unavailable` keep every current
IOP report partial until actual module identity/mapping is implemented. Do not
feed its PC to the EE source/variable resolver.

Start checks process/session/EE boot identity/execution epoch and an additional
`iop_reset_epoch`. Native `psxReset` increments that epoch, disarming an armed
IOP watch as `cpu_reset`. VM reset remains `vm_changed`; captured reports retain
their original identity and survive resets until another watch or VM shutdown.
`iop_reset_scope: cpu_reset_only` is explicit in capabilities, watch state and
report. It excludes guest software reboot (`SifIopReset`), module unload/reload,
and save-state restore. A watch is a CPU observation filter, not a module lifetime
guard, and can remain armed through software reboot. Module generations and
software-reboot correlation remain pending.

The hook at the end of native `psxException` freezes:

- Entry PC, post-exception handler PC, raw exception code and incoming BD.
- 32 GPRs, zero-extended to the existing 128-bit JSON envelope; values are 32-bit.
- All 32 actual `psxRegs.CP0` words plus HI/LO. The IOP DebugInterface only exposes
  GPR categories; its missing CP0 category is not substituted with fake values.
- `previous_status` and resulting R3000 Status mode stack. `previous_exl` is null:
  EE EXL semantics do not apply to this CPU. Cause/EPC/BadVAddr/Status are raw.

Only exceptions upstream raises through `psxException` are observable. BREAK and
explicitly selected syscall are tested. Interrupts are excluded by default and
have no positive live acceptance here. A filter for an unimplemented exception
does not add exception emulation. BadVAddr is meaningful only for relevant codes.

The hook requests a safe EE exit; IOP JIT BREAK/SYSCALL paths check the pending
capture and return before their handler runs. Deferred CPU-thread collection
checks pause, identity, revision, IOP epoch, PC, GPRs, CP0 and HI/LO. Matching
stops add the existing IOP context/backtrace, logs, events, and canonical IOP RAM
windows (64 code bytes, 256 at SP). Reads exclude aliases, ROM, MMIO, wraparound
and addresses at/above 2 MiB. Unavailable reads have no fabricated hex. A changed
stop retains core/events and withholds later RAM/context. Backtrace is heuristic.
The optional GS screenshot is the VM's current visual frame, not an IOP-specific
rendering. No frame remains partial evidence.

`exception_pc` means PC at `psxException` entry. `instruction_evidence` is
unavailable for IOP; EE BREAK provenance is never reused. The pinned IOP JIT
also supplied `bd=false` for a genuine delay-slot BREAK. The fixture's raw EPC
then equaled the BREAK PC instead of the preceding branch. Those values remain
visible; the collector does not repair architectural emulation or claim verified
IOP fault PC/BD from them. Normal BREAK PC was independently contrasted with IRX
instruction bytes. Nested EE EXL comparisons remain EE-specific.

## Isolated Windows validation

The fixture loads its own resident IRX with `SifLoadModule`. A worker delays two
guest seconds, sets a register marker, then executes BREAK or syscall. A real EE
source breakpoint after load allows arming first. No test sets IOP PC to fake a
fault or a stop. The SDK image is pinned to the existing legacy digest; both
compilers report GCC 3.2.3. The build preserves sources, IRX symbols/map and
EE DWARF, and writes `manifest.json` with source/artifact hashes. It never
overwrites an existing output directory. `make` is installed inside the temporary
container if absent; no system SDK is installed.

```powershell
# Requires a running Docker Linux engine. From repository root, use a new path:
python tools/build-iop-exception-fixture.py release/iop-test
# From pcsx2-mcp-server, with absolute paths:
node test/iop-exceptions-live.mjs <PCSX2> <fixture-directory> <artifacts>
```

For this loader fixture, enable PCSX2's Host Filesystem (`[EmuCore] HostFs=true`)
in the isolated test configuration, so `host:iop-exceptions.irx` can load from the
ELF directory. Otherwise `SifLoadModule` returns -203. The watch feature itself
does not require HostFs. Validation temporarily enabled this portable setting
and restored the original INI byte-for-byte after stopping its own emulator.
The reusable live script assumes this prerequisite and does not edit the INI.

Nine IOP checks passed: actual IRX load/stale epoch rejection; automatic capture
before polling and reconnect; independent IRX opcode/partial-frame evidence;
immutable report across VM reset; EE filter ignores IOP BREAK resumed from a real
IOP breakpoint; delay-slot raw-state probe; real code-8 syscall; explicit software
reboot scope; native CPU reset invalidation. The CPU-reset fixture writes the
SBUS_F240 bit 19 that the pinned upstream `HwWrite.cpp` maps to `psxReset`; this
is an isolated emulator probe, not physical PS2 reset acceptance.

76 Node tests passed, alongside 11 EE exception live checks and 11 source-step
regression checks. Integration reapplied without changing native source hashes.
Reports: `release/exception-validation/iop-sdk5/iop-exception-Wah6XU/validation.json`,
`iop-ee-regression/exception-TeNe0B/validation.json`, and
`iop-step-regression/source-step-rOzzRJ/validation.json` under the same parent.
No SMS runtime/decoder/Bridge changes, playback/audio or hardware acceptance.
IOP interpreter, Linux host, full code coverage, IRX/source mapping, software
reboot generations and independent no-progress monitoring remain pending.
