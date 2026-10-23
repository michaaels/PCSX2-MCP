# Guarded IRX code and source association

5A2a, extended by 5A2b on 2026-10-22. Rebuild native PCSX2 and TypeScript; restart the MCP
client. Native capability: `iop_module_image`. This delivery associates a chosen
local artifact with an observed immutable runtime image at one guarded pause.
Without a load receipt it does not establish the full original load-file
identity. Optional `load_watch_id` adds [observed load provenance](iop-load-provenance.md)
at its first guarded pause. Neither mode establishes a reusable module generation.

With [5A3a](iop-lifetime.md), snapshot/image requests additionally guard
`iop_lifetime_epoch`. Observed loader/registry/reset/restore boundaries invalidate
old request identities even if code, address and name remain the same. The
epoch covers observed boundaries only; full per-module generations remain 5A3b.

## Workflow

1. Pause the VM through the normal debugger controls.
2. Call `pcsx2_iop_modules` and select an explicit `record_address`.
3. Call `pcsx2_iop_verify_irx` with `irx`, `module_record` and optionally
   `expected_sha256` and `load_watch_id`. The path must be absolute. A debug companion may be used
   if its loadable image matches the loaded module.
4. Call `pcsx2_iop_source` with the same fields and optional `addresses` (1–64
   runtime IOP addresses). Omit addresses to inspect the sampled IOP PC.

Example, replacing both paths and addresses with your actual build/load:

```json
{
  "irx": "D:\\build\\my-module.debug.irx",
  "module_record": "0x00045000",
  "addresses": ["0x000450ac"]
}
```

The tools never pause, resume, write RAM or install breakpoints. Each invocation
gets a fresh table/image and retains no reusable binding. It guards process,
session, EE ELF/CRC boot affinity, VM execution epoch, IOP CPU-reset epoch and
pause revision on the CPU thread. It reads and verifies the module image before
source lookup and again afterward. Metadata, locator discovery, sampled PC,
normalized image hash, file SHA256 and file version must remain consistent.
Resume/pause, DebugServer writes, VM/native CPU reset or detected file/image
changes invalidate the result. A supported artifact with no DWARF returns
`no_debug_line_section`; compressed lines return
`compressed_debug_lines_unsupported`. Unsupported layouts/relocations fail.

`runtime_address` is the input address; `linked_address` and the legacy source
row's `address` refer to the IRX's linked coordinate. Source filenames are build
paths from DWARF, not automatically mapped to Windows files. The EE ELF is never
used as an IOP source file. Import/export-table addresses, data, aliases and unaligned
addresses stay unresolved. IOP source breakpoints, stepping and variables are
not implemented by these read-only tools. Existing exception reports and
`pcsx2_iop_modules` keep their original null artifact/source identity fields.

## Evidence and limits

The local artifact gets a SHA256, including debug information. Matching it to
RAM reconstructs relocations at the observed text base and compares supported
immutable executable/readonly sections. It checks IOPMOD name/version, entry,
GP and text/data/BSS extents too. Name/version or subtracting a base alone does
not pass verification. A minimum of 64 fully compared executable bytes outside
import/export tables is required.

The evidence status is `matched_relocated_readonly_image`. Its normalized hash
uses fixed image coordinates with unchecked bits zeroed according to the
comparison mask. `compared_bytes` includes bytes with at least one checked bit; import-mode
bits are partially masked. `compared_executable_bytes_excluding_imports` counts
only fully checked executable bytes outside imports and exports. The report exposes ignored
writable/BSS sizes, loader-mutable byte count, import/export table ranges and relocation
counts, rather than implying a whole loaded-file hash.

