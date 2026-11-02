# DAP adapter — D1 backend acceptance

The new `pcsx2-dap` entry is a separate stdio Debug Adapter Protocol process.
It reuses the MCP's native client, source-line breakpoint ownership, guarded EE
variables and bounded source-step implementations. It does not change the
native binary or add a dependency. **The VS Code integration and actual editor
acceptance remain D2**, rather than implied by the protocol/native tests here.

## Build and attach

Run `npm test` in `pcsx2-mcp-server`, then have a DAP client start:

```text
node <repository>/pcsx2-mcp-server/dist/dap.js
```

The npm package also exposes `pcsx2-dap`. Do not launch via a shell/npm script
that inserts banners into protocol stdout. Diagnostics use stderr/DAP output
events. Start your own modified PCSX2 v2.9.147 instance and matching debug ELF
first; the adapter attaches on loopback and never owns or terminates that VM.

After DAP `initialize`, send `attach` with arguments such as:

```json
{
  "port": 21512,
  "elf": "D:/project/build/game-debug.elf",
  "expectedSha256": "<64 hexadecimal characters identifying your build>",
  "stopOnAttach": true,
  "pathMappings": [{"from": "/build/project", "to": "D:/project"}]
}
```

`elf` must be an absolute local path. Its canonical path/PCSX2 CRC must match
the loaded ELF; optional `expectedSha256` pins the complete file. The adapter
pins the observed file SHA even when the option is omitted. `host`, if supplied,
must be `127.0.0.1`. `stopOnAttach` defaults to true; false observes the existing
running state. The adapter sends `initialized`, accepts source breakpoint
configuration, and reports the initial paused stop after `configurationDone`.

Path mappings are explicit DWARF/build-prefix to local-prefix mappings with the
same boundary/case/ambiguity rules as the MCP. No filesystem guessing, automatic
project discovery or source-file service is provided. The editor opens its local
mapped files. Keep your project paths and optional Python/toolchain environment
in local configuration; no BIOS, credentials or machine-specific venv is packaged.

Install the optional pinned [DWARF Python backend](source-breakpoints.md) and
configure [addr2line](source-debugging.md) as for MCP. Missing backends, source
lines or variable locations remain errors/unavailable results, never zeros.

## Supported operations

| DAP requests | Actual scope |
|---|---|
| initialize / attach / configurationDone / disconnect | One explicitly attached local VM, no launch/kill/restart. Native identity and capabilities required. |
| threads | One execution-control target: R5900 EE CPU, ID 1; not an invented PS2 kernel-thread list. |
| pause / continue | Whole-VM native controls, with stopped/continued events. |
| setBreakpoints | Exact EE source-line groups; all eligible statement addresses. Replaces only this adapter's groups for that source. |
| stackTrace | Current EE PC plus native bounded backtrace; source names/lines where available. Native backtrace is not a general DWARF unwinder. |
| scopes / variables | Full 128-bit EE GPRs/PC and supported physical frame-0 locals/arguments/aggregates, read-only. Caller frames have no reconstructed scopes. |
| readMemory | Guarded current paused EE RAM, canonical first 32 MiB, 1–4096 bytes, bounded signed offset. MMIO/aliases and invalid reads refuse. |
| next / stepIn / stepOut | Bounded EE source over/into/out via the existing backend. `granularity:instruction` supports next/stepIn only, native deadline 1 s. |

Conditional, hit-count, column and log breakpoints return unverified without
installation. No exception filters, expression evaluation, register/variable/
memory writes, reverse debugging, native restart or IOP source scopes are
advertised. An empty exception-filter configuration is accepted. Source-step
failure/timeout/cleanup uncertainty produces a DAP error and preserves the
backend's partial-result semantics; it is never reported as successful stepping.

Frame/scope/value references are unique within the adapter lifetime, bounded
and invalidated on execution/stop changes. Every reuse also checks the native
paused revision, PC, epoch and all GPRs, catching observed external edits.
The adapter does not lock out Qt or other MCP clients. Do not mutate state
concurrently while inspecting it.

Stop observation polls serially at 250 ms. A breakpoint/exception reason needs
matching retained native event evidence; absent/dropped evidence reports a pause
with unknown cause. External VM identity changes terminate observation and
invalidate references, without reconnecting to another VM. A reset may expose
an intermediate empty ELF identity; use a fresh explicit adapter attach after
the intended ELF boots. Automatic restart/restore is not a DAP capability.

