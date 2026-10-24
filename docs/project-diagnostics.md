# Project diagnostic evidence: 5B1 and 5B2a

Implemented and tested on Windows on 2026-10-23. This delivery inventories the
existing SMS/UDPFS/Bridge fields and adds bounded native collection plus offline
association. 5B2a subsequently validated fresh SMS transport against real
Jellyfin on Windows (closed on 2026-10-24). The subsequent
[5B2b incident recipe](project-incidents.md) captures the CPU/source path of the
HostFs updater error. No Bridge, SMS, decoder or native PCSX2 behavior changed.

## Observed contracts

| Source | Identity and order actually available | Clock and limits |
|---|---|---|
| Project debug manifest | `format_version:1`, `build_id`, full debug `elf_sha256`, `pcsx2_crc`; emitted by `tools/sms-debug-manifest.py` | A build descriptor, not a boot observation or signed attestation. The selected ELF must match both hash and CRC. |
| SMS `SMS_JellyfinLog` | 32-entry queue; build/boot ID, uint32 sequence, event, level, session ID and dropped counter are sent by `relay` | `uptimeMs` forwards uint32 `g_Timer`. Counter regression/wrap stays unresolved. Boot ID uses RTC/timer data, not a collision-proof nonce. |
| SMS console | `JFCLIENT event=… level=… sequence=… session=…`; session is boot ID before a playback session UUID exists | No build ID or uptime in this message. Native console reception supplies a separate timestamp/sequence. |
| UDPFS `EventRelay` | Structured `/__ps2log/…` path; retries/deduplicates and acknowledges after Bridge persistence | No new sender timestamp, send/receive bracket or bounded network delay. ACK proves that relay's persistence flow, not playback. |
| Bridge `DiagnosticStore` | `buildId`, `bootId`, `sequence`, `event`, `uptimeMs`, `dropped`, `level`, `sessionId`, `deviceId`, `receivedAt` in `ps2.jsonl` | `receivedAt` is Bridge wall time at acceptance, before queued persistence. Recent ring is 256; files rotate at 1 MiB; pending/rate limits can lose observations. |
| Native DebugServer | Process/session/current ELF/CRC/execution epoch in capabilities; independent event and console sequences | Wall timestamps; 512 events and 2048 console messages retained. Historical entries do **not** include their own ELF or execution epoch. |
| Node collector | Capture UUID, file SHA256, current identity before/after collection, local wall bracket and monotonic duration | The bracket describes collection on that host. It does not calibrate native/Bridge/client clocks. |

Project-side sources inspected: `ps2/native/SMS_JellyfinClient.c`,
`bridge/src/diagnostics/DiagnosticStore.ts`, `bridge/src/api/app.ts`,
`tools/udpfs_diagnostics.py` and `tools/sms-debug-manifest.py`. Native contracts
are the existing [session history](debug-sessions.md). Rebuild the Node server
for the new tools; the previously validated native `109622d` build is sufficient.

## Collect without changing execution

`pcsx2_diagnostics_collect` requires a connected DebugServer and these absolute
local paths:

```json
{
  "manifest_path": "D:/ps2/debug/manifest.json",
  "elf_path": "D:/ps2/debug/SMSNET-DEBUG.ELF",
  "output_directory": "D:/ps2/evidence"
}
```

The manifest describes the **debug** ELF, not its stripped partner. The tool
verifies manifest/ELF SHA256 and CRC, loaded canonical path/CRC, and native
process/session/epoch/ELF identity before/after. It rechecks artifacts before
saving. Failure or cancellation sends no pause, resume, step, write, reset or
cleanup command. A running guest continues running.

`pages` is 1–11, default 11, with at most 200 entries per page **per stream**.
`events_after` and `logs_after` default to zero. A full final page conservatively
sets the corresponding page-limit flag; overwritten history and truncated text
are explicit. Event and log reads are separate, not an atomic CPU snapshot.

