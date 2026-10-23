# Observed IOP load-file provenance

5A2b, 2026-10-22. Requires rebuilt native PCSX2 and TypeScript, then an MCP
restart. Capability: `iop_load_provenance`. This extends
[paused IRX verification](irx-source-association.md) with evidence from the
actual HostFs descriptor and loader calls, and supports bounded export tables.
The accepted dialect remains ELF32 little-endian MIPS `0xff80`.

## Workflow

1. Stop before the program opens the IRX. Set ordinary breakpoints before and
   after the real load as appropriate for your program.
2. Call `pcsx2_iop_load_watch_start` with the absolute path of the **actual
   loadable file**, optional `expected_sha256`, and `timeout_ms` (100–300000;
   default 30000). Retain `watch_id`. Arming does not load, pause or resume.
3. Resume normally and stop at the first pause after registration. The native
   observer works without report polling or a connected MCP client.
4. Read `pcsx2_iop_load_report` with that ID and optional `wait_ms` (0–30000).
   A registered report includes the verified original file SHA, captured
   FileInfo, buffer/record coordinates, coverage and current binding status.
5. While `binding_available` is true, pass `load_watch_id` to
   `pcsx2_iop_verify_irx` or `pcsx2_iop_source`, alongside `irx` and
   `module_record`. A separate debug companion may be used if its entire load
   image, IOPMOD bytes and load relocation plan match the captured artifact.

Example fields, replacing paths/IDs/addresses with the actual observation:

```json
{"irx":"D:\\build\\module.irx","timeout_ms":30000}
```

```json
{"irx":"D:\\build\\module.debug.irx","module_record":"0x00045000","load_watch_id":"0123456789abcdef0123456789abcdef","addresses":["0x000450d8"]}
```

`pcsx2_iop_load_watch_cancel` disarms only its selected pending ID. An already
registered receipt is retained. Report wait timeout/abort does not cancel the
watch. A competing start or foreign cancel cannot steal an active watch; an
uncertain start attempts cleanup only for its newly generated ID.

## What is observed

All native observers execute on the CPU thread and preserve guest execution:

1. HostFs opens the canonical selected local path read-only. `fstat` must show
   a regular file of the selected size. Only that descriptor is watched.
2. Actual guest-requested reads populate a bounded byte/coverage buffer. Every
   file byte must be covered; overlapping reads must agree. The observer does
   not issue additional file reads or change the descriptor offset. It queries
   the current offset before each watched read. Descriptor close must retain
   the expected size and follow complete coverage.
3. The `loadcore` import-23 call (`LoadExecutableObject`) must receive a canonical
   IOP buffer equal to **every captured file byte**. The observer saves the
   nine-word FileInfo and loader sample PC. Other buffers do not qualify.
4. The import-16 call (`RegisterModule`) must use `text_base - 48` and matching
   relocated entry/GP/text/data/BSS metadata. Both hooks return to the original
   guest functions; they do not replace the loader or registration.
5. Node hashes the actual captured bytes and requires the selected SHA, parses
   their IRX metadata and checks FileInfo/record consistency. Raw file bytes are
   retained privately by native code and omitted from MCP report output.

`registered` records observation of the registration **call**, not its return
value or proof that module startup succeeded. The separate IRX verify/source
tools require the module to be present in the paused runtime list and compare
its relocated immutable image before and after lookup. With `load_watch_id`
they additionally compare all original load-image bytes, including writable
initializers, and the relocation plan. Runtime writable RAM/BSS may have changed
normally; those current values are not claimed to equal their initial contents.

On success, `evidence.original_loaded_file_sha256` is the hash of the observed
loadable file. `artifact.sha256` still identifies the selected candidate,
including its debug sections; the two hashes can differ. Without the optional
receipt, original file identity remains null and the previous readonly-image
contract applies. Existing module inventories and frozen exception reports do
not acquire file identity implicitly.

## Scope and invalidation

There is one active/retained watch. Starting another after it terminates
supersedes its ID. File capture is bounded to 64 bytes–1 MiB; loadable text+data
retains the 256 KiB verifier limit. File-only debug relocations are refused for
the watched loadable file. The wall TTL continues while paused; expiry never
resumes the guest. CPU-thread starvation can delay servicing the deadline.

Historical captured bytes and metadata survive reconnect, reset and savestate
load until superseded or native server shutdown. **Association is narrower:**
only the first pause after registration may use the receipt. Before that pause,
`binding_revision` is zero and `binding_available` is false. Afterward, resume,
another state transition, DebugServer memory/register/PC writes, VM/IOP CPU
reset, entering native `DoLoadState`, another observed loadcore-23 call, or a
changed loadcore locator invalidate it. Re-publication of the same locator by
normal library registration is allowed before that pause. Invalidated history
still reports its SHA but cannot authorize source association.

