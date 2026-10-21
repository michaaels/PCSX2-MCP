# Source locations from ELF debug information

This extension adds two Node MCP tools. It uses a GNU/LLVM `addr2line` executable;
the existing native PCSX2 patch does not need another rebuild.
For the subsequent inverse lookup and owned file/line breakpoint extension, see
[Source breakpoints](source-breakpoints.md); that extension requires a native rebuild.

| Tool | Behavior |
|---|---|
| `pcsx2_source_locations` | Offline lookup of 1–64 linked hexadecimal addresses in an explicit local debug ELF. |
| `pcsx2_source_pc` | Lookup of a snapshot of the current EE PC in the running ELF on disk, guarded by VM identity and PCSX2 CRC. |

Results include the file SHA256, PCSX2 ELF CRC, debug-line availability, backend and
per-address source frames. Each frame can contain a demangled function, filename,
line, column and discriminator. Inline frames follow addr2line's order, from the
inlined function to its caller. Columns are null when the backend does not report them.
Unknown names/lines remain null; addresses without a source line have `resolved:false`.
The GNU output contract is documented in the [addr2line manual](https://www.sourceware.org/binutils/docs/binutils/addr2line.html).

## Prerequisites and configuration

Keep a **linked ELF32 little-endian MIPS executable with debug information**. Compile
with `-g` and retain the ELF before stripping or linking with `-s`. A linker map alone
cannot restore DWARF source lines. Optimization can produce several inline frames or
non-sequential source locations. Execution control is documented in
[source stepping](source-stepping.md); current-frame values have a separate
[variables tool](variables.md).

By default the server searches PATH, in order, for:

1. `mips64r5900el-ps2-elf-addr2line`
2. `llvm-addr2line`
3. `addr2line`

On Windows, if all three are missing, it uses the default WSL distribution's
`addr2line`, `wslpath`, `env` and coreutils `timeout`. This works with the existing
Ubuntu installation on the development machine. The server does not install packages
or change the WSL default distribution. A found executable that fails is reported;
its errors are not hidden by switching to another backend.

Optional MCP-server environment variables:

| Variable | Meaning |
|---|---|
| `PCSX2_ADDR2LINE_BACKEND` | `auto` (default), `native`, or `wsl` (Windows only). |
| `PCSX2_ADDR2LINE` | Absolute native executable path. With backend `wsl`, an absolute Linux executable path instead. No command arguments or shell strings. |
| `PCSX2_ADDR2LINE_WSL_DISTRO` | WSL distribution name; used only by the WSL backend. |

For a Windows PS2DEV installation, set backend `native` and the full path to its
`mips64r5900el-ps2-elf-addr2line.exe`. The tool runs through argument arrays with no
shell or stdin, using a fixed set of flags. Native processes have a 10-second timeout;
each WSL host invocation has the same limit and its Linux lookup worker is additionally
bounded by an 8-second coreutils timeout. Both output streams together are limited to
1 MiB. Cancellation terminates the host worker; the WSL timeout also bounds a Linux
worker that outlives it. Debuginfod URLs are cleared for these child processes.

## Usage

Offline, without PCSX2 or a DebugServer connection:

```json
{
  "elf":"D:\\project\\build\\game-debug.elf",
  "addresses":["0x00100030","00100040"]
}
```

Optionally supply `expected_sha256` as a 64-character hexadecimal build fingerprint.
Duplicates
are preserved in the response but looked up once. Input paths must be absolute; spaces
and Unicode are supported. Files are limited to 256 MiB. The reader validates ELF
header/table bounds and executable PT_LOAD ranges before starting an external tool.
ELFs without `.debug_line`/`.zdebug_line` and addresses outside executable segments
produce explicit unknown results without launching a decoder. Ordinary on-disk changes
during lookup are rejected using file identity, size and modification timestamps.

For the running EE, call `pcsx2_source_pc` with `{}` after connecting. PCSX2 reports
host-loaded paths with a `host:` prefix; the tool removes that prefix only for an
absolute local path. It checks the file's XOR-of-32-bit-words CRC against PCSX2's
current ELF CRC, and checks process/session/ELF/CRC before and after lookup. The report
retains the original runtime path. This CRC detects ordinary build mismatches but is
**not a cryptographic proof of loaded bytes**; SHA256 identifies the on-disk file only.

PC lookup holds this MCP connection exclusively and makes no pause/resume, register,
memory or breakpoint changes. If the VM is running, the result describes the PC at the
status snapshot, not its later position. Pause explicitly first for a stable stop.
Concurrent UI/native clients can still reset or otherwise affect the VM.

## Limits

- These address-to-source tools do not install breakpoints. Separate
  [source breakpoint tools](source-breakpoints.md) now support exact file/line
  groups. [Source stepping](source-stepping.md) is available separately;
  [current-frame variables](variables.md) support a bounded DWARF location subset.
- No source-file reads, path remapping or automatic source-file existence checks.
  Returned paths are compiler-recorded paths, which may be Linux paths on Windows.
- No address rebasing or automatic alias normalization. Supply the ELF's linked virtual
  address; IOP/IRX modules with relocations require their matching linked address space.
- Current-PC lookup supports the main EE ELF at a local/`host:` path. For disc ELFs,
  separate symbol/debug files or IOP modules, use explicit offline addresses and the
  correct local debug ELF. Automatic module/build matching is not implemented.
- ET_REL/ET_DYN, extended ELF section numbering and standalone `.debug` files are
  unsupported. A debuglink-only stripped file without its own line section returns
  unknown. Split-DWARF support depends on the backend and accessible companion files;
  this extension does not discover, validate or match them.

The existing SMS release artifacts have no DWARF lines. Adding symbols from a map in
the previous validation stage did not create line information. These tools will need
a future SMS build retaining `-g` metadata; this change does not modify the SMS runtime.

## Build and validation

Run `npm test` in `pcsx2-mcp-server` to compile and run the suite (43 tests at this stage). Source tests cover
ELF bounds, unknowns, inline output parsing, Windows paths, checksums, file changes,
identity changes, WSL argument handling, subprocess failure/output bounds and cancellation.

A tiny integer-only MIPS test program is provided in `test/fixtures/source-debug.c`.
Build it with Clang/LLD 18, independently of PS2SDK and the user's project:

```text
python tools/build-source-fixture.py release/source-test --wsl --dwarf-version 4
node pcsx2-mcp-server/test/source-live.mjs release/windows/pcsx2-qt.exe release/source-test/source-debug.elf release/source-test-results
```

Use a new output directory for each fixture build. On Linux omit `--wsl`; use
`--clang`/`--linker` for different executable names. `--dwarf-version 5` builds another
fixture. The tiny program is a test loop, not an SMS binary or a PS2SDK replacement.
Live validation refuses an occupied debug port through the launch tool and stops only
the emulator it owns. It saves `source-live.json` with source-location evidence.

Validated on Windows with the native PCSX2 v2.6.3 build and Ubuntu WSL GNU addr2line
2.42 with both DWARF 4 and DWARF 5: real compiler source lines, inline call frames, wrong-SHA refusal, and
live EE PC/CRC matching without changing the paused PC. Native Windows addr2line,
Linux-host MCP execution, IOP/modules, split DWARF, commercial games and physical
PS2 hardware are not validated by this fixture.
