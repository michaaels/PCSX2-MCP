# VS Code integration and actual editor acceptance — D2

Validated on Windows with VS Code **1.144.0**, the modified pinned PCSX2
**v2.9.147**, Node v26.4.0 locally and the existing EE DAP backend. The original
roadmap's editor gate is accepted for the scope below. No physical PS2, SMS,
Jellyfin or unrelated project acceptance is implied.

## Install the reusable extension

Build the Node server with `npm test`. Package the small launcher extension with
the versioned official packager (Node 22+):

```powershell
cd D:\dev\PCSX2-MCP\editors\vscode
rtk proxy npx --yes @vscode/vsce@4.1.0 package --no-dependencies --out D:\artifacts\pcsx2-debugger.vsix
rtk proxy code --install-extension D:\artifacts\pcsx2-debugger.vsix
```

Create the chosen output parent directory first. The extension is GPL-3.0-only
and includes the repository license. It contains the launcher, configuration
validator and documentation. It deliberately uses your separately built
`pcsx2-mcp-server/dist/dap.js`; no BIOS, emulator, Node executable, venv, ELF,
project sources or local settings are included in the VSIX. The validated local
artifact remains ignored at `release/pcsx2-debugger-0.1.0-20261102-02.vsix`.
This delivery does not publish to the VS Code Marketplace or change the user's
global extension/settings profile; acceptance installs into a new test profile.

Set **PCSX2: Adapter Path** to the absolute built `dist/dap.js` in your local
VS Code settings. **PCSX2: Node Path** defaults to `node` on PATH and also accepts
an absolute executable. Keep machine paths in those local settings. A trusted
project's `.vscode/launch.json` can remain portable:

```json
{
  "version": "0.2.0",
  "configurations": [{
    "name": "PCSX2: attach EE",
    "type": "pcsx2",
    "request": "attach",
    "elf": "${workspaceFolder}/build/game-debug.elf",
    "port": 21512,
    "stopOnAttach": true,
    "pathMappings": [{ "from": "/build/project", "to": "${workspaceFolder}" }]
  }]
}
```

Start the intended modified emulator/local debug ELF first. Select its actual
DebugServer port. `expectedSha256` optionally pins that build; the adapter also
records/verifies the observed local ELF SHA. Configure the optional pinned
[DWARF Python backend](source-breakpoints.md) and [addr2line](source-debugging.md)
as for MCP. The optional `env` object permits only `PCSX2_DWARF_PYTHON`,
`PCSX2_ADDR2LINE_BACKEND`, `PCSX2_ADDR2LINE` and `PCSX2_ADDR2LINE_WSL_DISTRO`.
No `.env` file is read automatically and environment values are not logged.

VS Code substitutes project variables before the provider validates existing
absolute files, port, backend options and source mappings. The launcher uses
argument arrays, with no shell command string. C/C++ breakpoint contributions
and an attach configuration/snippet are provided. Untrusted workspaces are
unsupported; the provider guard is covered by source tests. Actual Restricted
Mode UI acceptance is not claimed by the trusted-profile run.

## Actual editor test

The harness launches an owned homebrew/native process on a private port/root,
installs the VSIX with the installed VS Code CLI into new extension/user-data
directories, and runs the **actual Extension Development Host against that
installed package**. It uses the real VS Code debug API and workbench commands,
not a simulated DAP client. A generated `launch.json` contains `${workspaceFolder}`
for ELF/source mapping; the adapter/Node paths come from isolated settings.
The separate test runner is excluded from the VSIX.

Four accepted groups:

1. The editor starts the named project configuration, verifies the exact C
   breakpoint and executes the actual **Continue** command. It stops at line 7
   and automatically opens/selects that source line. Editor document SHA matches
   the fixture source; the test does not emulate source navigation.
2. The editor session's PC/source, all 32 full-width EE GPRs, `increment=1` and
   four bytes of guarded RAM agree with independent MCP/native inspection at
   the same unchanged paused state.
3. The actual editor **Step Over** command reaches another source line/PC checked
   against fresh MCP lookup. Previous frame references are rejected.
4. Editor detach retains the native PID/paused state, with no owned breakpoint
   left. The DAP process exits **0**; the MCP child closes. The editor/test roots
   and native fixture subsequently close successfully.

The final run passed these groups, plus **278 Node tests** and the repeated six
[native DAP regression groups](dap.md). The native binary remains unchanged.
The only executable Node changes are in DAP: normal disconnect now flushes its
response/terminated event and exits itself instead of waiting for editor
termination; unresolved DWARF frames no longer advertise a fictitious source
path such as `<built-in>`. Dedicated source tests cover both corrections.

```powershell
rtk proxy node D:\dev\PCSX2-MCP\pcsx2-mcp-server\test\vscode-live.mjs "C:\path\to\VS Code\Code.exe" D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe D:\path\to\standalone-fixture D:\path\to\configured-root D:\artifacts\editor-new D:\artifacts\pcsx2-debugger.vsix
```

Use a new output directory and an existing compiled/hash-matching standalone
fixture. The Windows harness understands the installed `bin/code.cmd` CLI
layout, uses a three-minute watchdog, 4 MiB per-process log budgets and bounded
request/transcript handling. It does not kill existing editor/emulator instances.
Test-profile updates, telemetry and built-in AI features are disabled to keep
unrelated background services out of this validation. This changes only the
new test profile. Node CI syntax-checks the harness and tests the validator/
launcher contract, but hosted CI does not launch PCSX2 or VS Code.

## Evidence and limits

```text
release/editor-acceptance-final-20261102/validation.json
release/editor-acceptance-final-20261102/editor-validation.json
release/editor-acceptance-final-20261102/editor-transcript.json
release/editor-acceptance-final-20261102/fixture/.vscode/launch.json
release/editor-dap-regression-20261102/validation.json
release/editor-node-tests-accepted-20261102.log
release/pcsx2-debugger-0.1.0-20261102-02.vsix
release/editor-ci-20261102.json
release/editor-delivery-20261102.json
```

The first pilot failed a Windows drive-letter comparison in the test; subsequent
functional pilots passed but allowed the adapter to exit 1 after editor detach.
They remain excluded from final acceptance. The strict final run requires exit
0 and hashes its exact runtime/extension/runner inputs. Mutable profile settings
have separate initial/final hashes because VS Code can migrate settings; final
settings remained unchanged. An earlier pilot enabled VS Code's default agent
services, which attempted an unrelated plugin repository update and refused
because local changes existed. The final isolated profile disables those AI
features and performs no such plugin update. No existing plugin changes were
discarded or committed by this work.

This is a trusted Windows C-homebrew editor session. Broader C++ layouts,
multi-root/remote editors, native Linux, all breakpoint options and physical
hardware are not accepted. Supported EE operations and their backend limits
remain those in [DAP](dap.md), [variables](variables.md) and
[source stepping](source-stepping.md). No expression evaluation, writes,
automatic emulator launch/restart, IOP source locals or reverse execution is
advertised. Unavailable data stays explicit.

The extension uses the documented
[debugger contribution/factory API](https://code.visualstudio.com/api/extension-guides/debugger-extension)
and [Extension Host test entry](https://code.visualstudio.com/api/working-with-extensions/testing-extension).
The isolated AI setting follows the
[VS Code FAQ](https://code.visualstudio.com/docs/supporting/faq).
