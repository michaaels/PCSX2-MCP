# Savestate-start input movies — F5b

Implemented and validated on Windows with pinned PCSX2 v2.9.147. Rebuild native
and TypeScript, restart the MCP server and use the modified emulator. Native
capability `input_movie_states` is required in addition to `input_movies`.
The earlier [power-on movie contract](input-movies.md) and
[offline archive inspector](input-state-inspection.md) remain applicable.

## Record and replay

Boot your matching debug ELF, pause, enable recording tools, disable hardcore
mode and configure both ports as DualShock2. Start a recording through MCP:

```json
{"start":"savestate","frames":120,"timeout_ms":30000}
```

`pcsx2_input_record` captures the current machine without resetting it. Native
retains an exact-path, mutex-protected save ticket. The worker publishes success
only after `SaveState_ZipToDisk` returns successfully following `zip_close`;
the earlier queued host notification is not completion. Errors during capture
or writing publish failure. Workers never inspect or mutate CPU-owned movie
state. Superseded/cancelled paths cannot complete a replacement operation.

During `preparing` and `prepared`, native refuses VM resume, including a direct
resume request, and consumes no input intervals. Node waits for `saved`, checks
the finalized archive/payload CRCs, then submits its SHA256 for native acceptance.
Native rehashes and holds the companion open read-only; Windows denies writes.
Only then does startup return `state:active`, `state_outcome:saved` and the
companion path/hash. Explicitly resume and wait using the returned operation ID.
The recording wall deadline includes preparation and paused time. Replay's wall
lifetime starts after its synchronous load returns. Cancelling startup
attempts to close only its own ID; a worker already writing is not interrupted.
An abandoned archive can therefore finish later without reactivating recording.

Retain the completed movie, companion, ELF hash and report together. Replay
requires explicit companion identity, for example:

```json
{
  "path":"D:/artifacts/recording.p2m2",
  "movie_sha256":"<movie SHA256>",
  "elf_sha256":"<matching ELF SHA256>",
  "state_path":"D:/artifacts/recording.p2m2_SaveState.p2s",
  "state_sha256":"<companion SHA256>",
  "timeout_ms":30000
}
```

Node validates both source files before dispatch. Native copies into a new,
exclusive `<data-root>/mcp-input/<id>/` directory, refuses reuse/overwrite,
computes SHA256 itself and pins both private files **before** invoking playback
and the synchronous core loader. Movie hashes are also checked natively for
power-on replay. Existing FFmpeg's runtime-loaded SHA256 API is used; the build
does not acquire a new linked FFmpeg dependency.

Successful replay reports `state_outcome:loaded`, advances the execution epoch
and invalidates old EE inspection/EE and IOP memory observers through the normal
load hooks. The narrowly scoped owned initial load preserves its movie; later
external load attempts/reset still terminate it. The VM stays paused until
explicit resume. EOF closes without rerecording and restores both saved pads.
Closed status rechecks movie and companion hashes, including original replay
sources. Retention is one native operation; preserve reports before replacement.

## Outcomes and limits

Save outcomes are `pending`, `saved` or `failed`; replay outcomes are `loaded`
or `load_failed`. Preparation, hash mismatch, cancellation, timeout and native
load failure cannot be reported as completed playback. File limits remain
1–600 movie records and the inspector's 128 MiB archive/expanded budgets.
Power-on remains the default and rejects supplied companion options.

The pinned loader may mutate or reset the machine on failure. Its synchronous
deserializer cannot be interrupted or rolled back. The integration supplies a
real `Error` object to input playback: upstream's default null pointer crashed
the internal-structure failure path; the tested failure now returns an outcome
while preserving the native connection. This does not make arbitrary host files
safe or validate every internal structure. Use trusted local artifacts.

ZIP/CRC/SHA validity does not establish ELF association or deterministic
execution. The state format embeds no cryptographic ELF identity; the report
labels association `caller_supplied_not_embedded`. BIOS/settings/device/network
timing and physical PS2 execution remain outside this acceptance. A nested
inspector report still says `native_load:not_performed`: that describes its
offline check; the outer native `state_outcome` supplies the actual load result.

## Verification and reproduction

TypeScript and **289 Node tests** passed. Eight new real native/MCP groups cover
async completion/resume exclusion, 12-frame recording and exact RAM restore,
epoch/observer invalidation, both nonneutral pads/EOF/restoration, repeated and
single-frame record/replay, pre-load rejection, pending cancellation/late worker
completion/deadline, actual filesystem save failure and actual deserializer
failure. The failure fixture has a valid archive/CRC but deliberately invalid
internal BIOS tag; it is not a usable machine state.

The final native build also passed **11 power-on movie**, **60 standalone** and
**six native DAP** regression checks. Integration agrees across 29 native files
for pristine application, reapplication, prior integration upgrade and the build
checkout. All owned test native/MCP/DAP processes closed. This repeats the DAP
backend checks; no new VS Code editor session or physical validation is claimed.

```powershell
rtk proxy node pcsx2-mcp-server/test/input-state-movie-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/dap-fixture-20261101 release/standalone-data release/input-state-new
```

Output must be new. The fixture manifest and current source hashes are checked
before launch. A private INI, port, data root and owned native/MCP processes are
used; the configured BIOS root is referenced without acquiring BIOS. Cleanup
stops owned processes. This harness has a three-minute native watchdog and
bounded operations; it is not an OS sandbox or a general hung-core guarantee.

Evidence stays ignored under `release/`:

- `input-state-movies-accepted-20261102/validation.json`
- `input-state-power-on-final-20261102/validation.json`
- `input-state-dap-regression-20261102/validation.json`
- `input-state-standalone-regression-20261102/validation.json`
- `input-state-movies-node-accepted-20261102.log`
- `input-state-integration-final-20261102/integration.json`
- `input-state-declaration-reorder-20261102.json` and `.patch`
- `input-state-movies-delivery-20261102.json`

Early pilots remain excluded: initial fixture/connection setup mistakes and the
reproduced null-Error native failure preceded the accepted fixed build. The
initial link attempt also failed because the emulator loads FFmpeg dynamically;
the corrected build resolves the existing library's symbols at runtime. A
power-on regression also caught premature watchdog expiry during synchronous
reset; the final build preserves its prior deadline origin while bounding
asynchronous state-record preparation. No
failed run is counted as native acceptance. Hosted CI tests source on Node 22
Windows/Ubuntu; it does not run the native emulator or acquire BIOS.

The generated `state-tools.d.ts` also changes property order (`loaded`) without
changing its line multiset or runtime JavaScript. An isolated recompilation of
F5a reproduces the original declaration SHA; both SHAs/diff are retained above.
The runtime receipt distinguishes this declaration from the intended three
movie/client module changes and the rebuilt native executable/sources.
