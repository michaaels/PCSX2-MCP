# Savestate companion inspection — F5a

This is the verified prerequisite for savestate-start input movies. The new
offline MCP tool, `pcsx2_input_state_inspect`, checks a companion archive before
native startup/replay integration. The subsequent
[F5b delivery](input-state-movies.md) enables state-start recording/replay with
actual native outcomes. No native binary changes or emulator launch occurred
in F5a itself; its historical evidence below remains separate.

```json
{"path":"D:/artifacts/movie.p2m2_SaveState.p2s","expected_sha256":"<64 hexadecimal characters>"}
```

`expected_sha256` is optional. Paths must be absolute local filesystem paths.
Build/restart the Node MCP server to discover the new tool. Node **22.15+** is
required for the CRC/Zstandard APIs. No new package dependency is introduced;
an older runtime reports the unavailable codec when this tool is used rather
than pretending to verify its payload.

## What a successful result proves

- A stable bounded read produced the returned complete-file SHA256. A supplied
  fingerprint matched; observed file identity/size/timestamps remained stable
  through verification. This is not a permanent filesystem lock.
- A finalized, single-disk, comment-free ZIP32 has consistent central/local
  headers, safe distinct entry names and contiguous nonoverlapping extents.
  Required PCSX2 components are present, with exact fixed memory-region sizes.
- Stored, Deflate and the pinned producer's single-frame Zstandard entries
  decode to their declared lengths and ZIP CRC32 values. Deflate consumes its
  complete input. Zstandard frame/block/checksum boundaries are independently
  checked before decoding, including missing-checksum rejection.
- The 36-byte version record carries `0x9a590000`, the format used by pinned
  PCSX2 v2.9.147. The producer text is explicitly `producer_reported`, not
  authentication of the emulator that wrote an arbitrary file.

The report deliberately retains `native_load:not_performed`,
`elf_association:not_verified` and `determinism:not_established`. Byte/CRC/format
validity does not prove that the core will deserialize arbitrary structures,
that the state belongs to the running ELF, or that a movie is deterministic.
No memory, BIOS or controller payload is returned; only hashes and bounded
archive/component metadata are emitted. The tool does not connect, load,
pause, resume, copy over, repair or delete the inspected source.

## Bounds and supported subset

| Area | Bound |
|---|---:|
| Compressed file | 128 MiB |
| Total declared/actual decoded bytes | 128 MiB |
| One decoded entry | 64 MiB |
| Entries / ASCII filename bytes | 32 / 128 |
| Zstandard window | 64 MiB maximum |
| Zstandard blocks per single frame | 16,384 |
| Cooperative verification deadline | 15 seconds |

Payloads stream through CRC/length checks rather than accumulating decoded RAM
in the result. Cancellation/deadline signals stop stream pipelines and are
checked around filesystem work. A pending OS filesystem operation or native
codec call is not a real-time interruptible core operation. These are parser/
payload bounds, not an OS process-memory quota.

ZIP64, split/commented archives, encryption/data descriptors, duplicate names,
traversal paths, arbitrary compression methods, Zstandard dictionaries,
concatenated/skippable frames and other savestate format versions are outside
this initial pinned-producer subset. Unknown safe components can be inspected
within the same budgets, but do not substitute for required native entries.

## Evidence

TypeScript and **283 Node tests** passed. Five added test groups cover mixed
codecs, native-format sizes/limits, local/directory mismatches, missing/trailing
ZIP finalization, missing/duplicate components, unsafe/encrypted entries,
decoded-size/expansion fraud, CRC corruption, extra Deflate bytes, truncated
Zstandard checksums, incompatible version, SHA mismatch and cancellation.
Structural unit archives explicitly do not claim native-loadable RAM.

Five checks through actual MCP stdio passed using an unchanged, SHA-pinned
state saved by the previously accepted v2.9.147 native run. Every real component
decoded and passed CRC, including 32 MiB EE RAM and Zstandard components.
Wrong SHA, removed ZIP end record and an actually flipped payload byte were
refused; the original and ordinary copy remained unchanged. The owned MCP
child closed. This reuses the historical native artifact, not a new state-load,
recording or native-emulation acceptance run.

```text
release/input-state-inspection-accepted-20261102/validation.json
release/input-state-node-final-20261102.log
release/input-state-ci-20261102.json
release/input-state-delivery-20261102.json
```

The native state source is the M1 acceptance's
`state-load/instance/sstates/standalone (5B4BA2DA).04.p2s`, SHA256
`8356b38e9b0ffe2dd0fd89b5e83d65b14dcf6a9a71cd9714be42227c93546890`.
All `.p2s` files, corrupt controls and logs stay ignored in `release/`.
CI runs the source tests on Windows/Ubuntu and syntax-checks the MCP harness;
it does not supply BIOS, launch an emulator or establish native Linux support.

## Next native work

F5b must confirm asynchronous companion save completion, prepare/hash-check
private movie/state copies before state application, retain source ownership,
prove actual restore outcomes and RAM, and exercise cancellation/late completion,
invalid companions, replay EOF and power-on regressions. No completion of F5b
or the full savestate-start feature is implied by this inspector.

Source facts were checked against the pinned `SaveState.cpp`/`VMManager.cpp`:
`Host::OnSaveStateSaved` occurs after queueing, while `SaveState_ZipToDisk`
finishes only after `zip_close` succeeds. It cannot be used as a success receipt.
The independent compressed-frame guard also covers the behavior demonstrated
locally on Node v26.4.0 and tracked in
[Node's truncated-Zstandard issue](https://github.com/nodejs/node/issues/64592).
Framing follows the [Zstandard format](https://github.com/meta/zstd/blob/dev/doc/zstd_compression_format.md);
codec/CRC APIs use [Node zlib](https://nodejs.org/api/zlib.html).
