# Duration, rendered progress and recovery — T2

This Windows-only live harness drives its own PS2 homebrew, emulator, data root,
PINE port and stdio MCP children. It does not use SMS, Jellyfin or a game.
PCSX2 remains pinned to v2.9.147. Native and production Node sources do not
change in the original T2 delivery; its new code is test infrastructure.

## Current-binary revalidation — 2026-11-02

Repeated after the native F5b/S4a changes, using S4a source commit `1b4f557`
and executable SHA256
`9243a1a396919d6240fc00ad1949f076d9ccfe98c112ce96688dd0487e4e7d3c`.
No harness, production source, fixture, native binary or configuration change
was needed for this follow-up. The unchanged harness/support and current S4a
runtime hashes are bound separately from the original T2 acceptance below.

The normal run passed **604.097 s**, with **481.732 s** in measured execution
windows, **96** RAM/decoded-pixel progress probes and **20** recoveries: ten
actual guarded restores and ten ELF resets. Each recovery also replaced the
native socket and stdio server while the guest was running. All **21** owned
stdio processes and the emulator closed. Twenty stdio children were resource
sampled; the last replacement was created after the final progress probe.

Observed native peaks: **1035.06 MiB private**, **776.89 MiB working set** and
**594 handles**. Final private memory was **102.43 MiB above** the 60-second
baseline, within the existing 256 MiB growth limit; sampled CPU advanced
112.844 s. Sampled MCP peaks were **55.47 MiB private** and **186 handles**.
The pre-final-report artifact scan counted 36 files/18,008,906 bytes. All
resource/log/artifact gates held. First/last rendered counter PNGs were visually
reviewed. These bounded observations do not prove leak freedom or multi-hour
stability.

The real paused-guest negative control again failed on its first unchanged RAM
counter probe, exited 1 and closed its own native/stdio processes. Source tests
are the unchanged **295-test S4a** suite; no redundant local source run or new
editor/GUI action is claimed. The publication receipt also verifies hosted CI
for this documentation-only follow-up.

```text
release/soak-current-600-20261102/validation.json
release/soak-current-stall-20261102/validation.json
release/soak-current-ci-20261102.json
release/soak-current-delivery-20261102.json
```

Next remains real Qt ownership coverage after Computer Use reconnects. The
native-pipe error is not treated as a GUI pass; SMS/Jellyfin and physical PS2
remain separate. The following reproduction and older measurements retain
their original scope.

## Reproduce

Build Node using `npm test` in `pcsx2-mcp-server`. Build the continuous-drawing
fixture with the existing pinned PS2SDK Docker image, using a new directory:

```powershell
rtk proxy python "D:\dev\PCSX2-MCP\tools\build-standalone-fixture.py" "D:\dev\PCSX2-MCP\release\soak-fixture-new" --gs-replay
rtk proxy node "D:\dev\PCSX2-MCP\pcsx2-mcp-server\test\soak-live.mjs" "D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe" "D:\dev\PCSX2-MCP\release\soak-fixture-new" "D:\dev\PCSX2-MCP\release\standalone-data" "D:\dev\PCSX2-MCP\release\soak-new" 600
```

The configured root supplies the user's existing local BIOS configuration.
The test neither obtains BIOS nor edits that original INI. Input fixture files,
their manifest and current checkout source hashes must agree before launching.
Only a new output directory is accepted. Each run copies its fixture privately.

Normal duration is 75–3600 seconds, default 600. It measures wall duration and
requires at least 70% of the requested time in five-second guest-running
windows. Probe and recovery pauses are explicit; this is supervised sustained
execution, not uninterrupted gameplay. A hard watchdog fires at requested
duration + 120 seconds and closes only owned processes. Startup polling, MCP
requests (15 s), resource collection (5 s) and process cleanup also have bounds.

## What it checks

At every five-second execution window, the paused guest must have changed its
actual `gs_replay_counter` RAM value and the decoded pixels of its 640×480 GS
PNG. The fixture continuously prints this counter. PNGs come through the real
MCP stdio `pcsx2_screenshot` tool and are decoded, bounded and hashed. A changing
PC alone cannot pass. First, last and recovery images are retained; intermediate
decoded pixel hashes stay in the report. PID/session/ELF path/CRC/port/data-root
identity and empty EE/IOP breakpoint lists are checked at probe boundaries.

Every thirty seconds, alternating recovery operations run while paused:

- **Restore:** PINE submits a private slot-4 save; the test waits for the ZIP
  end record instead of treating submission as completion. Guest execution must
  change RAM before the actual guarded MCP load reports confirmed `loaded`.
  The saved counter must return exactly, before any further guest execution.
- **Reset:** reload the same private ELF and run its initialization again. Its
  counter must differ and the execution epoch must advance.
- Both operations must invalidate a pre-operation SIF inspection identity.
  Then the guest resumes, the native socket is replaced and the stdio MCP child
  is closed/recreated. Neither reconnect may pause it. Subsequent RAM progress
  and a newly rendered image prove recovery; the native identity remains fixed.

