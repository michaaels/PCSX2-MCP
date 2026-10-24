# SMS incident context: 5B2b

Validated on Windows on 2026-10-24 against the user's Jellyfin 12.2.0 Linux
server. The recipe joins an actual EE stop, matching ELF/source metadata,
read-only object observations and subsequent SMS console/Bridge receipt fields.
It uses existing MCP tools and adds no public global-variable API or native
capability. The fixture supports the SMS `update_path_failed` case only.

## Repeat

From `D:\dev\PS2\ps2_multinet`, with a new output folder:

```powershell
rtk python tools/validate-diagnostic-transport.py --bridge-env artifacts/linux-jellyfin/bridge.env --bind <host-LAN-IPv4> --output artifacts/debug-validation/<new-incident-run> --incident
```

Requirements: [fresh transport acceptance](project-diagnostics.md#5b2a-fresh-sms-transport-acceptance),
the retained debug manifest/ELF/source snapshot, patched PCSX2 and the user's
BIOS. [Source breakpoints](source-breakpoints.md) require pinned Python/pyelftools;
address-to-source uses the configured addr2line backend (WSL in this run).
No runtime, retained build or source configuration is replaced.

For direct `test/project-transport-live.mjs` invocation,
`PCSX2_TRANSPORT_INCIDENT=update_path_failed` selects this recipe; other values
refuse before launch. The project wrapper clears inherited incident mode when
`--incident` is absent. The normal four-check transport path remains available.

## Evidence sequence

1. Verify the snapshot source SHA against its manifest and locate both explicit
   updater path guards. Pause the owned emulator; install exact-line groups
   through `pcsx2_breakpoint_source`. Resume and require a real stop at one of
   those addresses, with exact line confirmation through `pcsx2_source_pc`.
2. Resolve the two updater statics from DWARF in the hash-checked ELF. Strictly
   read the first path byte and disabled flag in canonical EE RAM. Match loaded
   guard instructions to ELF bytes; decode the byte load and its actual base
   register to require an effective address equal to the DWARF object.
3. Collect pre-emission diagnostics: one boot, no selected ERROR yet. Remove
   both owned source groups and install an owned logger-entry breakpoint.
   Resume; require `a0` to reference a bounded terminated `update_path_failed`
   string. Check logger/call bytes, the direct JAL at `ra-8` and source equality
   with the captured guard.
4. Call `pcsx2_capture_context` and `pcsx2_iop_modules` while paused. Verify
   process/session/EE epoch, PC and cycles remain stable. Save register/backtrace
   observations and IOP inventory to local `incident.json`, excluding raw recent
   console messages and image payloads.
5. Remove the owned logger breakpoint, resume explicitly, collect and correlate.
   Require exactly one subsequent ERROR console/Bridge receipt for the captured
   boot and client sequence. The validation receipt joins their correlation SHA
   to the incident SHA.

The recipe pauses/resumes and owns its breakpoints. It never assigns PC, writes
guest code/registers/data, injects logs or invokes update installation. Pauses
perturb execution: this is not an uninstrumented latency/performance measurement.
Cleanup stops only the owned emulator and child Bridge/UDPFS; Linux Jellyfin
remains running.

## Legacy static metadata

This GCC emits both statics as local `STT_NOTYPE`/size-zero symbols, omitted by
PCSX2's imported global database. The fixture does not guess their types/extents.
`test/fixtures/sms-incident-objects.py` requires exactly one direct CU variable
per name in `SMS_JellyfinUpdate.c`, a five-byte `DW_OP_addr` location and fixed
proven type sizes: 128-byte char array and four-byte flag. Both must lie in a
writable PT_LOAD memory range below 32 MiB and agree with unique symtab values.
The report preserves DIE/location/type provenance and the symtab limitation.

The helper hashes the ELF (max 256 MiB), bounds section/CU/DIE/symbol/type
traversal and uses isolated pinned Python with a 15-second timeout and 1 MiB
output bound. Unsupported/missing/ambiguous metadata fails. This is a fixture
for two objects, not generic expression evaluation or a DWARF-global MCP tool.

## Observed result

| Evidence | Final run |
|---|---|
| Build / boot | `7a4a8cee9f5f9008` / `26102414324411c7` |
| ELF SHA256 | `6d6e7f689ab82c1c1109c29be5ba0bb5f38f897a774b17fe612dd1c1e911b321` |
| Guard | `SMS_JellyfinUpdateCheck`, `src/SMS_JellyfinUpdate.c:118`, PC `0x00104fb0` |
| Byte load | `0x80433da0`, `v0=0x002d0000`, effective address `0x002d3da0` |
| Update directory | DWARF size 128; first byte `00`, an empty C string |
| Disabled flag | `0x002d3e20`, DWARF size four, value `00000000` |
| Logger | PC `0x00100678`; `a0=0x0019d908`, `update_path_failed` |
| Caller | Verified JAL `0x00104fc4`, return `0x00104fcc`, same source line/function |
| Receipt | One ERROR at client sequence 3, matched console/Bridge fields |
| IOP | 45 runtime modules observed; no IRX artifact/source identity inferred |

These are observations for this ELF, not hardcoded recipe coordinates. The
immediate emission path is verified for this HostFs boot: the empty-directory
guard in `SMS_JellyfinUpdateCheck` calls the logger. The USB-only updater path
policy is consistent with that state. This does not diagnose physical
`E11 SifInitRpc` or intermittent audio, validate an updater fix, or identify the
origin of every historical event with the same name.

Native backtrace frames are observations, not a proven complete call chain;
the verified direct JAL supplies caller evidence. IOP inventory is contemporaneous
context, not a cause or IRX binding. The generic correlator retains
`root_cause:not_established`, unbounded clock uncertainty and unknown latency.
No playback/A/V/hardware acceptance was added. The context tool had a frame;
this recipe retains its metadata, not a saved image/visual-content assertion.

## Validation and evidence

Eight incident live checks and four normal transport regressions passed.
Four offline controls reject wrong ELF SHA, different compilation-unit name,
conflicting DWARF/symtab addresses and truncated ELF. Malformed copies were
never launched; the retained ELF hash stayed unchanged. Node/Python syntax
and document links checked. Core source/build hashes retain the previous
174-test Node baseline; unchanged TypeScript/native/Bridge builds and
historical suites were not repeated.

| Evidence | Ignored local path |
|---|---|
| Incident/services validation | PS2 project `artifacts/debug-validation/incident-20261024-accepted/services.json` and `sms/validation.json` |
| CPU/source/object/module observations | Same folder, `sms/incident.json` |
| Normal transport regression | PS2 project `artifacts/debug-validation/incident-transport-regression-20261024/` |
| Four metadata refusals | MCP `release/incident-metadata-20261024/validation.json` |
| Source/build/evidence hashes and publication | MCP `release/project-incident-acceptance-20261024.json` |

Local artifacts can contain native ELF paths/runtime inventory; keep them
private. Published documentation excludes endpoints, tokens and raw journals.
5B2b closes for this HostFs incident. The subsequent
[6A visual regression](visual-regression.md) supplies pixel tolerances/regions;
next is 6B audio criteria. E11/audio/hardware, broader incident recipes,
playback-manager/wire metrics and clock calibration retain separate acceptance.
