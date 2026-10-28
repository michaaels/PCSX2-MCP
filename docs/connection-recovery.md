# Connection generations, reset and restore — S2b1

Updated 2026-10-27. This delivery fixes the Node DebugServer client and extends
the independent homebrew suite. Native PCSX2, its wire protocol and its compiled
Windows executable remain unchanged from S2a. Rebuild/restart the Node MCP server
to load the fix.

## Observed defect

The old client stored one shared socket, response buffer, pending resolver and
command queue. Replacing a socket left its callbacks using those mutable fields.
An old close could reject a new pending response; an old partial response could
contaminate the new JSON stream; queued commands could use a replacement socket.
Exclusive/frame continuations could also release newer ownership during cleanup.

Ten focused tests were run before changing the client: eight failed, one timed
out and one passed. The failed baseline log is retained. The accepted suite now contains
16 connection tests, including a real ten-second transport deadline.

## Contract

- Each connection object owns its socket, TCP-connect timer, response buffer,
  pending reply, command timer and serialized queue. A replacement retires the
  previous object immediately and rejects its pending connection/request.
- Commands capture their connection when enqueued. A queued command whose
  connection has ended fails before writing; it is not replayed on a new socket.
  Data, errors, close notifications and timers from an old object cannot alter
  the current connection.
- Exclusive operations, event waits and frame/input advancement retain their
  originating connection scope. An old continuation cannot issue commands,
  connect/disconnect the replacement, return a successful exclusive result or
  release a newer owner. A callback still waiting behind the old queue does not
  start on the replacement.
- `disconnect()` is immediate locally; it does not wait for a later close event
  to settle pending requests. Connect remains bounded at three seconds and
  commands at ten seconds. A native execution deadline remains separate.
- The newline protocol has no request IDs or unsolicited notifications. Invalid
  JSON, unsolicited/trailing replies and responses over 9 MiB UTF-8 retire that
  connection. JSON parse errors omit the raw response text. Native data payloads
  are still validated by their individual tool contracts.
- Local connection generation is distinct from native process/session/VM/IOP
  epochs. Reconnecting to the same paused process does not create a new native
  VM. Conversely, ELF reset or restore can change its epoch without replacing
  TCP. Native identity guards remain necessary.
- Retiring a connection does not roll back or cancel a native command already
  accepted by PCSX2. Such work can finish within its native bounds. Reconcile
  the actual native operation/state before continuing. Arbitrary caller code
  outside a scoped operation is responsible for its own session affinity.

## Validation on Windows

**247 Node tests and 37 live checks passed**, with no SMS, Jellyfin or server.
The native executable SHA remains
`6c5929963654cca25bcafa863b6227ed05d7e7ea4b06d148d3c42eb66574143b`.
No native rebuild or repeat integration run was needed; the previous native
integration/build hashes are checked as unchanged in the delivery receipt.

The 16 connection tests cover pending/queued commands, partial JSON, stale close,
rapid replacement, immediate disconnect, old exclusive continuations and queued
callbacks, bound event waits, malformed/trailing/oversized responses, stale
connect/disconnect cleanup, superseded connection attempts, late exclusive
results, delayed frame cleanup and a real transport timeout followed by a clean
reconnect. These are actual TCP loopback peers with controlled fault delivery.

Five additional checks run against the unchanged emulator and the rendered
standalone fixture:

| Case | Evidence |
|---|---|
| Twenty consecutive replacements | Same process/session/ELF epoch and paused PC/cycles across actual native replies |
| Pending event wait and old exclusive continuation | Old wait/resume rejects; new owner remains paused and connected |
| Actual ELF reset | Epoch advances; reconnect works; old SIF/step identity refuses without breakpoint/CPU mutation |
| PINE save and execution | Private savestate is a finalized ZIP; save preserves pause; five guest frames change the counter |
| Actual restore across reconnect | Counter bytes match the saved value exactly; pre-restore identities refuse; fresh MCP SIF read succeeds |

The complete standalone runner now includes this suite, retaining the preceding
32 native checks as regression coverage. Run the command in
[standalone validation](standalone-validation.md) with a new output directory.
The new suite reuses the render fixture and needs no additional SDK build.
PINE is enabled only in that test's private INI, with separate debug/PINE ports
and a private savestate directory. The owned emulator is stopped at the end.
Savestates and BIOS-related data remain local ignored artifacts.

Ignored evidence:

```text
release/reconnect-baseline-20261027.log
release/reconnect-live-20261027/validation.json
release/reconnect-acceptance-20261027/validation.json
release/reconnect-acceptance-20261027/reconnect/validation.json
release/reconnect-delivery-20261027.json
```

## Remaining scope

The successful restore check is not universal savestate compatibility. GUI
replacement of owned breakpoints during a step, failed/cancelled restore paths,
recovery from a hung native core, interrupt-active IOP stepping, broader MIPS
branches and device coverage remain pending. PINE's own transport was used to
save/load but was not refactored or covered by the DebugServer fault suite.
No automatic retry/replay of guest mutations or physical PS2 acceptance is added.

Next S2b2 addresses those reset/restore/GUI ownership cases and supported
interrupt-active observations before broader long-run/CI/editor acceptance.
