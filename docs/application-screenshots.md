# PCSX2 application and debugger screenshots

Implemented and validated on Windows with pinned PCSX2 v2.9.147 on 2026-10-29.
The new **`pcsx2_application_screenshot`** captures the client area of an
existing visible Qt window in the connected native process. It includes menus,
registers, disassembly, breakpoints and other Qt widgets present in that window.

```json
{"target":"debugger"}
```

```json
{"target":"main","width":1280,"height":960}
```

The tool returns an MCP PNG `image` block plus JSON text with `target`,
`source: "qt_widget"`, `window_title`, `width` and `height`. It does not save a
file. Default target is `debugger`; maximum output defaults to 1920×1440.
Width accepts 1–2560, height 1–1600. Scaling preserves the complete widget's
aspect ratio and never enlarges an already smaller image. PNG size is bounded
to 6 MiB and source-window allocation to 16 megapixels. Returned dimensions and
the PNG envelope are validated before MCP image content is emitted.

## Setup and distinction from game screenshots

Use the modified executable at
`D:\dev\PCSX2-MCP\release\windows-mcp-2.9.147\pcsx2-qt.exe`, SHA256
`30105589c77fc97b3a3dd2a678cb7b404ef97a3fd24f81c9b325ad20d6eff4cb`.
Build TypeScript and restart the Node MCP server to load the additional tool;
reconnect to this newly built native process. Merely replacing Node cannot add
the Qt handler to an official executable. The official `release/windows`
installation remains unchanged.

`pcsx2_screenshot` retains the existing rendered PS2-frame contract and its
1280×1024 limits. Application capture uses Qt's
[`QWidget::grab`](https://doc.qt.io/qt-6/qwidget.html#grab), queued on the UI thread.
Qt paints the selected widget and its child widgets into a pixmap. GPU-rendered
game content may be absent from this widget image; use the GS screenshot tool
for the game frame. Application capture excludes the native OS title bar,
external desktop/other apps, separate dialogs and detached dock windows.
It does not promise a compositor-identical image of everything over the window.

Only `main` and `debugger` are accepted; arbitrary HWND/PID/title/desktop targets
are unavailable. The debugger must already be open (for example with
`-debugger` or Debug → Open Debugger). Missing, hidden or minimized windows
return an error. Capture does not create/show/activate windows, click/type,
pause/resume the VM, or invoke the external computer-use helper.

The native core registers a frontend callback. Qt performs widget access on the
UI thread; the TCP worker waits at most five seconds, without blocking the CPU
thread. Late completion retains its own storage and cannot become another
request's response. Timeout does not forcibly interrupt Qt painting/encoding.
No GS image or unrelated window is substituted after a frontend failure.
The feature is advertised as `application_screenshot` only when registered.
Current native server lifecycle still requires a booted VM. Capture of running
debugger widgets is not an atomic CPU/VM snapshot.

## Validation

- Native Windows and TypeScript builds passed; **260 Node tests** passed,
  including five new target/envelope/limit/error/connection checks.
- **Seven application-capture live checks** passed through actual MCP stdio:
  debugger and main PNGs decoded, bounded resize, unchanged paused cycles/PC,
  native identity and breakpoints, refused desktop target, missing debugger in
  another process, and independent targeting/recovery across those processes.
- **60 standalone live regressions** passed on the final executable, including
  the existing GS screenshot/video, instruction/IRQ, source, SIF, reconnect and
  savestate checks. All owned processes stopped.
- **29 native files** match pristine/reapply/build. Upgrade from M1 on 2.9.147
  and the older integration on its own 2.6 source both pass source comparison;
  this delivery does not claim a new 2.6 runtime build.
- The actual debugger and main PNGs were visually inspected. The main-window
  test was paused before its game display had a rendered frame; its menus and
  status bar still captured successfully.

Minimized-window behavior, UI-stall/late-completion fault injection, high-DPI
coverage, GPU compositor equivalence and other operating systems are not
accepted by these runs. No physical PS2, arbitrary project or media-server
acceptance is claimed. Widget capture supplies images, not GUI input control.

The earlier manual GUI source-group test also passed: the operator changed
`0x00100220` to `GUI-OWNED`, native cleanup preserved it and repeat removal
refused with the same paused CPU/identity. [Scope](gui-ownership-test.md).
Replacement during an in-flight EE instruction `step_over` subsequently passed
in [S2b2c2](inflight-gui-ownership.md), including another native debugger PNG.
Other GUI breakpoint options retain separate pending coverage.

Evidence and exclusions:

```text
release/application-capture-live-20261029/validation.json
release/application-capture-live-20261029/debugger.png
release/application-capture-live-20261029/main.png
release/application-capture-standalone-20261029/validation.json
release/application-capture-integration-final-20261029/integration.json
release/application-capture-integration-legacy-20261029/integration.json
release/application-capture-build-20261029.log
release/application-capture-delivery-20261029.json
```

The first integration-check attempt failed because its reconstructed previous
MCP omitted that version's compatibility header. The checker now restores all
tracked plugin files from the requested commit; both final comparisons passed.
That failed attempt is excluded. The first compilation reused the old shared
M1 log filename and overwrote its historical contents. The M1 receipt's old
build-log digest therefore no longer matches that path; this is an evidence
loss, not a reproduced M1 build log. The new log was copied to
`release/application-capture-first-build-20261029.log`, and subsequent builds
use the separate filename above. The old accepted executable was backed up
before compilation as `release/pcsx2-mcp-2.9.147-before-application-capture.exe`
and retains SHA256 `51042a6330a7e63184bf7fe976dfe19a6e7210043c83a7670eb0c8c132b6914f`.
