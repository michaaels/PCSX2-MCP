# Debugging validation record

Recorded on 2026-10-21 for implementation commit `49bf380`. Documentation-only
commits that follow it do not change runtime behavior. These results are the
recorded acceptance run, not a claim that every check was rerun when publishing
the documentation or that a binary release was created.

## Latest acceptance

| Layer | Result | What it establishes |
|---|---|---|
| Native Windows build | Passed | The integrated DebugServer compiled and linked into PCSX2 v2.6.3. |
| TypeScript build and Node suite | 91 tests passed | Protocol/schema behavior, ownership, identity guards, bounded data, partial results and mocked failure paths. |
| IOP live checks | 13 passed | Actual resident IRX load, runtime module ranges, unsafe-list refusal, exception evidence, reconnect and reset distinctions. |
| EE exception live checks | 16 passed | Real BREAK/SYSCALL paths, JIT provenance, delay slots, prior EXL, HLE/optimized paths, retention and filters. |
| EE progress live checks | 10 passed | Explicit heartbeat and expected-wait gate, pause/breakpoint handling, bounded automatic capture and retention. |
| EE source-step live checks | 11 passed | Real source stops, calls/returns, branch/delay-slot handling, watchpoints, limits and private-breakpoint cleanup. |
| Native integration consistency | Passed | Pristine upstream, upgrading the previous integration and reapplication produced matching hashes for all 14 native source files. |

The live total is **50 checks**. Fixtures reach real breakpoints; tests do not
assign PC to fabricate execution. The IOP loader temporarily required HostFs in
the isolated portable emulator configuration; its original INI was restored
byte for byte. Deliberately corrupted IOP list bytes were also restored before
guest execution resumed.

Upstream PCSX2 was pinned to `v2.6.3`, commit
`bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`. The previous integration used for the
upgrade comparison was MCP commit `7db45ed`.

Earlier positive rendered-frame screenshot validation used WSL/Linux OpenGL and
native Windows; see [screenshot validation](screenshot-validation.md). The
freestanding exception/progress fixtures do not initialize GS and therefore
exercise explicit missing-frame partial results. Their success is not a new
positive screenshot, playback or audio acceptance result.

## Repeat the checks

Build the native emulator with the matching integration script and dependencies
as described in the [README](../README.md). Rebuild/restart the MCP server when
changing its source or tool definitions. Use an isolated emulator configuration,
a BIOS you lawfully possess and new artifact directories for each fixture build.
Do not run competing emulator tests against the same DebugServer port.

From `pcsx2-mcp-server`:

```powershell
npm ci
npm test
```

The Node suite uses mocks and synthetic image fixtures; it does not compile or
run the emulator. Fixture builders and live scripts below are separate checks.

From the repository root, with Clang/LLD available through WSL and a running
Docker Linux engine for the IOP SDK fixture:

```powershell
python tools/build-source-fixture.py release/check-exceptions --wsl --exceptions --dwarf-version 5
python tools/build-source-fixture.py release/check-progress --wsl --progress --dwarf-version 5
python tools/build-source-fixture.py release/check-step --wsl --stepping --dwarf-version 5
python tools/build-iop-exception-fixture.py release/check-iop
```

The IOP builder pins its SDK container image, preserves sources/maps/symbols
and writes an artifact manifest. It refuses to overwrite an existing output
directory. For its `host:iop-exceptions.irx` loader, enable `[EmuCore] HostFs=true`
only in the isolated test configuration and restore the setting afterward.
The reusable live script does not edit that INI itself.

From `pcsx2-mcp-server`, substitute absolute paths for all placeholders:

```powershell
node test/exceptions-live.mjs <PCSX2> <check-exceptions/source-debug.elf> <artifacts>
node test/progress-live.mjs <PCSX2> <check-progress/source-debug.elf> <artifacts>
node test/source-step-live.mjs <PCSX2> <check-step/source-debug.elf> <check-step/source-debug.c> 10 <artifacts> fixture
node test/iop-exceptions-live.mjs <PCSX2> <check-iop-directory> <artifacts>
```

The angle-bracket arguments are explanatory placeholders, not literal
PowerShell syntax. The live scripts write their own validation JSON and stop
only their owned test emulator. Additional prerequisites and the exact scope
are in [exceptions](exceptions.md), [progress watches](progress-watches.md),
[source stepping](source-stepping.md) and [IOP modules](iop-modules.md).

## Evidence and publication scope