Restore invalidates the GS image. The test checks exact restored RAM first,
then resumes before asking for a new image. A screenshot failure immediately
after a paused restore is not hidden or replaced with an earlier frame.
Consumed private states are removed before the next save to prevent a stale
ZIP from satisfying its completion poll. All operations remain serial.

## Resource and artifact gates

PowerShell samples only the owned native and current stdio PIDs at each probe:
start time, private memory, working set, handle count and cumulative CPU seconds.
No machine-wide process termination occurs. PID/start-time matching protects
growth comparisons from PID reuse. CPU is sampled time, not utilization or a
performance benchmark. A final child created after the last probe can have no
resource sample; session closure and resource sampling are separate evidence.

| Gate | Native | Each sampled MCP child |
|---|---:|---:|
| Private-memory absolute ceiling | 1536 MiB | 256 MiB |
| Private-memory growth ceiling | 256 MiB | 64 MiB |
| Handle absolute ceiling | 4096 | 4096 |
| Handle growth ceiling | 512 | 512 |

Growth compares each PID to its first probe at or after 60 seconds of run time.
This excludes initial native warm-up. Newly created stdio PIDs get independent
baselines; short child lifetimes do not prove long-lived MCP leak freedom.
Working-set and CPU observations are recorded, without additional growth gates.
The thresholds are explicit test acceptance budgets, not product requirements.

The output tree is checked after each probe/recovery against 256 MiB and 384
files, including copied fixture, private data, states, images and reports.
Native retained logs are capped at 4 MiB; stdio diagnostics are drained and
counted, also with a 4 MiB per-child gate. Each PNG is at most 2 MiB. Artifact
scans are periodic; they do not claim filesystem quotas or an instantaneous
bound between scans. Reports checkpoint with `passed:false`; acceptance is
written only after all checks, requested duration and owned-process shutdown.

## Negative controls and CI

Append `30 stall-control` instead of `600` to leave the guest deliberately
paused. This is a real no-progress control, not a simulated passing report:
expected exit 1 with `Guest progress stalled: counter unchanged`, `passed:false`
and confirmed owned-process cleanup. It does not establish fatal-core deadlock
detection or native deserializer interruption.

`soak.test.mjs` exercises absolute/growth ceilings, invalid measurements, PID
reuse and CPU-counter regression. It also creates a real oversized temporary
artifact and checks nested byte accounting and rejection. The Windows/Ubuntu
Node CI runs these source tests and syntax-checks the live harness; hosted CI
does not run PCSX2, Docker, BIOS or this sustained native workload.

## Evidence and remaining scope

The accepted local run on 2026-11-01 (Node v26.4.0, Windows/modified 2.9.147)
requested 600 seconds and completed **604.884 s**, including **521.908 s** in
the measured running windows. All **104** probes changed RAM and decoded GS
pixels. Ten actual guarded restores and ten ELF resets passed, each followed
by a native socket replacement and stdio restart while running. The native
process and all **21** stdio children closed; twenty children were resource
sampled, with the final replacement created after the last probe.

Observed peaks: native private memory **1035.18 MiB**, working set **774.64 MiB**
and **620 handles**; sampled MCP private memory **54.45 MiB** and **187 handles**.
Native private memory ended about **96.34 MiB above its 60-second baseline**:
growth was observed and stayed below the 256 MiB gate, rather than proving
leak freedom. Native sampled CPU advanced 128.156 s. The pre-final-report
artifact scan counted 36 files/~18.0 MB, inside the budget; the delivery receipt
hashes final artifacts. First/last PNGs are actual rendered counter images.

The stalled-guest control failed on its first probe with the expected unchanged
counter error, exited 1 and closed its own processes. Local TypeScript and
**262 Node tests** passed. Four exploratory pilots remain excluded from final
acceptance: the first exposed a plain-text connect reply, the second lacked
the expected global symbol lookup, the third requested a frame before GS
re-rendered after restore, and the fourth passed 80 seconds before final
reporting additions. The accepted duration run and negative control hash the
same final harness/support source. The fixture build initially failed because
Docker was stopped; after starting the local engine it built with the pinned
image. No native rebuild was required.

```text
release/soak-duration-600-20261101/validation.json   # accepted duration run
release/soak-stall-control-20261101/validation.json  # expected rejection
release/soak-node-tests-final-20261101.log
release/soak-ci-20261101.json                       # remote status by final SHA
release/soak-delivery-20261101.json                 # publication/hash receipt
```

Local artifacts remain ignored under `release/`; no BIOS or private INI is
published. Earlier failed pilots remain separate from accepted evidence.

This establishes only the documented duration/fixture/renderer/process scope.
It cannot prove absence of leaks, multi-hour/game stability, every IOP/GUI
option, physical PS2 behavior or recovery of a core that cannot service native
commands. Synchronous native load interruption/rollback remains deferred.
The next original-roadmap stage is a DAP adapter with actual editor acceptance
over supported operations and explicit source mappings.