These are conservative pause guards, **not module generations or full lifetime
tracking**. Software `SifIopReset`, unload/reload and custom/direct loader paths
need 5A3 before any reusable binding. Unobserved external RAM writes, custom
loaders bypassing these imports, other I/O devices, disc/network loaders and
buffer-only loads are outside this provenance contract. This does not prove
the semantics of imported target functions. `module_generation` stays null.

## Export tables

The readonly verifier now recognizes up to 128 original `0x41c00000` export
tables, each with 1–4096 functions and a bounded zero terminator. Header/name,
version and every relocated function pointer remain checked. Each pointer must
have an R_MIPS_32 relocation and target aligned executable text. Header/terminator
relocations are refused. Only the two loader list links and mode bit 0 are
masked, with canonical/null link bounds and supported flags checked. The first
link may still contain the original magic when unregistered; the caller link
may not. Import/export tables never qualify as source instructions or count
toward the 64-byte minimum of fully compared executable code. The legacy field
`compared_executable_bytes_excluding_imports` now excludes both table kinds.
Other self-modification remains a mismatch. `0xff81`, ET_EXEC and other IRX
dialects/layouts remain explicitly unsupported.

Semantics were checked against primary PS2SDK
[`loadcore.h`](https://github.com/ps2dev/ps2sdk/blob/89b9d8cf249f927192c57804ce5e55e99e34002d/iop/system/loadcore/include/loadcore.h)
and [`loadcore.c`](https://github.com/ps2dev/ps2sdk/blob/89b9d8cf249f927192c57804ce5e55e99e34002d/iop/system/loadcore/src/loadcore.c),
revision `89b9d8cf249f927192c57804ce5e55e99e34002d`. The verifier/observers are
independent implementations. Native integration remains PCSX2 v2.6.3
`bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`.

## Acceptance and reproduction

Windows native and TypeScript builds passed, with **136 Node tests**. The new
live harness passed **11 checks**: stale identity/paused TTL, ownership,
DebugServer mutation, actual descriptor/full loader/registration chain,
reconnect and source resolution, different writable initializer, export pointer
corruption, resume invalidation, native savestate loading, file-size change,
and VM reset. Regression passed **10 IRX**, **13 IOP exception/module** and
**10 memory-observer** checks. Pristine, upgrade from `f40efe4`, reapply and
build checkout agree across **20 native files**.

The fixture's registered `mcptest` export table has four function pointers.
All 3828 file bytes were observed in one actual HostFs read; original SHA256
`aaad5a8cbd82dc2f5c3a79e744d5a6ac8a6aae818ba01949b783ae9de09415e4`.
FileInfo selected text `0x00045030`, record `0x00045000`; verification used 34
relocations, 620 partly/fully compared readonly bytes and 488 fully compared
code bytes outside tables. Runtime `0x000450d8` mapped to linked `0xa8`,
`worker`, `/fixture/iop-exceptions.c:46` using real addr2line. Coordinates are
specific to this build. The harness uses actual source/instruction breakpoints,
never assigns PC to simulate loading, and changes only its private fixture copy.

From the repository root, with Docker Linux running, a configured Windows
native data root and rebuilt components, substitute actual absolute paths:

```powershell
rtk proxy python -X utf8 tools/build-iop-exception-fixture.py release/check-load
rtk npm test --prefix pcsx2-mcp-server
rtk proxy node pcsx2-mcp-server/test/load-provenance-live.mjs D:\dev\PCSX2-MCP\release\windows\pcsx2-qt.exe D:\dev\PCSX2-MCP\release\check-load D:\dev\PCSX2-MCP\release\windows D:\dev\PCSX2-MCP\release\check-load-live
```

The Windows harness chooses private debug/PINE ports and a data root, copies
only the configured INI, enables HostFs/PINE there, and saves its test savestate
inside that root. It stops only its owned emulator, never copies BIOS or edits
the original INI, and requires a new output directory. Local ignored receipts:

- `release/load-provenance-live-20261022-accepted/validation.json`
- `release/load-provenance-irx-regression-20261022-accepted/validation.json`
- `release/load-provenance-regressions-20261022-accepted/`
- `release/load-provenance-integration-20261022-accepted/integration.json`
- `release/load-provenance-acceptance-20261022.json`

Repeated/conflicting descriptor reads, truncated reads and unsupported FileInfo
branches are implemented defensively; their complete matrix has not been
exercised live. Node tests cover malformed/corrupt receipts and candidate/guard
changes. Acceptance does not cover every BIOS, other host OSes, general
performance, A/V playback or physical PS2 debugging. Next: **5A3 lifetime guards**;
F5 input replay remains dependent on that work.
