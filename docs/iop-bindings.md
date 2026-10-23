# Revalidated IOP artifact bindings

5A3b, 2026-10-23. Requires rebuilt native PCSX2 and TypeScript, then an MCP
restart. Capability: `iop_module_generations`. This adds bounded, explicit
artifact bindings backed by **observed registration generations**, with fresh
verification at every use. Tracking covers the documented import paths; it is
not a universal proof that no custom loader or external writer has run.

## Workflow

1. Before the actual HostFs load, arm `pcsx2_iop_load_watch_start` for the
   loadable `0xff80` IRX. Stop at its first pause after registration, as in
   [load provenance](iop-load-provenance.md).
2. Call `pcsx2_iop_binding_create` with the candidate `irx` path (a matching
   debug companion is allowed), `module_record`, `load_watch_id`, optional
   `expected_sha256` and `ttl_ms` (100–300000; default 60000).
3. Retain `binding_id`. After resuming normally and pausing again, call
   `pcsx2_iop_binding_source` with that ID and optional `addresses` (1–64 runtime
   IOP addresses; default sampled PC). Every use reads and verifies the current
   artifact, module image and observed generation before and after source lookup.
4. `pcsx2_iop_binding_list` lists retained history/expiry/last invalidation;
   `pcsx2_iop_binding_drop` removes only the selected ID. Both work without an
   emulator connection and do not read guest memory.

Example fields, using IDs and addresses from your actual observation:

```json
{"irx":"D:\\build\\module.debug.irx","module_record":"0x00045000","load_watch_id":"0123456789abcdef0123456789abcdef","ttl_ms":60000}
```

```json
{"binding_id":"0123456789abcdef0123456789abcdef","addresses":["0x000450d8"]}
```

There are at most 16 retained entries in this MCP process. Capacity refuses
without evicting another unexpired ID; a later creation removes expired entries.
Drop unwanted invalidated entries explicitly. TTL uses the host monotonic clock,
including time spent paused. A Node/MCP process restart loses the registry;
reconnecting its DebugServer client can preserve entries when identity matches.
No binding starts/stops the guest, installs breakpoints or authorizes writes.

`retained` means stored, **not currently valid**. List output always says
`requires_fresh_paused_revalidation`. A source query while running asks for a
pause and keeps the ID retryable; cancellation also keeps it. A failed
revalidation permanently invalidates the entry. Restoring old file bytes or an
old numeric token does not revive it. Drop/expiry during a lookup prevents its
result from returning as a valid binding.

## Native observed generations

Paused module records add `module_id` and nullable `observed_generation`:

```json
{"scope":"observed_loadcore_registration","namespace":"123:1:456","sequence":42,"registration_epoch":12,"module_id":25}
```

The native server assigns a monotonically increasing sequence at an observed
loadcore-16 registration call. It captures entry/GP/text/data/BSS, name pointer
and version. A complete paused inventory must subsequently contain that record
with matching metadata; its module ID is then sealed. Later metadata/ID changes
revoke the observation. Invalid/incomplete inventories clear tracking, and a
complete inventory removes observations of records no longer present. Unknown
or preexisting modules stay null; names/addresses/hashes never manufacture a
generation. The cache is bounded to 256 records; overflow clears tracking.

The namespace includes native start time, session and a monotonic clock sample.
It separates server/process incarnations even if a PID/session/sequence is
recycled. It is an identity discriminator, not an authentication secret. The
namespace and sequence are host state, never restored from guest savestates.

Observed release/re-registration revokes that record's previous token. New
load attempts, modload services, reset/reboot, restore, changed locator and
DebugServer mutations conservatively clear all tracked tokens. Ordinary
resume/pause does not. Every native image request still guards current process,
session, execution/CPU-reset/lifetime epochs and pause revision. When given
`expected_registration_sequence`, it also requires the matching
`expected_registration_namespace` and checked record generation before returning
image bytes. Node bindings retain and send both; a number alone is insufficient.

The new modload entry observers cover ordinals **4, 5, 6, 7, 9, 10, 11, 19, 20,
21, 26 and 27**: reboot, supported load variants and stop/unload service calls.
They invalidate on entry even if the original function later fails. ReBootStart
also clears the locator and pending SIF observation. The original guest
functions always execute; the hooks do not replace loader/unload semantics.

