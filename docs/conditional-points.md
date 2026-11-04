# Atomic conditional points and CPU selection — S4a

Update 2026-11-03 / S4b1: [actual Qt IOP in-flight ownership](iop-qt-ownership.md)
is now accepted for the IRQ-isolated fixture. The same delivery corrects native
cross-CPU breakpoint snapshot/ownership leakage. Seven new groups and 74 native
regressions passed; the source-step GUI replacement remains next. Earlier scope
statements below describe their original deliveries.

Validated on Windows with modified, pinned PCSX2 v2.9.147. Both native and Node
must be rebuilt/restarted. The six basic breakpoint/watchpoint MCP tools now
accept `cpu:"ee"|"iop"`, defaulting to EE. This selects the point table and native
expression context; emulator pause/resume remains shared between the CPUs.

```json
{"cpu":"iop","address":"0x00010000","condition":"t0 == 0x42","description":"IOP control"}
```

Use that shape with `pcsx2_set_breakpoint`; use `pcsx2_list_breakpoints` with
`{"cpu":"iop"}` and `pcsx2_remove_breakpoint` with the same CPU/address.
`pcsx2_set_watchpoint`, `pcsx2_list_watchpoints` and `pcsx2_remove_watchpoint`
select their CPU the same way. Watchpoint ends are exclusive, default to
`start + 4` and must be above start within 32 bits. Addresses are hexadecimal strings
of at most eight digits, optionally prefixed `0x`.

## Error behavior and ownership

The previous native implementation called `AddBreakPoint`/`AddMemCheck` and
changed descriptions/actions before attempting to compile the expression. It
ignored parser failure and returned `ok:true`. An invalid `(` could therefore
create an unconditional point or alter an existing point. Source-group
ownership could also be relinquished before the failed compilation.

Native now compiles a nonempty condition **before** any point insertion,
ownership relinquishment, enabling or option/description mutation. Parser
failure returns `ok:false`; public MCP tools expose `isError:true`. Existing
points and both paused CPU contexts remain unchanged. ASCII/UTF-8 conditions
are bounded to 4096 bytes in native and MCP; exact-boundary ASCII was accepted.
Native also refuses non-string condition values before mutation instead of
silently treating them as omitted conditions.
The expression language/evaluation rules remain those of the selected native
debugger. Grammar validation does not prove that every expression can evaluate
successfully in every future machine state.

Conditional MCP setters require native capability `atomic_point_conditions`.
Against an older build they refuse before dispatching a mutation; unconditional
set/list/remove remain available. The old direct DebugServer protocol still
needs the native update: this Node guard does not repair an old emulator.
An omitted/empty condition retains the existing setter behavior; it is not a
new API to remove a condition. Valid explicit point edits/removals can replace
user points, whereas source-group cleanup uses its separate ownership contract.

## Point inspection

Native inventories now report watchpoint conditions and raw `memory_condition`
and `result` flags. Both point inventories expose supported configuration:
`options_available`, `max_hits`, `instrumentation_enabled`, `log_format` and
`continue_on_hit`. Public MCP lists show conditions, nonzero max-hit limits and
enabled logging configuration. An older native struct reports unavailable
options rather than invented values. Raw result flags should be interpreted
with the pinned core, not assumed to equal the MCP action enum.

Execution-point inventories omit volatile hit counters, preserving stable
configuration comparisons across actual hits. Watchpoint hit counters retain
their existing behavior. This delivery read actual native defaults and the
nondefault logging enabled by MCP `action:both`; it does not claim actual Qt
max-hit/custom-format edits merely because those fields can be displayed.

## Verification

TypeScript and **295 Node tests** passed. Six added groups cover CPU routing,
EE compatibility, capability refusal before mutation, native-error forwarding,
UTF-8/address/range bounds, disconnected sessions and option formatting.

The new harness passed **13 native/MCP groups**: exact resident IRX relocation
and instruction bytes, actual CPU schema discovery, rejection of invalid new/
existing execution/memory points on both CPUs, byte limits, all six public tools,
false conditions that keep executing, true conditions that stop at exact
PC/register values and preservation/removal of the original source-group owner.
IOP instruction controls use the fixture's explicit IRQ-isolating path; the
separate IRQ-enabled regression also passed.

An unchanged F5b executable reproduced the old false-success/mutation behavior
in **three negative-control groups** (eight offending requests). With the
updated Node server, **four additional groups** against that old executable
proved capability refusal and retained unconditional EE/IOP tools. A separate
runtime directory supplies the old executable's required DLLs; launching the
backup alone failed before connection and is excluded.

The final build also passed **60 standalone**, **six native DAP** and **eight
savestate-movie** regression groups. Thus 87 acceptance groups used the new
native executable, plus four compatibility groups used the prior executable;
the three bug-reproduction groups are not positive acceptance. Owned native,
MCP and DAP processes closed. Integration matched 29 native files for pristine,
reapplication, previous-version upgrade and the build checkout.

```powershell
rtk proxy node pcsx2-mcp-server/test/conditional-points-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/instruction-fixture-20261024-final release/standalone-data release/conditional-points-new
```

The output must be new. Sources/build manifests are checked before launch;
the test uses its own ports, private INI/data root and bounded fixture PC writes.
No BIOS acquisition, application media server or physical PS2 is involved.

Ignored evidence:

- `release/conditional-points-accepted-20261102/validation.json`
- `release/conditional-points-baseline-accepted-20261102/validation.json`
- `release/conditional-points-legacy-accepted-20261102/validation.json`
- `release/conditional-points-standalone-accepted-20261102/validation.json`
- `release/conditional-points-dap-accepted-20261102/validation.json`
- `release/conditional-points-state-movie-accepted-20261102/validation.json`
- `release/conditional-points-node-20261102.log`
- `release/conditional-points-integration-accepted-20261102/integration.json`
- `release/conditional-points-delivery-20261102.json`

## Real Qt EE option matrix — U1/S4b

The [application GUI service](application-ui.md) now drives actual Qt controls
through MCP. Three fresh paused EE source groups were edited in the real
BreakpointDialog: condition `t0 == 0x42`, logging `GUI-LOG-S4`, and max hits 2.
The original MCP description marker and every other point option stayed intact.
Native cleanup preserved the exact edited point, removed only unchanged points,
and refused repeat group removal. Both CPU GPR/PC, identity, paused status and
256 sampled EE RAM bytes stayed unchanged. Actor: `mcp_qt_ui`.

Evidence: `release/application-ui-live-20261103-16/validation.json`, with PNGs
and queued/terminal action receipts. The earlier supervised preparation and
Computer Use failures remain historical, not prerequisites for this MCP route.
IOP in-flight ownership and source-step replacement remain next; this does not
establish universal stepping/generations or physical debugger support.