Known imports are recognized only through bounded original headers and stubs:
library name/version and ordinal instructions remain checked, while the next
pointer, linker mode bits and first jump word are treated as loader mutable.
Runtime shapes/pointers/jumps must remain in the supported subset. Exact target
library/function semantics are **not verified**, and the entire table is excluded
from source mapping. Bounded export tables permit only known list links/mode
changes, while all relocated function pointers remain compared; see the
[export contract](iop-load-provenance.md#export-tables). Other self-modification
fails comparison.

Without `load_watch_id`, `original_loaded_file_sha256` remains null.
`module_generation` always stays null and `import_targets_verified` stays false.
Two artifacts with identical immutable
code but different writable initializers or debug metadata can both match this
scope. A caller-supplied expected SHA selects a specific local candidate; it does
not prove that exact file was originally loaded. **5A2b** adds observed full-file
HostFs provenance, full original load-image comparison and bounded export tables;
other devices and module formats remain pending. Module unload/reload,
software `SifIopReset` and savestate lifetime guards remain **5A3**. These tools
do not authorize reuse of an old record or binding across those operations.

## Supported dialect and bounds

- ELF32 little-endian MIPS, `ET_SCE_IOPRELEXEC` (`0xff80`), IOPMOD followed by one
  zero-based PT_LOAD. `0xff81`, ET_EXEC IRX, COFF and other layouts are refused.
- File 52 bytes–32 MiB, read into a fixed bounded buffer; at most 1024 sections.
  Loadable text+data at most 256 KiB, total allocation inside canonical IOP RAM
  below 2 MiB. Overlapping allocated sections/module ranges are refused.
- Standard allocated PROGBITS/NOBITS with supported flags. Section/file/load
  coordinates must agree. Writable executable sections and RELA are refused.
- At most 65536 load relocations: NONE, MIPS_16/32/26/HI16/LO16. HI16 requires
  an adjacent matching LO16; unsupported types/chains, duplicate or invalid
  targets fail. File-only `.debug_*` relocation tables have a separate 65536
  limit and are never applied to the runtime image.
- At most 128 recognized import tables (4096 stubs each), plus 128 bounded export
  tables (4096 functions each). The source
  worker uses the existing no-shell addr2line runner, 10-second host timeout,
  1 MiB combined output bound and bounded WSL worker. Its environment disables
  debuginfod fetching.

Loader and import semantics were checked against the PS2SDK primary source at
[`89b9d8c`, loadcore.c](https://github.com/ps2dev/ps2sdk/blob/89b9d8cf249f927192c57804ce5e55e99e34002d/iop/system/loadcore/src/loadcore.c).
The verifier is an independent implementation. Native integration stays on
PCSX2 v2.6.3 `bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`.

## Fixture and acceptance

The following records the original 5A2a acceptance. 5A2b expanded the fixture
with a before-load stop and a real registered four-function export library.
Current acceptance is **136 Node tests**, **11 provenance live checks** and
**33 IRX/IOP/memory regressions**; updated build-specific coordinates and receipts
are in [load provenance](iop-load-provenance.md#acceptance-and-reproduction).

The pinned SDK fixture now generates `iop-exceptions.debug.irx` with DWARF2
and a stripped `iop-exceptions.irx` for loading. Legacy linker orphan DWARF VMAs
are explicitly set to zero so section-relative debug references are valid.
The old iop-strip drops program headers for `0xff80`; the builder restores the
two original load contracts and validates byte-for-byte equality of the loadable
image and IOPMOD metadata. File-only DWARF relocations are absent from the
loaded copy. Never load the debug companion with those relocations into IOP.
Both hashes, sources, maps and pinned toolchain image remain in the manifest.

Windows native/TypeScript builds and **127 Node tests** passed. **10 new live
checks** used actual SifLoadModule and a genuine IOP execute breakpoint, without
assigning PC. The observed fixture matched 27 relocations, 508 partly/fully
compared readonly bytes and 436 fully checked executable bytes outside imports.
Runtime `0x000450ac` mapped to linked `0x7c`, `worker`,
`/fixture/iop-exceptions.c:39`; entry mapped to `_start`, line 47. These are
run-specific coordinates.

Live negatives covered stale revision/reset identity, excluded record, wrong
hash, same-name/version altered code, unsupported dialect, guest code mutation
with restoration, missing DWARF, excluded source addresses, file mutation after
a real worker, resume/pause invalidation, reset and foreign breakpoint retention.
Regression: **13 IOP exception/module** and **10 memory-observer** checks passed
with the new loadable fixture. Pristine, upgrade from `b6579ed`, reapply and build
checkout agree for all **20 native files**. No new physical PS2, A/V or general
performance acceptance is claimed.

Reproduce from the repo root with Docker Linux running and an already configured
native data root (including your BIOS reference), substituting absolute paths:

```powershell
rtk proxy python -X utf8 tools/build-iop-exception-fixture.py release/check-irx
rtk npm test --prefix pcsx2-mcp-server
rtk proxy node pcsx2-mcp-server/test/irx-live.mjs D:\dev\PCSX2-MCP\release\windows\pcsx2-qt.exe D:\dev\PCSX2-MCP\release\check-irx D:\dev\PCSX2-MCP\release\windows D:\dev\PCSX2-MCP\release\check-irx-live
```

The harness chooses its own port and private data root, copies only the INI,
enables HostFs there and stops only its owned emulator. It never modifies the
source INI or copies BIOS. Output directories must be new. Local ignored evidence:

- `release/irx-live-20261022-final/validation.json`
- `release/irx-regressions-20261022/`
- `release/irx-integration-20261022/integration.json`
- `release/irx-acceptance-20261022.json`
