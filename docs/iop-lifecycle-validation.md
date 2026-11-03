# Current-build IOP lifecycle validation — L1R

Validated on Windows with modified PCSX2 v2.9.147, revision
`4c3f2eaacbd181f201c094781a79b1d0f996f954`, using the S4a native executable.
This rechecks the lifetime/binding contracts originally accepted on v2.6.3
against the current native/Node implementation and configured local BIOS.
Production native/Node behavior is unchanged.

**Eleven lifetime and twelve binding groups passed.** They execute the genuine
HostFs load/registration, guest registry removal and same-address/code
re-registration, failed modload buffer-load service, SifIopReset/SifIopSync,
guest MMIO CPU reset, VM reload and native savestate load. They also check
namespace/sequence refusal, historical file provenance, file/image/source
revalidation after pause/reconnect, same-byte debugger writes, artifact
replacement, bounded lifetime history, TTL/drop ownership and termination of
IOP watches while an independent EE watch survives IOP-only boundaries.

The first lifetime run stopped after eight groups because its historical
assertion required a lifetime-only error for an entirely stale VM identity.
The current guard checks VM/ELF/reset affinity before lifetime. The corrected
harness now separately proves both refusals after actual restore:

1. Execution epoch advanced, while process/session/ELF affinity remains equal;
   the original complete identity gets the exact VM/ELF/reset error.
2. Refreshing VM identity but retaining the old IOP lifetime epoch gets the
   exact lifetime error.
3. Neither refused read changes the paused native capabilities or CPU status.

This strengthens the two checks rather than allowing either error indiscriminately.
The final run passed all eleven groups; the first report remains a failed
harness baseline, not a native failure or an acceptance result.

## Reproduction and evidence

The retained `release/generation-fixture-20261023` matched every manifest SHA,
the pinned SDK image, and all five current source/build files. No fixture or
SDK rebuild was needed. Each harness copies the fixture/INI into its own new
root and uses separate ports and a private savestate. Source BIOS settings and
production binaries are not changed.

```powershell
rtk proxy node pcsx2-mcp-server/test/iop-lifetime-live.mjs D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe D:\dev\PCSX2-MCP\release\generation-fixture-20261023 D:\dev\PCSX2-MCP\release\standalone-data D:\dev\PCSX2-MCP\release\lifetime-new
rtk proxy node pcsx2-mcp-server/test/iop-bindings-live.mjs D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe D:\dev\PCSX2-MCP\release\generation-fixture-20261023 D:\dev\PCSX2-MCP\release\standalone-data D:\dev\PCSX2-MCP\release\bindings-new
```

Ignored reports:

- `release/lifetime-current-20261102/validation.json` — failed assertion baseline
- `release/lifetime-current-20261102-02/validation.json` — eleven accepted groups
- `release/bindings-current-20261102/validation.json` — twelve accepted groups
- `release/iop-lifecycle-current-delivery-20261102.json` — hashes/publication/CI

Both final harnesses exited 0 after stopping their owned native/MCP instances.
Hosted CI syntax-checks both harnesses and runs the unchanged 295 Node tests;
it does not run the BIOS/native suites. No redundant local production test run
or emulator rebuild was required for this test-only correction.

## Remaining limits

This covers the observed imports and existing fixture on one configured BIOS.
It does not expand support to direct/custom loaders, every modload ordinal,
other BIOS revisions, malformed/fragmented SIF packet layouts, arbitrary
external RAM writers or universal module generations. Loader call observation
still does not prove successful load. Initial writable data is not reconstructed
by later readonly image validation. Physical PS2, SMS/Jellyfin, actual Qt matrix
S4b, IOP source stepping and synchronous loader interruption/rollback remain
separate requirements or documented unsupported capabilities.