Primary ABI references: PS2SDK
[`modload.h`](https://github.com/ps2dev/ps2sdk/blob/89b9d8cf249f927192c57804ce5e55e99e34002d/iop/system/modload/include/modload.h)
and [`xmodload.h`](https://github.com/ps2dev/ps2sdk/blob/89b9d8cf249f927192c57804ce5e55e99e34002d/iop/system/modload/include/xmodload.h),
revision `89b9d8cf249f927192c57804ce5e55e99e34002d`. These are independent
observers; upstream licensing is preserved. PCSX2 remains pinned to v2.6.3
`bc8151d2a46d4aba039ea5580afbfc7bfcf6d730`; no shared upstream class layout changed.

## Current proof and historical origin

Binding creation requires the first-pause full-file provenance check, matching
initial load image/IOPMOD/relocation plan, readonly runtime image and a present
observed registration. Later source queries require the same native namespace,
sequence/module ID, process/session/VM affinity, exact candidate file SHA and
file version. They reconstruct relocations and compare the runtime image twice,
using the existing bounded addr2line worker and address eligibility rules.
Mappings are never cached; writable/BSS runtime contents remain unproven.

Later queries keep `evidence.original_loaded_file_sha256: null`. Their
`binding.origin.file_sha256` is explicitly **historical evidence verified when
creating the binding**, rather than a newly observed whole-file load. The
original `load_watch_id` receipt still has its narrower first-pause scope and
cannot be revived after resuming. `evidence.module_generation` remains null for
a universal lifetime claim; `observed_generation` states the narrower tracked
scope. Existing inventory/exception artifact identities do not change.

## IOP observers across lifetime changes

IOP exception and memory-watch starts now require the current lifetime epoch
as well as the CPU-reset guard. Observed load/registry/service/reboot/restore
boundaries terminate pending IOP watches as `lifetime_changed`. They cannot
continue watching a silently reused module address. EE watches are preserved by
IOP-only boundaries. Completed exception reports and frozen memory pairs remain
historical and unchanged. Native CPU and VM resets retain their existing
`cpu_reset` / `vm_changed` states.

`iop_reset_scope: cpu_reset_only` continues to describe the CPU counter, not the
new boundary guard. DebugServer writes still rebase raw memory comparisons as
before, while revoking artifact generations/bindings. The lifetime epoch is not
assumed constant during ordinary debugger writes to a raw-address watch.

## Acceptance and remaining limits

Windows native/TypeScript builds and **152 Node tests** passed. **12 new live
checks** covered first-pause binding, native namespace/sequence and stale-watch
guards, fresh sources after resume/reconnect, real registry removal and
same-address/code re-registration, a genuine failed modload buffer load,
same-byte writes, artifact replacement, native restore, SifIopReset/SifIopSync,
TTL/ownership and VM reload. IOP watches terminated at the observed boundaries;
the independent EE watch remained armed. Regression: **11 lifetime**, **11
load-provenance**, **10 IRX/source**, **13 IOP exception/module** and **10 memory**
checks: **67 live checks total**. Pristine/upgrade from `3e5369a`/reapply/build
agree across **21 native files**.

Reproduce from the repo root with Docker Linux running and configured Windows
PCSX2, substituting actual absolute paths and new output directories:

```powershell
rtk proxy python -X utf8 tools/build-iop-exception-fixture.py release/check-bindings
rtk npm test --prefix pcsx2-mcp-server
rtk proxy node pcsx2-mcp-server/test/iop-bindings-live.mjs D:\dev\PCSX2-MCP\release\windows\pcsx2-qt.exe D:\dev\PCSX2-MCP\release\check-bindings D:\dev\PCSX2-MCP\release\windows D:\dev\PCSX2-MCP\release\check-bindings-live
```

The fixture adds `service.elf` and an actual invalid-buffer modload call whose
guest return value must be negative; it is not replaced with a fabricated
result. Registry probes remove/re-register without freeing/reloading their own
code. The harness uses real source/instruction breakpoints, a private fixture
copy, ports/INI/data root and savestate. It stops only its owned emulator and
neither assigns PC to simulate calls nor copies BIOS or edits source settings.
Ignored local evidence:

- `release/bindings-live-20261023-final/validation.json`
- `release/generation-regressions-20261023-final/`
- `release/generation-integration-20261023-final/integration.json`
- `release/generation-acceptance-20261023.json`

Tracking is deliberately conservative and partial: direct/internal calls
bypassing observed imports, arbitrary external/PINE/GUI RAM writes, unsupported
reboot mechanisms and SIF layouts are not universally excluded. Readonly code
revalidation does not recover overwritten initial writable data. Not every
modload ordinal/BIOS, malformed SIF case or cache-overflow branch was exercised
live. No new host-OS, universal performance, A/V or physical PS2 acceptance is
claimed. [F5 input movies](input-movies.md) now enforce these invalidations for
power-on record/replay; additional loader/reset coverage remains a separate
acceptance requirement. Starting movies from a savestate remains pending.
