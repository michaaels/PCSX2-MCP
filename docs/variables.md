# Current-frame variables (EE)

`pcsx2_variables` inspects arguments and locals in the **current physical EE
frame**, while paused. It reads the loaded local debug ELF, its DWARF metadata,
GPRs and bounded RAM. It does not pause/resume, change registers/memory, install
breakpoints, or evaluate arbitrary C/C++ expressions.

Rebuild Node and the native PCSX2 patch (`variable_inspection` capability), then
restart the MCP client. Install the optional pinned Python/pyelftools backend
described in [source breakpoints](source-breakpoints.md). This tool does not need
addr2line. ELF32 little-endian linked MIPS, embedded uncompressed DWARF2–5 is the
initial format subset; `.debug_info` and `.debug_line` are required and
split/supplementary debug files are not followed.

```json
{"frame_index":0,"names":["argc","argv"],"max_bytes":512}
```

Omit `names` to inspect available arguments and locals in active scopes. IDs and
scope IDs distinguish shadowed names. An explicit name with no matching DIE in
the active scopes appears in `missing_names`; the tool cannot infer names removed
entirely by the compiler. Global enumeration is not implemented, but local static
variables with an address location can be read.

## Supported subset

| Area | Support |
|---|---|
| Frame | Index 0 only; physical function containing the stopped PC. No caller-frame register reconstruction/unwinding. |
| Scope | Concrete function and active lexical-block address ranges. Active inline scopes are reported as unsupported, without inventing inline variables. |
| Locations | Embedded expressions and PC-selected location lists, CU bases/base-selection entries, absolute ranges and default locations. Overlaps are rejected. Returned list expressions include their selected `valid_range`. |
| Registers | DWARF GPR 0–31, using the relevant low bytes of native 128-bit values. Floating/VU register locations are unsupported. |
| Frame base / CFA | Supported frame-base expressions; current CFA from `.debug_frame` register-plus-offset rules. No general CFI expression evaluator or `.eh_frame` fallback. |
| Expressions | `addr`/resolved `addrx`, `regN`/`regx`, `bregN`/`bregx`, `fbreg`, `call_frame_cfa`, integer literals/constants, plus/minus, `plus_uconst`, bounded dereference and final `stack_value`. Numeric `const_value` is also supported. |
| Scalars | 1/2/4/8-byte signed/unsigned integers, address/boolean/char encodings, float32/64. Decimal values are strings, preserving uint64 precision. NaN/infinity are strings. |
| Pointers | 32-bit values; following is opt-in. Null pointers are explicit. |
| Aggregates | Qualifiers/typedefs, structures with constant member offsets, one-dimensional contiguous arrays with constant zero-based bounds. Depth/children/node limits apply. |

Pieces, entry/implicit values, GNU location views, `start_scope` attributes,
dynamic/strided arrays, descriptor data locations, unions, enums, bitfields and
general C++ layouts are unsupported. Omitted inheritance makes a structure
partial; bitfields have an explicit member status. Unsupported metadata or
operations never turn into zero values.

Known function entries, marked prologues, declaration-line prologues without an
end marker, and marked epilogues suppress runtime values with an explicit status.
Older GCC emits register locations spanning whole functions without a precise
prologue marker. Beyond the conservative checks, validity follows the compiler's
DWARF and is reported as `compiler_reported`, with a warning when markers are
absent. This cannot prove that every optimized legacy location is accurate during
unmarked prologues/epilogues or that a C object has been initialized. The values
are interpretations of the observed storage, not a proof of language-level validity.

## Snapshot consistency and RAM policy

The native `inspect_ee` command checks paused state and process/session/ELF/CRC/
execution epoch. It returns PC, all 32 GPRs and a pause-state revision. Subsequent
reads require that revision and PC; a resume, reset, or MCP register/memory/PC
write invalidates it, including same-value writes. Node also compares all GPRs
and verifies the ELF SHA256 again before the final guarded snapshot. Changed
state rejects the whole result instead of returning values from mixed frames.

SHA256 identifies the on-disk ELF. PCSX2 CRC is not cryptographic proof of the
bytes already loaded in RAM. Same-connection exclusivity prevents competing MCP
operations on that connection. This is not a lock on manual debugger edits or
all external processes: do not mutate emulator state concurrently from the UI.

Variable reads accept only canonical addresses in the first 32 MiB of EE RAM,
subject to DebugInterface validity checks. MMIO, ROM, scratchpad and aliases are
excluded by this initial policy. An excluded/invalid region returns a reason and
**no byte string**, so it cannot masquerade as zero-filled memory.

## Bounds and results

| Option | Default | Maximum |
|---|---|---|
| `max_variables` | 32 | 64 |
| `max_depth` | 2 | 4 |
| `max_children` | 16 | 32 |
| `max_nodes` | 128 | 256 |
| `max_bytes` | 1024 | 4096 |
| `follow_pointers` | false | Opt-in |

There are at most 64 memory requests. Dereferences in location expressions share
the same memory budget as values. Repeated identical reads use the cache. Failed
reads consume reservations; `bytes_requested` and `bytes_read` distinguish requested
from successfully returned bytes. `memory_requests`, `nodes` and `limits` accompany
the result. Metadata is separately limited to 256 variables/types, 32 members/type,
4096 CUs/ranges/location-list entries, 64 expression operations and 1 MiB output.
The Python subprocess has a 15-second timeout and accepts cancellation.

Inspect each variable/child's `status`, `truncated`, storage address/register and
hex value. `available` describes a decoded value; `partial` means children were
limited or unavailable. `location_unavailable` can mean optimization or missing
debug information, without asserting which. `not_live_at_pc` means no applicable
location-list interval. Unsupported expressions/registers/types, unavailable CFA,
invalid memory, budget exhaustion and prologue suppression have distinct statuses.
Cancellation stops further work; there is no VM mutation to undo.

## Validation

Windows PCSX2 v2.6.3 / Direct3D 11, native Python 3.14 and pinned pyelftools 0.33:

```powershell
python tools/build-source-fixture.py release/variables-test --wsl --variables --dwarf-version 5 --optimize 2
# From pcsx2-mcp-server; use absolute emulator/ELF/output paths:
node test/variables-live.mjs <PCSX2> <ELF> source-debug.c marker <artifacts>
```

The freestanding fixture reaches a real file/line breakpoint through a call,
never a manually assigned PC. DWARF4/5 (and Clang DWARF5 `-O2`) checks include:
argument 23, signed local -7, uint64 `0xfedcba9876543210`, array/structure fields,
pointer following, excluded/null pointers, truncation, active lexical scopes and
function-entry suppression. Independent RAM reads contrast decoded bytes. The
optimized computed local has an actual location-list interval. Tests also verify
state invalidation after same-value writes and same-ELF reset, bad SHA/frame
refusal, and unchanged PC/breakpoints during inspection.

In the optimized GCC DWARF2 SMS build, after the prologue at `main.c:40`, `argc=1`
and `argv=0x002be5c4` matched GPR16/17 and incoming GPR4/5. Those values identify
that run. At `main.c:39`, the tool withheld prologue values. Local reports are in
`release/variables-validation/*/variables-*/validation.json`.

Node tests cover expression/type decoding, budgets, cancellation and mixed-state
refusal; Python tests cover location intervals, missing/unsupported metadata and
lexical/inline scope selection. DWARF3 is accepted but lacks a live fixture. IOP,
caller frames, inline locals, host Linux and physical PS2 are not validated here.