The new unique folder contains sanitized `capture.json`; its summary returns
`artifact.path`, SHA256/byte count, build/identity, coverage and observed boot
IDs. Only allowlisted native event type/CPU/PC and exact complete `JFCLIENT`
fields survive. Raw console messages, event detail, arbitrary HTTP logs, local
source paths and unrelated manifest fields are excluded. Log source must be
native `console`; unknown/truncated/multiline text is counted and discarded.

The current ELF check applies **at collection**. It cannot assign every old
event in that native session to the current ELF/epoch. PID/session identifiers
are scoped to the capture and are not universal process identity across restarts.

## Associate an explicit boot offline

Make a stable local snapshot of the Bridge's structured `diagnostics/ps2.jsonl`.
No Bridge credentials or URLs are passed to the MCP. Concurrent modification,
malformed lines and unsupported fields fail instead of producing mixed evidence.

`pcsx2_diagnostics_correlate` accepts:

```json
{
  "manifest_path": "D:/ps2/debug/manifest.json",
  "elf_path": "D:/ps2/debug/SMSNET-DEBUG.ELF",
  "capture_path": "D:/ps2/evidence/ps2-diagnostics-example/capture.json",
  "capture_sha256": "<SHA256 returned by collect>",
  "bridge_log_path": "D:/ps2/evidence/ps2.jsonl",
  "boot_id": "<16 lowercase hex characters>",
  "output_directory": "D:/ps2/evidence"
}
```

`capture_path` and `capture_sha256` must be supplied together; both may be
omitted for a Bridge-only partial report. The supplied capture hash is checked
before parsing and its build must match the manifest/ELF. Imported captures
remain unsigned observations, not authenticated statements about execution.

The selected build/boot is mandatory. Device IDs are replaced by SHA256 of their
UTF-8 bytes. If multiple devices share a build/boot, the tool refuses until
`device_ref` explicitly selects that digest. The digest is a selector, not
authentication. Identical duplicate receipts are counted; conflicting reuse of
a client sequence refuses the report. Gaps and reported drops remain visible.

Association requires exactly one matching console boot anchor, bounded by the
next console boot. Within that segment, session, sequence, event and level must
match exactly. Ambiguous/missing matches remain unassociated. The report does
not infer build identity from a module name, matching PC or a timestamp.

`correlation.json` retains separate streams: client sequence/uptime, Bridge
receipt line/time, and native event/log sequence/time. It references actual
manifest/ELF/capture/journal hashes; no raw device name or arbitrary log text is
saved. `associated_observations` means some reported fields match, not whole
session coverage. `coverage.partial_reasons` records gaps, missing anchors,
overwrite, page limits and truncation. Missing input produces `partial`.

Without clock calibration or bounded delivery delay, cross-process offset and
uncertainty have **no finite bound**. Numeric offset/uncertainty and transport
latency remain null with `uncertainty:unbounded`; no globally ordered timeline
is constructed. Client uptime differences are reported only when nondecreasing.
`root_cause:not_established` and `physical_validation:not_performed` remain explicit.

Inputs are bounded to 2 MiB per manifest/capture/journal, 4096 JSONL records and
2048 bytes per JSONL line. Each capture stream has at most 2200 entries; saved
JSON is limited to 4 MiB. Stable reads check file replacement, size, mtime and
ctime. Earlier outputs are preserved in unique folders, with no guest cleanup
on cancellation. Select another bounded snapshot when a complete journal exceeds
these limits; the tool does not silently discard its beginning.

## Validation and remaining work

TypeScript compiled; **174 Node tests passed**, including 11 new cases for
privacy projection, matching, clock uncertainty, conflicting devices/sequences,
history bounds, artifact/hash guards, missing data and cancellation.

