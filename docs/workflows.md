# Symbols and repeatable debug scenarios

The native PCSX2 patch and Node server must both be rebuilt for this extension.
It adds five MCP tools:

| Tool | Behavior |
|---|---|
| `pcsx2_import_symbols` | Explicitly requests asynchronous import of symbols for the current EE ELF. |
| `pcsx2_lookup_symbols` | Finds functions/global variables by substring or exact name, with pagination. |
| `pcsx2_resolve_address` | Returns functions/global variables containing an address, with offsets and optional source filenames. |
| `pcsx2_breakpoint_symbol` | Resolves an exact function name and installs its breakpoint on the CPU thread. |
| `pcsx2_run_scenario` | Executes a bounded recipe and saves a JSON report, screenshots and failure context. |

## Symbol workflow

PCSX2 normally imports symbols when the graphical debugger is open. For MCP-only use,
boot an ELF, call `pcsx2_import_symbols`, then query for an expected symbol until it
appears. The import response means **requested**, not completed. Repeat after ELF
reload if automatic import is disabled. This operation uses PCSX2's own importer,
forces ELF symbol import in a temporary options copy and skips function scanning and
hashing. Persistent settings are unchanged; configured extra symbol files/import
filters and source-clearing rules still apply. Explicit import is available for EE;
IOP tools query whatever symbols PCSX2 has already generated/imported for that CPU.

The tools read the native `SymbolGuardian` under its shared lock on the CPU thread.
They expose the imported/analysed database, not an invented symbol map. Names are
case-sensitive, and exact matching uses the displayed name (which may be demangled
by PCSX2). `kind` is `function`, `global` or `all`; `limit` is 1–100. Continue with
`next_offset` while `has_more` is true. Imports can change the database between pages;
wait for the expected symbols before treating pagination as stable.

For example:

```json
{"query":"main","kind":"function","exact":true,"cpu":"ee"}
```

`pcsx2_breakpoint_symbol` takes `{"name":"main","cpu":"ee"}`. Multiple distinct
addresses with that exact name are rejected; select an explicit address instead.
Like the existing breakpoint setter, it can enable an existing breakpoint. Resolution
and installation happen within one CPU-thread operation so an intervening ELF reset
cannot change the symbol target.


Address resolution returns up to 100 overlaps. It does not guess a nearest function
when the address lies outside its declared range. Zero-size symbols match only their
starting address. `source_file` is populated only when the database has that information.
**Source line numbers, DWARF evaluation, local variables and source stepping are not
implemented.** Stripped release ELFs may contain no names; retain an unstripped debug
ELF or configure a matching external symbol file in PCSX2.

## Scenario workflow

Boot the ELF and wait for its current ELF/CRC and graphics readiness first. Pass the
recipe inline to `pcsx2_run_scenario`, along with an artifact directory:

```json
{
  "scenario": {
    "name": "memory-smoke",
    "steps": [
      {"action":"frames","frames":7},
      {"action":"assert_expression","expression":"1 + 1","equals":"2"},
      {"action":"input","buttons":["cross"],"frames":2},
      {"action":"assert_controller","buttons":[]},
      {"action":"screenshot"},
      {"action":"context"}
    ]
  },
  "output_directory":"D:\\debug-artifacts",
  "timeout_ms":30000
}
```

A reusable recipe is provided in [examples/smoke-scenario.json](../examples/smoke-scenario.json).
It checks controller neutral state after input; change that assertion if the initial
controller state deliberately holds buttons or non-neutral sticks.

Each run creates a unique `pcsx2-scenario-*` directory containing `scenario.json` and
`report.json`. Step images and contexts use fixed step-number prefixes. A failed run
also attempts `failure-context.json` and `failure-frame.png`. An unavailable renderer
can still produce a partial CPU context; the report preserves that limitation.

| Action | Main parameters and assertion |
|---|---|
| `frames` | `frames` 1–600; requires completed video execution. |
| `input` | Same buttons/raw analog options as `pcsx2_input`; requires completion and restores the prior controller state. |
| `assert_memory` | `address`, `expected_hex`, optional `cpu`; exact 1–4096 byte comparison. Strict reads reject unmapped bytes instead of treating them as zero. |
| `assert_expression` | `expression`, `equals`, optional `cpu`; compares the native hexadecimal result as unsigned 64-bit, avoiding JavaScript number precision loss. |
| `assert_log` | `contains`; requires a matching console message captured after scenario setup. |
| `assert_controller` | Exact digital combination/raw analog positions for `controller` 0/1; defaults to neutral. |
| `run_to_symbol` | Exact `symbol`, optional `cpu` and `timeout_ms`; waits for a real instruction breakpoint. |
| `run_to_address` | `address`, optional `cpu` and `timeout_ms`; same run-to behavior. |
| `screenshot` | Optional `width`, `height`, `expected_sha256`; saves PNG and its SHA256. |
| `context` | Optional CPU, image bounds and memory address/length; saves context JSON and PNG, requires an available frame to pass. |

