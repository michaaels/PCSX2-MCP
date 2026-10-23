# IOP runtime module observations

Later 5A2a adds separate [`pcsx2_iop_verify_irx` and `pcsx2_iop_source`](irx-source-association.md)
tools. They revalidate a selected candidate's relocated immutable image at one
pause before resolving sources. This legacy inventory and frozen exception
reports keep their original null artifact/source identities. Full load-file
provenance and module lifetime are still pending; see the separate contract.

Rebuild PCSX2 with `tools/apply-debug-server.py`, rebuild the Node server and
restart the MCP server/client. Capability: `iop_module_snapshot`. Tool:
`pcsx2_iop_modules`, with an optional `address` string. The VM must already be
paused, with no active source/frame operation. Inspection never pauses, resumes,
installs breakpoints or writes guest memory. Process/session, EE boot ELF/CRC,
execution epoch and IOP CPU-reset epoch are guarded on the native CPU thread.

```json
{"address":"0x000450a4"}
```

This address is an example from the isolated fixture, not a fixed location for
other programs. Omitting it returns the observed table without an association.

## Source and bounds

The integration observes the list location when upstream
`IopBios.cpp` / `RegisterLibraryEntries_HLE` publishes
`CurrentBiosInformation.iopModListAddr`. It uses the record layout read by
upstream `BiosDebugData::getIOPModules`: next pointer, name pointer, 16-bit version,
entry, GP, text address, text/data/BSS sizes. The contiguous section ranges follow
upstream debugger `ModuleModel::data`. No fixed BIOS address is assumed. This
depends on the pinned upstream locator/layout, not universal BIOS/runtime support.

The MCP owns its locator and clears it on VM start/reset and `psxReset`.
Before another observed publication, snapshots return unavailable with
`loadcore_list_not_located_since_reset`. The discovery sequence counts locator
publications, **not module loads or generations**. Guest software reboot
(`SifIopReset`), unload/reload and save-state restores are not lifetime guards.
A valid-looking table read after those operations is still an observation only.

All traversal and metadata reads occur on the CPU thread while paused:

- At most 256 records; aligned 40-byte records/root words in canonical IOP RAM
  below 2 MiB. Aliases, MMIO, wraparound, invalid reads and cycles are excluded.
- Names are at most 127 printable ASCII bytes plus a terminator, with a
  128-byte read bound. Null name pointers become null, never invented names.
  Name storage may be canonical IOP RAM or the checked 4 MiB boot-ROM window
  and its KSEG0/KSEG1 aliases. MMIO and RAM aliases remain excluded for names.
- An invalid/incomplete traversal returns `status: unavailable`, a reason and
  an empty module array. It does not supply a misleading partial inventory or
  infer that the runtime contains no modules. An observed empty list is distinct.
- Entry/GP and section metadata remain raw unsigned values. Unsupported section
  ranges are not wrapped or normalized into RAM for association.

Snapshots expose timestamp, snapshot ID, pause revision, VM/CPU identity,
locator/discovery sequence, root/head addresses and the bounded records. Their
scope is `paused_runtime_observation_only`. An ID or revision is not a module
lifetime token and cannot authorize later source/memory operations after resume.
The legacy `get_modules` command remains unchanged; use the new capability for
bounded observations and address association.

## Address association and identity limits

The Node server validates the entire observed pointer chain and evaluates
half-open text/data/BSS ranges. Only canonical IOP RAM addresses below 2 MiB are
associated. It reports:

| Status | Meaning |
|---|---|
| `matched_runtime_range` | Exactly one observed module declares a covering range |
| `ambiguous` | Multiple observed ranges cover it; all candidates remain explicit |
| `unmapped` | No eligible observed range covers it |
| `excluded_address` | Address is outside canonical IOP RAM; aliases are not normalized |
| `unavailable` | The runtime table could not be observed safely |

A match returns the record, segment, offset from runtime text start and segment
offset. These are not ELF file offsets or an automatically proven relocation
bias. Duplicate names/versions are not collapsed into one identity. Name, version
and range membership come from the guest table; they are not cryptographic proof
of the executing code, a local IRX file, a symbol/source map or fault cause.
`artifact_identity` and `source_mapping` remain null. The EE ELF/CRC is explicitly
`ee_boot_affinity_only`; never resolve an IOP PC through that ELF by default.

## Exception reports

When extended IOP exception collection still matches its frozen stop, it also
captures `module_observation`. This table is frozen automatically before report
polling, with that report's VM/CPU identity, and survives later resets together
with the report. No new live table is substituted when fetching old evidence.

`module_evidence` associates the independently verified JIT instruction PC when
available (`address_basis: verified_jit_instruction`). Otherwise it associates
the raw exception-entry address (`raw_exception_entry`), without calling it a
verified fault PC. The runtime match never repairs CP0/BD or creates source
provenance. Changed extended state, old native builds or the 3 MiB fallback may
omit this observation entirely. Unsafe tables retain explicit unavailable state
without discarding the CPU exception core.

The legacy `module_identity: null` and partial reason
`iop_module_identity_unavailable` remain: a runtime range is now identified when
possible, but complete artifact/source identity is still unavailable. Consumers
should inspect `module_evidence` for runtime membership and keep the report
partial rather than substituting the EE ELF or trusting a same-named IRX.

## Windows acceptance

The existing isolated SDK fixture loads its own resident IRX through real
`SifLoadModule`, then stops at an EE source breakpoint. No PC is assigned to fake
execution. Run from `pcsx2-mcp-server` with HostFs enabled only for this loader:

```powershell
node test/iop-exceptions-live.mjs <PCSX2> <fixture-directory> <artifacts>
```

The tested runtime exposed 25 records, root `0x000032b0`. The fixture record was
`0x00045000`, name `mcp_exception_fixture`, version `0x0101`, entry `0x000450f0`,
text `0x00045030`, sizes 400/48/16 bytes. Entry and BREAK offsets were contrasted
independently with the exact linked IRX. Normal/delay-slot BREAK reports matched
that runtime module. The genuine kernel syscall mapped to `Multi_Thread_Manager`,
not the fixture's IRX. These are run-specific addresses.

Thirteen IOP live checks passed, including paused/read-only inspection, stale
identity refusal, running-VM refusal, module association, automatic exception
capture/reconnect and report immutability, reset/software-reboot distinctions,
and locator invalidation on native CPU reset. Tests temporarily corrupted a next
pointer into a cycle, a next pointer into MMIO and a name pointer into MMIO.
Each produced unavailable evidence without a module match, and original guest
bytes were restored before resuming. The portable HostFs INI was restored byte
for byte. No BIOS or game assets are included in public fixtures.

The next step is binding an exact local IRX artifact to an observed load with
evidence that accounts for relocations, then guarded source lookup. Load
generations, source breakpoints/variables for IOP, non-ASCII module names, broader
BIOS coverage, Linux host and physical PS2 acceptance remain pending. This
delivery does not modify SMS/Bridge/decoders or validate playback/audio.

Windows native/TypeScript builds and 91 Node tests passed. Regressions added
16 EE exception checks, 10 progress checks and 11 source-step checks: 50 live
checks total. Pristine upstream integration, upgrading commit `7db45ed` and
reapplying matched all 14 native sources. Local evidence under
`release/iop-modules-validation`:

- `live/iop-exception-gr1Zze/validation.json`
- `ee-regression/exception-iJRYl0/validation.json`
- `progress-regression/progress-UqpPyU/validation.json`
- `step-regression/source-step-Swjr8C/validation.json`
- `integration.json` and `acceptance.json`: integration, source/binary/IRX hashes.
