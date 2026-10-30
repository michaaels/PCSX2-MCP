// SPDX-FileCopyrightText: 2026 PS2Recomp Debug Bridge
// SPDX-License-Identifier: MIT
//
// PCSX2 Debug Server — JSON/TCP API wrapping DebugInterface
// Drop this into pcsx2/DebugTools/ and add to CMakeLists.txt
//
// Features:
//   - Full 128-bit register R/W (all 7 categories: GPR, CP0, FPR, FCR, VU0F, VU0I, GSPRIV)
//   - Native PCSX2 disassembly
//   - Expression evaluation with symbol lookup
//   - Conditional breakpoints with expression conditions
//   - Memory watchpoints (read/write/onChange)
//   - Thread list, module list
//   - Pause/Resume/Step execution control
//   - Memory R/W (8/16/32/64/128 bit)
//   - Stack walk

#pragma once

#include <string>
#include <thread>
#include <atomic>
#include <functional>
#include <cstdint>
#include <vector>

namespace DebugServer
{
	struct ApplicationScreenshot
	{
		uint32_t width = 0, height = 0;
		std::vector<uint8_t> png;
		std::string title, error;
	};
	using ApplicationScreenshotCompletion = std::function<void(ApplicationScreenshot)>;
	using ApplicationScreenshotHandler = std::function<void(std::string, uint32_t, uint32_t, ApplicationScreenshotCompletion)>;
	// Frontend registers an asynchronous UI-thread handler; other hosts remain unsupported.
	void SetApplicationScreenshotHandler(ApplicationScreenshotHandler handler);
	// CPU thread only. PCSX2_DEBUG_PORT overrides the default per process.
	// A failed bind does not start a session. Stop before starting another VM.
	void Start(int port = 21512);

	// Stop the server and close all connections
	void Stop();

	// Check if server is running
	bool IsRunning();

	// Called on a real instruction breakpoint or memory watchpoint hit.
	void OnBreakpointHit(bool iop, bool watchpoint);

	// Called on the CPU thread after an actual VM state transition.
	void OnVMStateChanged(int state);
	void OnVSync();
	void OnInputPoll();
	// CPU thread: owned input movies bypass the GUI rerecording loop.
	bool HandleInputMoviePoll();
	bool AllowInputRecordingStart();
	void OnInputRecordingIOError();
	void OnVMReset();
	// GS thread hooks, restricted to the exact dump file owned by this server.
	void OnGSDumpOpened(const std::string& path, bool opened);
	bool GSDumpWriteAllowed(const std::string& path, uint64_t bytes);
	void OnGSDumpFramesComplete(const std::string& path);
	void OnGSDumpClosed(const std::string& path, bool complete);
	bool CaptureVideoFrameAllowed(const std::string& path);
	bool CapturePacketAllowed(const std::string& path, uint64_t bytes);
	bool OwnsMediaCapture(const std::string& path);
	void OnCaptureError(const std::string& path);
	void OnCaptureClosed(const std::string& path, bool complete);
	void OnEEException(uint32_t code, uint32_t pc, bool branchDelay, bool nested);
	void OnIOPException(uint32_t code, uint32_t pc, bool branchDelay, uint32_t previousStatus);
	void OnIOPReset();
	void OnIOPModuleListLocated(uint32_t address);
	// CPU-thread observers only; never handle/replace the original guest calls.
	void OnIOPHostFileOpened(int fd, const std::string& path, bool readonly);
	bool IsObservedIOPFile(int fd);
	void OnIOPHostFileRead(int fd, int64_t offset, const void* data, uint32_t length);
	void OnIOPHostFileClosed(int fd);
	void OnIOPLoadObject(uint32_t buffer, uint32_t fileInfo);
	void OnIOPModuleRegister(uint32_t record);
	void OnIOPModuleRelease(uint32_t record);
	void OnIOPModuleService(uint32_t ordinal);
	void OnSIF1Tag(uint32_t address, uint32_t words, bool interrupt);
	void OnSIF1Write(uint32_t address, uint32_t words);
	// CPU-thread observation only: called after the original PGIF DMA write.
	void OnPgifDmaWrite(uint32_t address, uint32_t value, uint32_t bits, uint32_t before, uint32_t after);
	void OnStateLoadAttempt();
	bool IOPExceptionCaptured();
	// CPU thread: retain a pending hardware IRQ at a paused debugger boundary.
	bool DeferIOPInterruptDispatch();
	// JIT trap call sites: preserve provenance without changing guest PC/CP0/BD.
	// taggedInstructionPC: aligned PC with bit 0 carrying the delay-slot flag.
	void ExecuteEEBreak(uint32_t taggedInstructionPC, uint32_t opcode);
	void ExecuteEESyscall(uint32_t taggedInstructionPC, uint32_t opcode);
	void ExecuteIOPException(uint32_t taggedInstructionPC, uint32_t rawBranchDelay);
	bool PreserveStepWatchpoints();

} // namespace DebugServer