On normal detach/EOF, cleanup removes only still-owned source groups. If needed,
it briefly pauses a running VM; it resumes only when the sampled identity/PC/
cycles still match that cleanup pause. It preserves an already paused VM.
Changed groups are retained with a warning; unavailable cleanup is explicit.
Crash/forced process termination cannot promise cleanup. Normal detach never
kills the attached emulator, and `terminateDebuggee:true` is refused.

## Validation

The [framing](../pcsx2-mcp-server/src/dap-wire.ts) follows the
[official DAP byte transport](https://microsoft.github.io/debug-adapter-protocol/overview):
UTF-8 JSON length and CRLF headers. It rejects malformed/truncated input, invalid
UTF-8, headers above 1 KiB and bodies above 1 MiB. Requests are serialized with
a 64-request queue; stopped-state references are limited to 2048. Native/backend
operations retain their existing time and memory bounds. Polls cannot overlap
an active adapter request.

The live test uses only a copied standalone homebrew, new data root and free
port. Native PID/ELF/root and input hashes are checked. It exercises actual DAP
stdio, with an independent MCP stdio connection at the same native pause:

1. Exact mapped C breakpoint and PC/source line agree with MCP.
2. All GPRs, argument `increment=1` and guarded RAM agree without advancement.
3. Native instruction step advances PC and old frame/scope references refuse.
4. Source next/out/into reach source stops checked against fresh MCP lookups.
5. Same-ELF native reset invalidates old references; fresh explicit attach works.
6. Replaced source-point ownership survives replacement refusal and detach;
   the native process/paused state remain intact. The harness then closes only
   its own emulator, MCP and both DAP processes.

```powershell
rtk proxy python tools/build-standalone-fixture.py release/dap-fixture-new
rtk proxy node pcsx2-mcp-server/test/dap-live.mjs release/windows-mcp-2.9.147/pcsx2-qt.exe release/dap-fixture-new release/standalone-data release/dap-test-new
```

Use a new output directory. The fixture manifest/current sources must agree.
The harness has a three-minute watchdog and per-DAP/MCP request bounds; logs,
transcript, private fixture/config and `validation.json` remain ignored.
Partial/failed reports and exploratory pilots are excluded from acceptance.
Hosted Node CI exercises framing, socket mocks, identity/reference/ownership
failure cases and real stdio refusal/shutdown, not native PCSX2 or an editor.

Local TypeScript and **272 Node tests** passed, including ten DAP test groups.
The accepted native run passed all six groups, stopped both DAP processes and
its MCP/native processes, and records hashes of the exact adapter sources,
compiled entry points and harness. Package dry-run includes the DAP and backend
files plus Python/requirements, without a venv, secrets or private states.
Native and previous executable MCP JavaScript retain their T2 hashes. The new
adapter adds compiled files; one existing declaration, `project-diagnostics.d.ts`,
has reordered object properties when TypeScript includes the new modules.
The 2026-11-02 hash audit rebuilt without DAP and reproduced the exact T2
declaration hash, then verified that the changed declaration contains the same
lines with only property order differences. Its old/new hashes and full diff
are retained in `release/dap-declaration-reorder-20261102.json`/`.patch`.
No native build, executable MCP change or T2 rerun is claimed.

Exploratory runs remain excluded: one mixed up entry/breakpoint events in the
test client, one encountered an intermediate empty ELF identity during reset,
and one failed native spawn before any process existed (`spawn UNKNOWN`).
Subsequent pilots passed; final acceptance uses only the final frozen harness.
Reset recovery is a fresh explicit attach, not automatic retargeting.

```text
release/native-dap-acceptance-20261101/validation.json
release/native-dap-acceptance-20261101/dap-transcript.json
release/dap-node-accepted-20261101.log
release/dap-package-dryrun-20261101.json
release/dap-ci-20261101.json
release/dap-delivery-20261101.json
```

Publication/hash/remote CI details are recorded in the ignored delivery receipt.
D2 must add reusable editor configuration
and an actual VS Code session before the original stage 7 can close. Emulation
does not establish physical PS2 debugging support.