**Seven checks against an owned Windows PCSX2/SMS instance passed**. They verify
the retained project ELF/manifest, real boot console fields, unchanged paused
PC/cycles, collection while running, wrong-build refusal and partial output.
The association check uses a **synthetic Bridge receipt**, clearly labeled in
the harness. An existing private 207-record Bridge journal parsed successfully;
its historical builds were excluded from the current capture. Neither check
establishes fresh UDPFS transport, Jellyfin operation or physical hardware.
All **11 input-movie live regressions** also passed with the new MCP registration.

| Evidence | Ignored local path |
|---|---|
| SMS capture, association fixture, historical-journal exclusion | `release/project-diagnostics-live-20261023-release/validation.json` |
| Input-movie regression | `release/project-diagnostics-input-regression-20261023-release/validation.json` |
| Tested source/build and artifact hashes | `release/project-diagnostics-acceptance-20261023.json` |

From `pcsx2-mcp-server`, after building Node:

```text
node test/project-diagnostics-live.mjs <PCSX2> <project-manifest> <configured-data-root> <new-output> [historical-Bridge-JSONL]
```

The harness uses private ports/data/INI and stops only its owned emulator. It
copies no BIOS and assigns no PC to simulate execution. No native code changed,
so native compilation/integration checks were not repeated; the tested binary
and plugin retain the F5 receipt's hashes. Bridge runtime did not change, so its
build/tests were not rerun.

## 5B2a: fresh SMS transport acceptance

The new `test/project-transport-live.mjs` harness launches the retained debug ELF
in its own data directory. A private byte-identical ELF copy receives an
`IPCONFIG.DAT`; HostFs and Ethernet sockets settings affect only that instance.
It never overwrites the retained build, changes its PC or injects client events.
The harness requires a previously absent Bridge journal, checks the ELF hash/CRC,
collects actual console fields and polls for fresh matching build/boot receipts.
After catalog-open it allows three more seconds for queued diagnostics.

Inputs are:

```text
node test/project-transport-live.mjs <PCSX2> <manifest> <configured-data-root> <fresh-Bridge-JSONL> <new-output> <guest-IPv4>
```

Use absolute local paths. The Bridge and UDPFS adapter must already be running
against real Jellyfin with a new cache directory. The guest IPv4 is the host's
LAN address when using PCSX2 sockets NAT, as in the project fixture. The harness
does not receive credentials, start these services, change firewall rules or
assert Jellyfin authentication itself. Retain a separate service receipt.
`PCSX2_TRANSPORT_TIMEOUT_MS` selects a 1000–60000 ms polling budget (default
45000); individual MCP calls also have a 60000 ms deadline. Output contains a
private filtered Bridge snapshot, sanitized native capture, correlation report
and `validation.json`. All selected Bridge events must have exact console
matches; missing receipts fail, with partial native evidence retained. Cleanup
uses `pcsx2_stop` only for the emulator owned by this MCP; failure to confirm
cleanup fails acceptance. Existing journals are rejected before launch.

The PS2 project adds `tools/validate-diagnostic-transport.py` to create the local
ignored `.env`, new cache, Bridge and UDPFS processes and an optional owned
loopback Jellyfin. It validates `/Users/Me` using the same Authorization header
as the Bridge, checks the configured dedicated nonadministrator user, verifies
Bridge readiness and stops only its child services. A preexisting Jellyfin is
left running. Run it from `D:\dev\PS2\ps2_multinet`, for example:

```powershell
rtk python tools/validate-diagnostic-transport.py --bridge-env artifacts/athena-preview/jellyfin/bridge.env --bind <host-LAN-IPv4> --output artifacts/debug-validation/<new-run> --jellyfin-data artifacts/athena-preview/jellyfin
```

The `athena-preview/jellyfin` path refers only to an existing local Jellyfin
test-server directory. The PS2 runtime remains SMS/UDPFS. Omit `--jellyfin-data`
to use the existing Jellyfin endpoint configured in the source `.env`; no
credentials belong in command arguments or reports. Source credentials and
prior caches/configuration are retained. The owned server requires a matching
loopback-only configuration and an unused port.

