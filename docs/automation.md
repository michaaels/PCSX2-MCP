# Emulator launch and video/input automation

This extension adds five MCP tools. The Node server and native PCSX2 patch must both
be rebuilt using the integration script. Pine-only and the original release binary
do not support native automation.

| Tool | Behavior |
|---|---|
| `pcsx2_launch` | Starts a patched PCSX2 with an ELF, validates the ELF header, returns SHA256/entry address and connects automatically. |
| `pcsx2_stop` | Terminates only a process launched by this MCP instance. Unsaved VM state is lost. |
| `pcsx2_frame_advance` | Runs a paused VM for 1–600 guest video VSync steps and pauses again. |
| `pcsx2_input` | Holds a DualShock2 button combination and analog coordinates for 1–600 VSync steps, restores the prior controller state and pauses. |
| `pcsx2_get_controller` | Reads the virtual DualShock2 buttons and analog coordinates. |

## Launch and ownership

Pass absolute paths on the machine running the MCP server:

```json
{
  "executable": "D:\\dev\\PCSX2-MCP\\release\\windows\\pcsx2-qt.exe",
  "elf": "D:\\dev\\PS2\\project\\build\\game.elf",
  "portable": true,
  "timeout_ms": 20000
}
```

PCSX2 needs a configured BIOS. Portable mode uses the settings beside the executable;
`portable: false` uses PCSX2's normal settings. The launcher runs `-nogui -fastboot`
without a shell, with the executable directory as its working directory. Console
windows are hidden on Windows; the emulator may still display its rendering window.
ELFs must have a readable 32-bit little-endian MIPS header and be no larger than 256 MiB.

The launcher refuses an occupied selected TCP port (21512 by default). It then verifies that the native
`process_id` reported by `pcsx2_capabilities` matches its child PID, so it cannot
silently attach to another emulator that wins a startup race. The returned SHA256
identifies the input ELF at launch time. Native DebugServer readiness does not mean
the ELF has reached its entry point or produced an image: use an entry breakpoint,
logs, the current ELF/CRC, or a bounded screenshot retry as appropriate.

Failed/cancelled startup terminates only its own child process. A second launch is
rejected while the first is starting or running. `pcsx2_stop` refuses an externally
attached process, including one left running by an earlier MCP instance. It is a
process termination operation rather than a save-state or graceful shutdown tool.

The child is unreferenced and is not explicitly killed on normal MCP input closure;
native sockets are disconnected. After a Codex/MCP restart, use `pcsx2_connect` to
attach to a surviving game. Process survival may also depend on the host's process
management policy. Ownership is not transferred to the new MCP instance.

### Independent instances

`pcsx2_connect` and `pcsx2_launch` default to `PCSX2_DEBUG_PORT` (21512 if absent).
The connection's Pine default is `PCSX2_PINE_PORT` (28011 if absent). Values must
be decimal integers from 1 to 65535; malformed environment values fail rather
than silently selecting another instance. Explicit tool ports use the same bounds.

`pcsx2_launch` accepts `debug_port` and an optional absolute `data_directory`:

```json
{"executable":"D:\\pcsx2\\pcsx2-qt.exe","elf":"D:\\project\\game.elf","debug_port":22512,"data_directory":"D:\\pcsx2-instances\\test-a"}
```

The data root must already contain a configured `inis/PCSX2.ini`, including BIOS
location and setup completion. The launcher does not copy a BIOS or configure a
new emulator. It passes `PCSX2_DEBUG_PORT` and `PCSX2_MCP_DATA_DIR` only to its
child and verifies the native PID, listening port and requested data root.
Rebuild the native patch and TypeScript server before using this launcher.

Run a separate MCP process for each concurrent emulator, selecting a distinct
debug port and data root. The native override selects settings before they load;
relative cache, memory-card and output paths therefore belong to that root.
Explicit absolute folder paths in an INI can still share files: configure those
separately when isolation is required. The Pine environment variable selects a
client endpoint; configure Pine's native port separately in each instance's INI,
or disable Pine and use DebugServer. It does not reconfigure native Pine.

The DebugServer binds localhost and uses an exclusive Windows bind. A failed
bind does not start a debug session. Stopping the VM shuts down client sockets;
queued CPU work from an ended server session is rejected. Native server lifecycle
remains tied to VM startup/shutdown; changing an environment variable does not
reload a running server. At most 32 client sockets are retained per process.

Windows acceptance on 2026-10-21: 94 Node tests and the separate
`test/instance-ports-live.mjs` check cover two emulator processes, private roots,
port collision, independent pause, two rendered PNGs, shutdown and restart.
Same-process GUI VM shutdown/reboot and non-Windows lifecycle behavior have not
been exercised by this live test.

Reproduce the instance check from `pcsx2-mcp-server`, substituting absolute paths
and a new output directory (the configured root must locate its BIOS):

```text
node test/instance-ports-live.mjs <PCSX2> <rendering-ELF> <configured-data-root> <new-output>
```