5A3b (2026-10-23): Windows native/TypeScript builds, **152 Node tests**, **12 new
binding/generation live checks** and **55 regressions** passed: 67 live checks.
Source lookup revalidated after resume/reconnect; actual release/re-registration
at the same address/code, failed modload buffer load, same-byte write, changed
artifact, native restore and software reboot revoked old identity. Native
namespace/sequence and stale IOP-watch guards refused; pending IOP observations
terminated while an independent EE watch remained armed. Pristine/upgrade from
`3e5369a`/reapply/build agree across **21 native files**.
[Contract and reproduction](iop-bindings.md). Scope is observed registration
imports plus repeated artifact/image proof, not universal generation tracking.
No new hardware, host OS, A/V or general performance acceptance.

5A3a (2026-10-22): Windows native/TypeScript builds, **142 Node tests**, **11
lifetime-boundary live checks** and **44 regressions** (11 load, 10 IRX, 13 IOP,
10 memory) passed. A genuine release removed the fixture from the module list;
registering the same record/code advanced the epoch again and the old receipt
refused association. Actual SifIopReset/SifIopSync produced a transported reset
packet without advancing the CPU-reset epoch. Native restore cleared the old
locator and advanced the host-owned lifetime epoch. A 70-write probe confirmed
64-entry eviction. Pristine/upgrade from `0a186f4`/reapply/build agree across
**21 native files**, now including `Sif1.cpp`. [Contract and reproduction](iop-lifetime.md).
This is partial 5A3: observed-boundary guards, not reusable per-module generations
or complete loader/reboot coverage. No new physical PS2 or A/V acceptance.

5A2b (2026-10-22): Windows native/TypeScript builds, **136 Node tests**,
**11 load-provenance live checks**, **10 IRX**, **13 IOP exception/module** and
**10 memory-observer** regressions passed. Native integration agrees across
20 files for pristine/upgrade from `f40efe4`/reapply/build. A real HostFs read
covered all 3828 bytes, matched loadcore input and observed registration; the
debug companion resolved actual IOP source with the original loaded-file SHA.
Exports were registered by the real guest; corrupted function pointers refused
verification. Resume, writes and an actual native savestate load invalidated
association while retaining historical evidence. [Contract, receipts and
reproduction](iop-load-provenance.md). Scope is HostFs/0xff80 and the first
guarded pause; other formats/devices, reusable module generations and software
reset lifetime guards remain pending for 5A3. No new hardware/A/V acceptance.

5A2a (2026-10-22): Windows native/TypeScript builds, 127 Node tests, 10 new
[IRX association/source checks](irx-source-association.md), 13 IOP exception/module
and 10 memory-observer regressions passed. A genuine IOP instruction breakpoint
resolved to its exact fixture function/file/line through relocated IRX DWARF2.
The fixture's stripped loadable copy preserves its original program/load headers;
debug-only relocations remain in its separate companion. The integration matches
20 native files across pristine/upgrade from `b6579ed`/reapply/build. This proves
the documented paused immutable-image association, not full load-file provenance,
module generations, all IRX formats or hardware acceptance.

Later deliveries have separate acceptance records: [instance ports](automation.md#independent-instances),
[GS dumps](gs-dumps.md) and [video/audio capture](media-capture.md). F3 on 2026-10-22
passed the Windows build, 110 Node tests, 8 media live checks and 19 GS/automation
regression checks. Its pristine/upgrade/reapply/build comparison covers 20 native
files. These checks do not rerun or replace the original 50 EE/IOP/progress/source
acceptance checks recorded above, and do not measure audibility or A/V sync.

F4 on 2026-10-22 passed the Windows/TypeScript builds, 117 Node tests, 10 new
[memory-change observer checks](memory-change-watches.md), 10 progress and 13
IOP exception/module regression checks. All used owned emulator processes;
private port/data roots isolated the live runs. The pinned integration remains
consistent across 20 files, including upgrade from F3 `0086ab1`. Paired fixture
timings and CPU read/compare counters are recorded without a general performance
claim. This does not add physical PS2, IRX/source/lifetime or A/V acceptance.

The latest local evidence is under the Git-ignored
`release/iop-modules-validation/` directory:

- `live/iop-exception-gr1Zze/validation.json`
- `ee-regression/exception-iJRYl0/validation.json`
- `progress-regression/progress-UqpPyU/validation.json`
- `step-regression/source-step-Swjr8C/validation.json`
- `integration.json` and `acceptance.json`, including source/binary/IRX hashes.

These local reports and emulator binaries are not included by pushing source
commits. The repository publishes implementation, reusable tests, isolated
fixture sources and documented results. BIOS files, user game content and local
runtime outputs are not part of these source changes. Preserve matching
source/integration and upstream licensing when distributing a new native binary.

Limits remain explicit: no general exception/deadlock classifier, reusable IOP
artifact/source binding across module lifetime changes or software reboot/savestates,
comprehensive BIOS coverage, performance acceptance, long-run playback/audio
or physical PS2 debugging. Individual contracts document additional limitations.