Addresses are hexadecimal with optional `0x`. Expression expectations are decimal or
`0x` hexadecimal strings, not JSON numbers. Screenshot hashes compare exact encoded
PNG bytes; there is no visual-tolerance, mask, perceptual or audio comparison yet.

The runner pauses before setup and **leaves the VM paused** on completion/failure.
It stops at the first failure, so later actions do not run. It checks process/session,
current ELF path and CRC between steps; an optional `expected_elf_crc` in the recipe
rejects the wrong build before changing VM state. CRC is not a cryptographic build
identity; the launch tool separately returns the input ELF's SHA256.

Run-to actions create and remove only their own non-temporary breakpoint. If an
existing breakpoint occupies the target, the action fails without changing it. If
already at the target, it succeeds without resuming or touching any breakpoint. A
different breakpoint hit or timeout fails the action and preserves failure context.

The client connection is held exclusively for the run. Other commands on that same
connection are rejected; external UI/native clients can still interfere. Avoid such
interference, input recording, physical controller changes and unrelated frame
automation during a scenario. The runner does not launch, reload, write guest memory,
run builds, execute shell commands or dispatch arbitrary MCP tool names.

Log assertions consider messages since setup, not pre-existing boot history. The log
cursor is bounded; overwritten history or more than 4096 newly scanned messages fails
the run rather than silently dropping evidence. This does not collect external Bridge
logs or DEV9 packets.

Recipes contain 1–64 strictly validated steps. The run deadline defaults to 30 seconds,
maximum 45 seconds. Run-to waits default to 10 seconds, maximum 15 seconds. Cancellation
and deadlines are checked between operations and passed to native waits/frame operations.
An already running native command, artifact I/O or diagnostic/cleanup work may outlast
that deadline. Failures to capture diagnostics or confirm final pause appear explicitly
in the report. Invalid recipe/output-directory errors before execution may return only
a tool error because no run could be created.
If an ELF/session identity change is detected, the runner skips further pause,
diagnostic capture and breakpoint removal against that changed VM. The report marks
`vm_changed` and any `pending_breakpoint` needing review; final pause is not claimed.

## Build and validation

Run `python tools/apply-debug-server.py <pcsx2-v2.6.3>`, build PCSX2, then build/test
the Node server with `npm test`. The suite contains 36 automated tests at this stage.
New native commands are `import_symbols`, `lookup_symbols`, `resolve_address`,
`breakpoint_symbol`, and strict `read_memory` (`strict:true`, returns `invalid_bytes:0`
or an error). Native capabilities include `symbols`.

Optional live check:

```text
node test/workflow-live.mjs path/to/pcsx2-qt.exe path/to/symbol-bearing-SMS.elf path/to/artifacts
```

Validated on Windows, PCSX2 v2.6.3 / MSVC 19.51 / Qt 6.12.0 / Direct3D 11:

- Explicit symbol import without the GUI debugger, including function/global lookup,
  pagination and exact address offsets.
- Missing symbol rejection without breakpoint changes, and a real function-name
  breakpoint at the ELF entry.
- A scenario from the entry point to `main`, expression assertions, new-log assertions,
  and removal of its owned breakpoint.
- Video steps, controller input/restoration, memory assertions and PNG/context artifacts.
- Intentional failure, stopping subsequent actions, diagnostic context and final pause.
- Wrong-build refusal, plus native rejection of unmapped strict memory reads.

The existing SMS release artifacts are stripped. For this live check a **test copy**
restored 36 global function/object symbols from that same build's `SMS.map` and
`main.o`, `SMS_Jellyfin.o`, `SMS_Config.o`. `tools/make-symbol-fixture.py` writes this
metadata-only fixture and verifies every PT_LOAD byte is unchanged. It does not rebuild
SMS, add line information or change its executable code. Its map/object inputs must
be from the same build; matching an arbitrary map to an ELF is not proven by the script.
Prefer retaining an original unstripped ELF in a normal project build pipeline.

Native ambiguity handling, IOP symbol queries and optional source filenames compile
but were not exercised by this live fixture. Linux, other graphics renderers, commercial
games and physical PS2 hardware remain unvalidated for this extension. Full source-line
debugging, richer visual assertions, GS/audio/performance diagnostics and hardware
backends remain separate work.