Local evidence: `release/instance-ports-validation-20261021-final/validation.json`
contains 7 passed checks and two PNGs beside the receipt. The separate
`release/instance-ports-automation-regression-20261021/results.json` records
11 automation checks, including real entry breakpoint/reset, controller cleanup
and context capture. These are emulator checks, not physical PS2 acceptance.
`python tools/check-integration.py pcsx2-src <new-output>` verifies pristine,
upgrade from `26b5d06`, reapplication and build-checkout agreement for 15 native
files; receipt: `release/instance-ports-integration-20261021/integration.json`.
The data-root hook adds `pcsx2/Pcsx2Config.cpp` to the integrated source set.
Port-selection/isolation ideas were reviewed from Ryubara commits `c010c72`
and `3fb80b8`; this implementation retains the pinned v2.6.3 and our protocol.

## Video and controller steps

First call the existing `pcsx2_pause` tool, then:

```json
{"frames":60,"timeout_ms":20000}
```

Or hold a button combination and analog coordinates:

```json
{
  "controller":0,
  "buttons":["cross","right"],
  "left_x":127,
  "left_y":127,
  "right_x":127,
  "right_y":127,
  "frames":6
}
```

Controller 0/1 means physical port 1/2, slot 1. That port must already be configured
as DualShock2; other devices and multitap slots are not supported by these tools.
The digital names are `up`, `right`, `down`, `left`, `triangle`, `circle`, `cross`,
`square`, `select`, `start`, `l1`, `l2`, `r1`, `r2`, `l3`, `r3`. Unlisted digital
buttons are released during the operation. Analog coordinates are raw bytes 0–255,
with 127 neutral, lower X left, lower Y up. Raw injection bypasses host sensitivity
and deadzone adjustments; guest software still decides whether to read analog mode.
This iteration does not expose per-button pressure or the analog-mode toggle.

Input is applied at operation start and after native input polling. The saved button
pressures/button state and analog coordinates are restored at completion, cancellation,
early pause, VM reset or VM shutdown. Use the controller exclusively during automation:
physical input/macro/profile changes can conflict with the temporary virtual override.
If the controller device is replaced, the operation stops without restoring data into
the replacement device. Input recording/playback and hardcore mode are rejected.

Video steps use `VMManager::FrameAdvance`; CPU-thread hooks count actual VSync boundaries.
The native cancellation helper clears the remaining frame count without resuming the VM.
This prevents a cancelled operation from causing an unexpected auto-pause later.
These counts are not host FPS, encoded video frames, or guaranteed distinct screenshots.
They do not make external networking, audio or the game itself deterministic.

Results include `operation_id`, `start_frame`, `target_frame`, `frames_advanced`,
`active`, `reason`, `paused` and `completed`. An early breakpoint/manual pause returns
`completed: false` and a tool error with the actual result. One operation can be active
in the emulator; concurrent frame/input tools on the same connection are rejected.
Avoid unrelated GUI frame advance and external automation clients during a run.

The MCP polls short native status requests, allowing other tools to run between polls.
Timeout/cancellation requests a native stop and controller restoration. If that cannot
be confirmed after a connection failure, the error explicitly says so. The native
operation also expires after 30 seconds when CPU VSync/input-poll hooks can run. A VM
stuck inside a blocking host operation cannot execute cleanup until its CPU thread
becomes responsive. The default tool wait is 20 seconds, maximum 30 seconds.

## Native protocol additions

All commands use the existing newline JSON transport. Short operations run on the
CPU thread. Advanced clients can use `frame_advance` or `input_frames`, then
`automation_status` / `automation_cancel` with the returned `operation_id`.
`input_frames.buttons` is a 16-bit mask in the digital-name order above, **not** the
PS2 controller packet bit order. Analog coordinates are integers. `controller_state`
reports the same logical mask. Capabilities now include `process_id`, `frame_advance`,
`input_frames` and `controller_state`; old patches should be rebuilt.

## Validation

Automated bridge/MCP checks: `npm test` (24 tests with this extension).

Optional native test, using its own emulator via MCP launch/stop:

```text
node test/automation-live.mjs path/to/pcsx2-qt.exe path/to/homebrew.elf path/to/artifacts
```

Validated with PCSX2 v2.6.3, MSVC 19.51, Qt 6.12.0 and Direct3D 11 on Windows:

- Failed child startup allows a subsequent launch.
- PID/ELF identity and automatic DebugServer connection.
- A second MCP refuses an occupied port and cannot stop the first process.
- Exact 1, 7 and 60 VSync counts with final pause.
- Digital combination and raw analog injection, with prior state restoration.
- Manual interruption, explicit cancellation, and timeout cleanup.
- No residual native frame count causing a later auto-pause.
- A real breakpoint at the ELF entry interrupts input automation and restores the controller.
- Context report and actual rendered PNG after automation.
- Owned stop and rejection of another stop.

Guest button reads/reactions are not separately instrumented by this test; it verifies
the virtual device's state and actual CPU/video execution. Hardcore/recording rejection
and controller replacement handling compile but have not been exercised live. Linux,
other renderers, commercial games and physical PS2 hardware remain unvalidated for this
extension. [Symbol lookup and scenario runners](workflows.md) are available in the next
extension; full source-line debugging remains separate work.
