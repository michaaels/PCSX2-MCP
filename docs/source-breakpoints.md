# Breakpoints by source file and line

This extension adds three MCP tools and requires the updated native PCSX2 patch
for installation/removal. For execution control see [source stepping](source-stepping.md).
Local variables remain a separate stage.

| Tool | Behavior |
|---|---|
| `pcsx2_source_addresses` | Offline exact file/line → executable statement addresses in a local debug ELF. |
| `pcsx2_breakpoint_source` | Install a group of non-temporary EE breakpoints at all returned addresses, while paused. |
| `pcsx2_remove_source_breakpoints` | Remove the group's still-owned breakpoints using its `group_id`. |

## Optional Python backend

The inverse query uses [pyelftools](https://github.com/eliben/pyelftools) 0.33 to read
embedded DWARF line programs, compilation directories and file tables. The existing
addr2line tools continue to provide address → line/inline function information;
addr2line is not used as if it offered an inverse file/line query.

Python 3.11+ is required for lookup/installation. Group removal needs only the
updated native patch. Other MCP tools do not require this optional environment.
From PowerShell, adapting the repository path if necessary:

```powershell
python -m venv "D:\dev\PCSX2-MCP\pcsx2-mcp-server\.venv-dwarf"
& "D:\dev\PCSX2-MCP\pcsx2-mcp-server\.venv-dwarf\Scripts\python.exe" -m pip install --require-hashes -r "D:\dev\PCSX2-MCP\pcsx2-mcp-server\requirements-dwarf.txt"
```

Linux uses the same requirements and `.venv-dwarf/bin/python`. Alternatively set
`PCSX2_DWARF_PYTHON` in the MCP server environment to an absolute Python executable
with the pinned dependency installed. It is not an arbitrary per-tool command.
The checked-in requirements pin the wheel hash; no global installation is needed.
Do not distribute a machine-specific venv. When packaging the Node server, retain
its `python/` directory and `requirements-dwarf.txt` alongside `dist/`.

The helper runs with isolated Python imports (`-I`), no shell/stdin, a 15-second
process timeout and a 1 MiB combined output limit. It does not read source files or
follow supplementary-debug links. Supported input is an uncompressed, embedded
DWARF 2–5 ELF32 little-endian MIPS ET_EXEC file. Current limits include 256 MiB ELF,
32 MiB per debug section, 4096 compilation units/files, two million decoded entries
and 4096 candidate locations before final selection. These are parsing limits,
not a hard cross-platform process-memory quota.

## Exact-line lookup and source paths

```json
{
  "elf":"D:\\project\\game-debug.elf",
  "file":"src/main.c",
  "line":39
}
```

An absolute compiler-recorded path is exact. A relative path or basename must
identify exactly one recorded file; duplicate `main.c` files are rejected. Line
selection is exact: no nearest-line fallback. `resolved:false`, an empty address
array and a reason report a line without executable statement rows.

Rows must be marked `is_stmt`, have a positive address interval before the next
row/end-sequence, be four-byte aligned and lie within an executable PT_LOAD range.
The result deduplicates addresses. It returns all eligible statement addresses on
that line, up to 64, with columns/discriminators and the original filename. Inline
code may produce multiple locations. This is a statement-line table lookup, not a
query for every enclosing inline call site's line. `resolved_line` is the requested
line when resolved, otherwise null; it never silently advances to another line.

For a retained snapshot or Windows/WSL paths, explicitly map the build prefix to
the local prefix:

```json
{
  "elf":"D:\\artifacts\\SMSNET-DEBUG.ELF",
  "file":"D:\\artifacts\\sources\\src\\main.c",
  "line":39,
  "path_mappings":[
    {"from":"/src/ps2/build/sms-client-debug","to":"D:\\artifacts\\sources"}
  ]
}
```

Mappings use longest-prefix matching at directory boundaries and reject duplicate
prefixes. POSIX paths are case-sensitive; Windows drive paths compare without case.
Returned `file` remains the recorded path; `mapped_file` shows the mapped path.
No filesystem search or source-file read is performed by the MCP tool. The project's
integration driver independently verifies source snapshot hashes.

Optional `expected_sha256` guards the exact ELF file. The file hash is checked
against the helper's view and again after lookup to reject concurrent changes.

## Installation and ownership

Pause PCSX2 first, then call `pcsx2_breakpoint_source` with the same parameters.
It requires the `source_breakpoints` capability. The explicit ELF path must match
the running EE local/`host:` path and its PCSX2 CRC. Source addresses are already
linked addresses; native installation rejects noncanonical aliases.

The native `install_source_breakpoints` command validates process/session/ELF/CRC,
all addresses and every existing breakpoint before installing on the CPU thread.
ELF reset commands cannot interleave with that operation. Any existing target
breakpoint, including disabled/conditional/temporary ones, rejects the whole group.
The tool does not pause/resume the VM or modify an existing breakpoint.

The response contains `group_id`, addresses, exact source metadata and file SHA256.
Use that ID with `pcsx2_remove_source_breakpoints` while the VM is paused. Native
groups are process-local, limited to 256, and retain session/ELF identity. Cleanup
refuses a different running ELF/session, preserving the current breakpoint list.
Returning to the matching ELF in the same session can permit cleanup.

Group ownership uses an internal marker and recorded addresses. Legacy MCP
set/remove/clear commands relinquish ownership of touched addresses. A breakpoint
that disappeared is skipped; a replaced, disabled, conditional, stepping, temporary
or differently described breakpoint is preserved. An incomplete removal reports
the preserved addresses as a tool error and releases that group's metadata: those
addresses need explicit user review, not clear-all cleanup. External UI/clients
can still interfere; markers are an ownership aid, not an authentication boundary.

On cancellation or an uncertain response after an installation request, the Node
layer attempts group-specific cleanup. Native identity/ownership checks remain in
force. If cleanup cannot be confirmed, the error includes the pending group ID.
A native validation rejection is definitive and needs no compensating mutation.

## Build and validation

Reapply `tools/apply-debug-server.py`, rebuild PCSX2, then run `npm test` in the
Node server. The current suite has 50 Node tests plus five Python path-index
tests. The latter use only the standard library:

```text
python -m unittest discover -s test -p dwarf_lines_test.py
```

Optional live test (run from `pcsx2-mcp-server`):

```text
node test/source-breakpoint-live.mjs <patched-PCSX2> <debug-ELF> <source-file> <line> <artifacts>
```

The test owns/stops its emulator, refuses an occupied port and saves a unique JSON
report. It checks exact-line hits after ELF reset without assigning the PC, empty
lines, SHA mismatch, stale-session rejection, 64-address bounds, user breakpoint
preservation, replacement ownership and changed-ELF refusal.

Validated on native Windows PCSX2 v2.6.3 / Direct3D 11 with Python 3.14 and pyelftools
0.33: Clang fixtures with DWARF 4 and 5 (including an inlined function's statement),
and the optimized GCC 3.2.3 DWARF2 SMS client. The project driver also validates
explicit snapshot mappings. DWARF3 is
accepted but not exercised by these live fixtures. Linux-host execution, IOP/IRX,
compressed/split DWARF, commercial games and physical hardware are not validated
for this extension. [Source stepping](source-stepping.md) is available separately;
locals remain a later stage.
