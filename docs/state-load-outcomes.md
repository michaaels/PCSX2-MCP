# Observed savestate outcomes — S2b2a

Validated on Windows on 2026-10-27, independently of SMS/Jellyfin. Rebuild and
restart both native PCSX2 and the Node MCP server for `guarded_state_load`.
The configured local executable has been rebuilt; this is not a binary release.

## Defect and changed tools

The previous `pcsx2_load_state` returned `Loaded from slot 8` for an empty private
slot. PINE acknowledged its queued CPU callback before PCSX2 attempted the load.
The retained baseline reproduces that false success on the S2b1 executable.

`pcsx2_load_state {"slot":4}` now prefers the native DebugServer feature. It
requires an already paused VM and checks process, server session, EE execution
epoch, IOP reset/lifetime epochs and ELF path/CRC on the CPU thread immediately
before calling `VMManager::LoadStateFromSlot`. It does not automatically pause,
retry or fall back to PINE after a guarded native request fails.

| Outcome | Meaning |
|---|---|
| `loaded` | The native call returned true; `completion_confirmed:true`, `loaded:true`, before/after identities and an operation receipt are returned. |
| `failed` | The native call returned false and its actual error is retained; this is an MCP error even though the transport reply is valid. Failure does not promise rollback. |
| `not_dispatched` / `refused` | The wrapper sent no load, or the native precondition check explicitly refused before the load call. |
| `cancelled_before_dispatch` | The abort signal was observed before sending a load; no load was submitted by this operation. |
| `unknown` | A dispatched request has no validated outcome, for example after losing the connection. `loaded:null`; do not retry automatically. |
| `queued_unconfirmed` | PINE-only or older-native fallback accepted submission. `completion_confirmed:false`, `loaded:null`; it does not prove a load happened. |

`pcsx2_save_state` still uses PINE. Its acknowledgement now also returns
`queued_unconfirmed` rather than claiming that a file has finished saving.
Both tools require an integer slot from 0 through 9. Callers that parsed the old
success text must consume the structured JSON outcome instead.

## Reconciliation and cancellation

`pcsx2_load_state_status {"operation_id":"<32 lowercase hex characters>"}` is
read-only. The native server retains **one last completed guarded load receipt**
in memory, including an actual failed load. Reconnect does not erase it; a later
completed guarded load replaces it and native server restart erases it. Status
marks a receipt `historical` when its after-identity differs from the sampled
current VM. A failed precondition does not replace the receipt. Reusing the
currently retained ID refuses another load; this is not permanent deduplication
for overwritten IDs or an exactly-once guarantee across restarts.

An absent receipt means `unavailable_or_unknown`, never proof that no load ran.
The status query is subject to native command availability; it cannot recover
an unresponsive core. Before/after identities are observations, not an atomic
snapshot of subsequent caller actions.

Cancellation is checked before dispatch. A dispatched native load **cannot be
interrupted or rolled back** by this tool. If the signal aborts while awaiting
a valid receipt, the actual outcome remains visible with
`cancellation_requested:true`. If transport fails, outcome stays unknown until
reconciled. The in-flight signal case is covered by a controlled Node peer;
no real native in-flight cancellation is claimed. A status query cannot recover
the caller's earlier abort signal.

## Evidence

Windows and TypeScript builds, **255 Node tests**, **45 independent live checks**
and **26-file pristine/upgrade/reapply/build-checkout integration** passed.
The eight added Node tests cover outcome validation, wrong IDs/slots/identities,
PINE fallback, no-dispatch cancellation, in-flight abort acknowledgement,
refusal versus transport uncertainty, no automatic retry and historical status.

The eight new native checks exercise:

- Empty slot: actual failure, unchanged epoch and sampled paused CPU/RAM.
- Pre-aborted request: no load or replacement of the preceding receipt.
- Finalized private savestate: execution changes RAM; guarded load restores the
  exact saved counter and invalidates the old inspection identity.
- Invalid ZIP and an empty valid ZIP without savestate entries: actual errors,
  advanced attempt epoch and unchanged sampled paused CPU/RAM.
- Running wrapper and stale native identity: refusal without automatic pause
  or load; receipt reads after reconnect, bounded retention and duplicate refusal.
- PINE-only empty-slot submission: queued/unconfirmed rather than false success.

An empty slot fails before PCSX2's state-load-attempt hook. Both malformed-file
cases reach that hook, advance the epoch and invalidate old inspection even
though loading fails. Unchanged sampled memory in these two early failures does
not establish rollback for arbitrary corrupt/incompatible savestates.

The full runner retains the preceding 37 live checks, including rendering,
screenshots/video, bounded EE/IOP stepping, SIF guards, reset and reconnect.
Every owned emulator stopped. No SMS, Bridge, DMA semantics, Jellyfin or physical
PS2 acceptance is involved. Native executable SHA256:

```text
65831b62104dccf857bb38d388d60c4c4872ae139a44746686cab5fdd6e0571a
```

Ignored local evidence, generated states and malformed fixtures remain outside Git:

```text
release/restore-baseline-20261027/validation.json  # expected failed baseline
release/state-load-live-20261027/validation.json
release/state-load-acceptance-20261027/validation.json
release/state-load-integration-20261027/integration.json
release/state-load-delivery-20261027.json
```

## S2b2b follow-up (2026-10-28)

[Dispatched restore reconciliation](irq-pause-boundary.md) adds real socket
forward/abort and completion-reply discard tests. They preserve an actual loaded
receipt or return unknown until a read-only query reconciles it; no mutation is
retried. These close the after-submission result-handling gate, not interruption
of native deserialization or SDK cancellation-notification transport.

## Next acceptance gates at S2b2a

S2b2 remains partial. GUI ownership replacement during stepping was not tested:
the computer-use runtime failed initialization with `failed to write kernel
assets: El sistema no puede encontrar la ruta especificada. (os error 3)`, also
after reset and retry. No GUI action occurred. Resume that gate when its runtime
works; preserve this delivery as S2b2a rather than marking GUI coverage complete.
True native in-flight interruption, hung-core recovery, interrupt-active IOP
stepping and broader branch/device cases remain pending, followed by bounded
long-run/CI and editor acceptance. Application playback stays a separate backlog.
