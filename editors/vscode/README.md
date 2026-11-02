# PCSX2 MCP Debugger for VS Code

Attach VS Code to a running modified PCSX2 v2.9.147 using PCSX2-MCP's separate
EE DAP adapter. This extension does not include an emulator, BIOS, Node runtime,
toolchain, Python environment or project files. Keep the matching debug ELF.

Build `pcsx2-mcp-server` with `npm test`, install this extension's local VSIX,
and set **PCSX2: Adapter Path** to the absolute built `dist/dap.js`. Node 22+
must be on PATH; an absolute Node executable can be set through **Node Path**.
The trusted project workspace owns its `launch.json` and explicit source maps:

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

Select the port of the intended native instance. Set an optional
`expectedSha256` to pin its build. Backend `env` accepts only the documented
`PCSX2_DWARF_PYTHON` and `PCSX2_ADDR2LINE*` options. It neither reads `.env`
files nor prints their values. Optional Python/addr2line installation is
documented in the repository's source-debugging/source-breakpoints guides.

Supported: exact source-line breakpoints, pause/continue, bounded native stack,
EE 128-bit GPRs, supported frame-0 locals and guarded read-only RAM. Source
next/into/out use the existing bounded EE backend. IOP source scopes, expression
evaluation, writes, conditional/log breakpoints, launch, restart and reverse
execution are unavailable. Missing/unsupported data stays explicit. Detach
preserves a paused emulator and changed breakpoint owners; it does not kill
the attached emulator. After an external VM identity change, attach explicitly
to the intended ready ELF again. Hardware PS2 debugging is separate.

GPL-3.0-only; see LICENSE. Original project and full feature contracts:
https://github.com/michaaels/PCSX2-MCP