The final run used Jellyfin **12.2.0**, a verified dedicated nonadministrator
user and SMS build **`7a4a8cee9f5f9008`**, boot **`2610241359171665`**.
Four actual persisted receipts matched all four console events: `boot` (0),
`network_ready` (1), `catalog_open` (2) and ERROR `update_path_failed` (3).
No synthetic receipts or old journals participated. Four live checks passed,
including confirmed emulator cleanup; service cleanup was also confirmed.
A separate real SMS run with no Bridge journal correctly failed acceptance,
preserved native evidence and closed its owned emulator. A preexisting journal
was also refused before creating output or launching PCSX2.

Local evidence, all ignored:

| Evidence | Location |
|---|---|
| Real Jellyfin/Bridge identity checks and service cleanup | PS2 project `artifacts/debug-validation/transport-20261023-final/services.json` |
| Four live checks, capture and four-event association | Same folder, `sms/validation.json` |
| Missing-Bridge negative acceptance | MCP `release/project-transport-no-bridge-20261023/validation.json` |
| Preexisting-journal refusal | MCP `release/project-transport-stale-journal-20261023.json` |
| Source/build/report hashes and publication | MCP `release/project-transport-acceptance-20261024.json` |

These are client-event observations. Catalog contents were not independently
compared, playback was not selected, and no new A/V or physical-console result
is claimed. `update_path_failed` is recorded as an observed incident, not a
diagnosis of the physical `E11 SifInitRpc` hang or intermittent audio. It is
consistent with the updater's USB-only path guard under a HostFs debug launch;
the guard's runtime state/call site was not captured. Clock uncertainty remains
unbounded and root cause remains `not_established`.

### Revalidation against the user's Linux Jellyfin

On 2026-10-24 the user supplied the active Linux endpoint. Its Jellyfin 12.2.0
instance accepted the locally stored dedicated nonadministrator credentials;
only `JELLYFIN_URL` changed in the project's ignored Linux Bridge `.env`.
The unchanged live harness then passed all four checks against that external
server. Build `7a4a8cee9f5f9008`, fresh boot `2610241416021665`, produced four
new persisted receipts, all exactly associated with console: `boot`,
`network_ready`, `catalog_open` and `update_path_failed`.

The Linux server was not started/stopped by the test (`owned:false`). Its
availability was checked again after owned Bridge/UDPFS/emulator cleanup.
No playback or hardware validation was added. Incident context remains 5B2b;
the same ERROR observation does not establish E11/audio causality.

Local project evidence is
`artifacts/debug-validation/transport-linux-20261024/services.json` and
`sms/validation.json` in that folder; preflight is
`artifacts/debug-validation/linux-preflight-20261024.json`.
The MCP hash/publication receipt is
`release/project-transport-linux-acceptance-20261024.json`. The endpoint and
credentials remain local and are excluded from published evidence. To repeat
from the PS2 project, with its existing Linux `.env` configured:

```powershell
rtk python tools/validate-diagnostic-transport.py --bridge-env artifacts/linux-jellyfin/bridge.env --bind <host-LAN-IPv4> --output artifacts/debug-validation/<new-Linux-run>
```

The existing 174 Node-test acceptance belongs to 5B1; its runtime source/build
hashes remain unchanged. This delivery changes the live harness and project
orchestration only, so Node/TypeScript/native/Bridge builds and historical
regression suites were not repeated. Syntax checks and the live positive and
negative paths above validate the new harness.

**5B2b is now validated** for the HostFs `update_path_failed` case:
[CPU/source/module context and exact event association](project-incidents.md).
The subsequent [6A visual regression](visual-regression.md) adds tolerances/
regions; next is 6B audio criteria.
Correlating playback-manager logs, wire metrics, finite clock calibration,
instrumentation overhead and causal diagnosis remain pending. This does not
extend the observed IOP binding scope or [input-movie](input-movies.md)
savestate support.
