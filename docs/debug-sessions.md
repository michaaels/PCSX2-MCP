# Debug sessions

This extension adds six MCP tools on top of the existing memory, breakpoints,
stepping and screenshot tools. Both the TypeScript server and native PCSX2 patch
must be rebuilt. Pine-only and original release binaries do not provide these features.

## Tools

| Tool | Behavior |
|---|---|
| `pcsx2_capabilities` | Returns protocol version, session number, current ELF/CRC and supported session features. |
| `pcsx2_read_events` | Reads history using `after` and `limit`. Returns `next_cursor` and an explicit `dropped` flag. |
| `pcsx2_wait_event` | Waits for an event, optionally filtered by type, for up to 30 seconds. Does not resume execution. |
| `pcsx2_read_logs` | Reads console history, optionally filtering by substring and numeric severity. |
| `pcsx2_load_elf` | Requests an ELF override and VM reset for an absolute path on the emulator host. Requires an active VM. |
| `pcsx2_capture_context` | Captures registers, PC, backtrace, optional memory, ELF/CRC, recent logs and a GS screenshot while paused, then restores the previous running/paused state. |

Event types: `vm_started`, `vm_stopping`, `paused`, `resumed`, `breakpoint`,
`watchpoint`, `elf_load_requested`. Breakpoint/watchpoint events identify EE or IOP
and the stopped PC. They are wired into both interpreter and recompiler handlers.
They do not contain the accessed memory address. Exception events are not implemented.

History is not consumed by reading it. Start with `after: 0`, then pass
`next_cursor` as the next `after`. **Waiting with `after: 0` can return historical
events.** Read events to obtain a cursor before resuming if you need the next hit.
Filters consume the scanned page, including nonmatching entries. Wait results return
all matching events in the last scanned page and its cursor. `timed_out: true`
means no matching event was observed before the deadline. Cancellation is checked
between native long-polls; a queued/native command may finish before cancellation
is reported. Transport commands retain their own ten-second timeout.

The native event ring holds 512 records. The console ring holds 2,048 records,
with each message limited to 2,048 bytes and truncation marked explicitly.
Page limits are 1–200. Sequence numbers increase over the emulator process lifetime;
`session` increments on VM initialization. Unix timestamps use milliseconds.
History can be overwritten: inspect `dropped`, including when filtering/waiting.
Do not reuse a cursor across a restarted emulator process.

Logs use an independent atomic observer, preserving existing GUI/file log sinks.
They capture INFO, WARNING and ERROR messages after DebugServer startup. Existing
PCSX2 messages sometimes encode severity through color while using INFO internally;
`max_level` filters the numeric logging level, not those colors. EE/IOP guest output
requires **Enable EE Console** and **Enable IOP Console** in PCSX2's logging settings.
Keep an existing logging sink (for example file logging) enabled so PCSX2 activates
those guest channels.
The reported source is `console`; CPU attribution is not guessed from text or color.
There is no direct DEV9 packet capture or external Bridge log collector yet.

## Example workflow

1. Start the patched PCSX2 and boot a VM, then call `pcsx2_connect` in debug mode.
2. Call `pcsx2_capabilities` to check support and the loaded ELF.
3. Reload a build using `pcsx2_load_elf` with, for example,
   `{"path":"D:\\dev\\PS2\\project\\build\\game.elf"}`.
4. Set a breakpoint using existing tools. Read events, retaining `next_cursor`.
5. Resume; call `pcsx2_wait_event` with that cursor and `type: "breakpoint"`.
6. Call `pcsx2_capture_context`:

```json
{
  "cpu": "ee",
  "width": 960,
  "height": 720,
  "memory_address": "0x00100000",
  "memory_length": 256,
  "output_directory": "D:\\debug-artifacts"
}
```

The tool returns JSON and an MCP image. With `output_directory`, it creates a unique
`pcsx2-context-*` subdirectory containing `context.json` and `frame.png` without
overwriting existing captures. JSON excludes the base64 image. These files contain
the requested memory and logs; choose the capture range and output location accordingly.

If no frame exists, useful CPU context is still returned with `complete: false`
and a screenshot error. Running/paused state is restored even on that path. All
CPU snapshot fields are collected in one CPU-thread operation, with the GS synchronized
while paused. Log entries are a recent history rather than part of that CPU instant.
Screenshot limits remain 1–1280 by 1–1024 and 6 MiB of PNG data. Optional memory is
limited to 4,096 bytes. Backtraces depend on the existing native stack walker.

An ELF load checks existence and a 32-bit little-endian MIPS ELF header before
requesting the override. Success means **reset requested**, not application readiness;
inspect the current ELF/CRC and logs or use a breakpoint at the entry point. PCSX2's
achievement/hardcore constraints still apply. Breakpoints and save states can become
invalid across different builds. This tool does not launch a stopped emulator.

## Build and checks

```text
python tools/apply-debug-server.py path/to/pcsx2-v2.6.3
cmake --build path/to/build --target pcsx2-qt
cd pcsx2-mcp-server
npm ci
npm test
```

The integration script validates its edit points before writing. It adds the server,
VM lifecycle/state hooks, six breakpoint hooks, and a separate console observer API.
Running it again preserves content and timestamps for unchanged files. Upstream
source/license notices remain intact.

Automated tests use a mock native server and actual MCP stdio. The optional live
test starts and stops **its own** emulator process and refuses an occupied debug port:

```text
node test/session-live.mjs path/to/pcsx2-qt.exe path/to/homebrew.elf path/to/artifacts
```

For the no-frame path, append `--null-renderer`. That mode temporarily changes the
portable runtime's renderer setting and restores the INI afterward. It requires a
configured portable INI and BIOS. Do not run other emulator instances sharing that
configuration during this test. Test artifacts and BIOS are not committed.

### Validation performed

Native Windows build: PCSX2 v2.6.3, MSVC 19.51, Qt 6.12.0, Direct3D 11. Tested:

- Running and paused context capture; matching register/status PCs and selected memory.
- State restoration and repeated identical frames while paused.
- Console observer and cursor pagination.
- Missing/invalid ELF rejection before reset.
- Reloading an ELF path containing spaces and Unicode.
- Real EE instruction breakpoint and write watchpoint events, including waiting before resume.
- Overwriting the 512-event ring and explicit dropped-history reporting.
- Context JSON, PNG and unique artifact folders through real MCP stdio.
- Null renderer: partial contexts preserve both running and paused states.

The interpreter and IOP hooks compile but have not yet been exercised by this live
test. New session tools have not yet been validated on Linux, commercial games,
D3D12/Vulkan, or physical PS2 hardware. Automatic emulator launch, exception events,
source symbols/DWARF, frame/input automation and scenario runners remain future work.
