#!/usr/bin/env python3
"""Integrate this DebugServer into the documented pinned PCSX2 source revisions."""
import argparse
from pathlib import Path
import shutil


def replace_once(text: str, before: str, after: str, filename: str) -> str:
    if after in text:
        return text
    if text.count(before) != 1:
        raise SystemExit(f'{filename}: integration point not found uniquely; check the upstream revision')
    return text.replace(before, after, 1)


def write_if_changed(target: Path, text: str) -> None:
    if target.read_text(encoding='utf-8') != text:
        target.write_text(text, encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Full upstream PCSX2 source checkout')
    source = parser.parse_args().source.resolve()
    repo = Path(__file__).resolve().parent.parent
    cmake = source / 'pcsx2/CMakeLists.txt'
    vm = source / 'pcsx2/VMManager.cpp'
    if not cmake.is_file() or not vm.is_file():
        raise SystemExit('Expected a full upstream PCSX2 source checkout')

    # Validate all integration points before writing any source files.
    cmake_text = replace_once(cmake.read_text(encoding='utf-8'),
        '\tDebugTools/DebugInterface.cpp',
        '\tDebugTools/DebugServer.cpp\n\tDebugTools/DebugServer.h\n\tDebugTools/DebugInterface.cpp', str(cmake))
    vm_text = replace_once(vm.read_text(encoding='utf-8'), '#include "VMManager.h"',
        '#include "VMManager.h"\n#include "DebugTools/DebugServer.h"', str(vm))
    vm_text = replace_once(vm_text,
        '\ts_state.store(VMState::Paused, std::memory_order_release);\n\tHost::OnVMStarted();',
        '\ts_state.store(VMState::Paused, std::memory_order_release);\n\tDebugServer::Start();\n\tHost::OnVMStarted();', str(vm))
    vm_text = replace_once(vm_text, 'void VMManager::Shutdown(bool save_resume_state)\n{',
        'void VMManager::Shutdown(bool save_resume_state)\n{\n\tDebugServer::Stop();', str(vm))
    vm_text = replace_once(vm_text, 'void VMManager::Reset()\n{',
        'void VMManager::Reset()\n{\n\tDebugServer::OnVMReset();', str(vm))
    vm_text = replace_once(vm_text, 'void VMManager::Internal::VSyncOnCPUThread()\n{',
        'void VMManager::Internal::VSyncOnCPUThread()\n{\n\tDebugServer::OnVSync();', str(vm))
    vm_text = replace_once(vm_text,
        '\t\tg_InputRecording.handleControllerDataUpdate();\n\t}\n}',
        '\t\tg_InputRecording.handleControllerDataUpdate();\n\t}\n\tDebugServer::OnInputPoll();\n}', str(vm))
    poll_start = 'void VMManager::Internal::PollInputOnCPUThread()\n{\n\tHost::PumpMessagesOnCPUThread();\n\tInputManager::PollSources();\n'
    vm_text = replace_once(vm_text, poll_start,
        poll_start + '\tif (DebugServer::HandleInputMoviePoll()) return;\n', str(vm))
    vm_text = replace_once(vm_text, 'void VMManager::FrameAdvance(u32 num_frames /*= 1*/)\n{',
        'void VMManager::CancelFrameAdvance()\n{\n\ts_frame_advance_count = 0;\n}\n\n'
        'void VMManager::FrameAdvance(u32 num_frames /*= 1*/)\n{', str(vm))
    vm_h = source / 'pcsx2/VMManager.h'
    vm_h_text = replace_once(vm_h.read_text(encoding='utf-8'), '\tvoid FrameAdvance(u32 num_frames = 1);',
        '\tvoid FrameAdvance(u32 num_frames = 1);\n\n\t// CPU thread only: cancel remaining automated video frames.\n\tvoid CancelFrameAdvance();', str(vm_h))

    config = source / 'pcsx2/Pcsx2Config.cpp'
    config_text = replace_once(config.read_text(encoding='utf-8'), '#include "common/FileSystem.h"',
        '#include "common/FileSystem.h"\n#include "common/Error.h"', str(config))
    config_text = replace_once(config_text, 'bool EmuFolders::SetDataDirectory(Error* error)\n{',
        'bool EmuFolders::SetDataDirectory(Error* error)\n{\n'
        '\t// Optional per-process MCP instance root, selected before any settings load.\n'
        '\tif (const char* root = std::getenv("PCSX2_MCP_DATA_DIR"))\n'
        '\t{\n\t\tif (!Path::IsAbsolute(root))\n\t\t{\n'
        '\t\t\tError::SetStringView(error, "PCSX2_MCP_DATA_DIR must be an absolute path");\n'
        '\t\t\treturn false;\n\t\t}\n'
        '\t\tDataRoot = Path::Canonicalize(root);\n'
        '\t\tSettings = Path::Combine(DataRoot, "inis");\n'
        '\t\treturn FileSystem::EnsureDirectoryExists(DataRoot.c_str(), false, error) &&\n'
        '\t\t\tFileSystem::EnsureDirectoryExists(Settings.c_str(), false, error);\n\t}\n', str(config))

    # Preserve the GUI/file logging sinks. This independent atomic observer only
    # receives INFO-or-higher console messages while the MCP server is active.
    console_h = source / 'common/Console.h'
    console_cpp = source / 'common/Console.cpp'
    console_h_text = replace_once(console_h.read_text(encoding='utf-8'),
        '\t// adds host output',
        '\t// Independent diagnostic observer, called on the logging thread.\n'
        '\tvoid SetObserver(HostCallbackType callback);\n\n\t// adds host output', str(console_h))
    console_text = replace_once(console_cpp.read_text(encoding='utf-8'),
        '#include <mutex>', '#include <atomic>\n#include <mutex>', str(console_cpp))
    console_text = replace_once(console_text, '\tstatic HostCallbackType s_host_callback;',
        '\tstatic HostCallbackType s_host_callback;\n\tstatic std::atomic<HostCallbackType> s_observer{nullptr};', str(console_cpp))
    console_text = replace_once(console_text, 'LOGLEVEL Log::GetMaxLevel()\n{\n\treturn s_max_level;\n}',
        'void Log::SetObserver(HostCallbackType callback)\n{\n\ts_observer.store(callback);\n}\n\n'
        'LOGLEVEL Log::GetMaxLevel()\n{\n\treturn std::max(s_max_level, s_observer.load() ? LOGLEVEL_INFO : LOGLEVEL_NONE);\n}', str(console_cpp))
    # Three write entry points bypass GetMaxLevel() in upstream.
    if '\tif (level > s_max_level)' in console_text:
        if console_text.count('\tif (level > s_max_level)') != 3:
            raise SystemExit(f'{console_cpp}: unexpected log filter count')
        console_text = console_text.replace('\tif (level > s_max_level)', '\tif (level > GetMaxLevel())')
    console_text = replace_once(console_text, '\tpxAssert(level > LOGLEVEL_NONE);',
        '\tif (level <= LOGLEVEL_INFO)\n\t{\n\t\tif (const auto observer = s_observer.load())\n'
        '\t\t\tobserver(level, color, message);\n\t}\n\n\tpxAssert(level > LOGLEVEL_NONE);', str(console_cpp))

    # State transitions are emitted after CPU/GS synchronization.
    vm_text = replace_once(vm_text,
        '\t\tCpu->ExitExecution();\n\t}\n}\n\n',
        '\t\tCpu->ExitExecution();\n\t}\n\tif (state != old_state)\n'
        '\t\tDebugServer::OnVMStateChanged(static_cast<int>(state));\n}\n\n', str(vm))

    breakpoint_files = {}
    ee = source / 'pcsx2/R5900.cpp'
    ee_text = replace_once(ee.read_text(encoding='utf-8'), '#include "R5900.h"',
        '#include "R5900.h"\n#include "DebugTools/DebugServer.h"', str(ee))
    start = ee_text.index('__ri void cpuException(u32 code, u32 bd)')
    end = ee_text.index('\n}', start) + 2
    block = ee_text[start:end]
    block = replace_once(block, '__ri void cpuException(u32 code, u32 bd)\n{',
        '__ri void cpuException(u32 code, u32 bd)\n{\n\tconst u32 mcpExceptionPC = cpuRegs.pc;\n\tconst bool mcpNestedException = cpuRegs.CP0.n.Status.b.EXL != 0;', str(ee))
    hook = 'DebugServer::OnEEException(code, mcpExceptionPC, bd != 0, mcpNestedException);'
    block = block.replace('DebugServer::OnEEException();', hook)
    if hook not in block:
        block = block.replace('cpuUpdateOperationMode();', 'cpuUpdateOperationMode();\n\t' + hook)
    ee_text = ee_text[:start] + block + ee_text[end:]
    breakpoint_files[ee] = ee_text
    iop_source = source / 'pcsx2/R3000A.cpp'
    iop_text = replace_once(iop_source.read_text(encoding='utf-8'), '#include "R3000A.h"',
        '#include "R3000A.h"\n#include "DebugTools/DebugServer.h"', str(iop_source))
    iop_text = replace_once(iop_text, 'void psxReset()\n{',
        'void psxReset()\n{\n\tDebugServer::OnIOPReset();', str(iop_source))
    # v2.9 names these unchanged interrupt-controller registers explicitly.
    irq_registers = ('HW_ICTRL', 'HW_ISTAT', 'HW_IMASK') if 'psxHu32(HW_ICTRL)' in iop_text else ('0x1078', '0x1070', '0x1074')
    irq_pending = f'(psxHu32({irq_registers[0]}) != 0) && ((psxHu32({irq_registers[1]}) & psxHu32({irq_registers[2]})) != 0)'
    iop_text = replace_once(iop_text,
        '\tif (' + irq_pending + ')',
        '\t// Preserve the debugger stop; deliver pending hardware IRQs on resume.\n'
        '\tif (!DebugServer::DeferIOPInterruptDispatch() &&\n'
        '\t\t' + irq_pending + ')', str(iop_source))
    start = iop_text.index('void psxException(u32 code, u32 bd)')
    end = iop_text.index('\n}', start) + 2
    block = iop_text[start:end]
    block = replace_once(block, 'void psxException(u32 code, u32 bd)\n{',
        'void psxException(u32 code, u32 bd)\n{\n\tconst u32 mcpIOPExceptionPC = psxRegs.pc;\n\tconst u32 mcpIOPPreviousStatus = psxRegs.CP0.n.Status;', str(iop_source))
    hook = '\tDebugServer::OnIOPException(code, mcpIOPExceptionPC, bd != 0, mcpIOPPreviousStatus);'
    if hook not in block:
        block = block[:-2] + '\n' + hook + '\n}'
    iop_text = iop_text[:start] + block + iop_text[end:]
    breakpoint_files[iop_source] = iop_text
    iop_bios = source / 'pcsx2/IopBios.cpp'
    bios_text = replace_once(iop_bios.read_text(encoding='utf-8'), '#include "IopBios.h"',
        '#include "IopBios.h"\n#include "DebugTools/DebugServer.h"', str(iop_bios))
    bios_text = replace_once(bios_text,
        '\t\t\tCurrentBiosInformation.iopModListAddr = GetModList(a0);',
        '\t\t\tCurrentBiosInformation.iopModListAddr = GetModList(a0);\n'
        '\t\t\tDebugServer::OnIOPModuleListLocated(CurrentBiosInformation.iopModListAddr);', str(iop_bios))
    bios_text = replace_once(bios_text, '\t\t\t*file = new HostFile(hostfd);',
        '\t\t\t*file = new HostFile(hostfd);\n'
        '\t\t\tDebugServer::OnIOPHostFileOpened(hostfd, file_path, (flags & IOP_O_RDWR) == IOP_O_RDONLY);', str(iop_bios))
    bios_text = replace_once(bios_text, '\t\t\t::close(fd);\n\t\t\tdelete this;',
        '\t\t\tDebugServer::OnIOPHostFileClosed(fd);\n\t\t\t::close(fd);\n\t\t\tdelete this;', str(iop_bios))
    bios_text = replace_once(bios_text, '\t\t\treturn translate_error(static_cast<int>(::read(fd, buf, count)));',
        '\t\t\tconst s64 observed_offset = DebugServer::IsObservedIOPFile(fd) ? static_cast<s64>(::lseek(fd, 0, SEEK_CUR)) : -1;\n'
        '\t\t\tconst int result = translate_error(static_cast<int>(::read(fd, buf, count)));\n'
        '\t\t\tif (observed_offset >= 0 && result > 0) DebugServer::OnIOPHostFileRead(fd, observed_offset, buf, static_cast<u32>(result));\n'
        '\t\t\treturn result;', str(iop_bios))
    old_observers = ('\t\tint ObserveLoadObject_HLE() { DebugServer::OnIOPLoadObject(a0, a1); return 0; }\n'
        '\t\tint ObserveModuleRegister_HLE() { DebugServer::OnIOPModuleRegister(a0); return 0; }\n\n')
    observers = ('\t\tint ObserveLoadObject_HLE() { DebugServer::OnIOPLoadObject(a0, a1); return 0; }\n'
        '\t\tint ObserveModuleRelease_HLE() { DebugServer::OnIOPModuleRelease(a0); return 0; }\n'
        '\t\tint ObserveModuleRegister_HLE() { DebugServer::OnIOPModuleRegister(a0); return 0; }\n\n')
    if old_observers in bios_text:
        bios_text = replace_once(bios_text, old_observers, observers, str(iop_bios))
    bios_text = replace_once(bios_text, '\t\tint RegisterLibraryEntries_HLE()\n',
        observers + '\t\tint RegisterLibraryEntries_HLE()\n', str(iop_bios))
    old_exports = '\t\tMODULE(loadcore)\n\t\t\tEXPORT_H( 16, ObserveModuleRegister)\n\t\t\tEXPORT_H( 23, ObserveLoadObject)\n'
    exports = '\t\tMODULE(loadcore)\n\t\t\tEXPORT_H( 17, ObserveModuleRelease)\n\t\t\tEXPORT_H( 16, ObserveModuleRegister)\n\t\t\tEXPORT_H( 23, ObserveLoadObject)\n'
    if old_exports in bios_text:
        bios_text = replace_once(bios_text, old_exports, exports, str(iop_bios))
    bios_text = replace_once(bios_text, '\t\tMODULE(loadcore)\n\t\t\tEXPORT_H(  6, RegisterLibraryEntries)',
        exports + '\t\t\tEXPORT_H(  6, RegisterLibraryEntries)', str(iop_bios))
    vm_text = replace_once(vm_text, 'bool VMManager::DoLoadState(const char* filename, Error* error)\n{',
        'bool VMManager::DoLoadState(const char* filename, Error* error)\n{\n\tDebugServer::OnStateLoadAttempt();', str(vm))
    breakpoint_files[iop_bios] = bios_text
    # Public modload entry observations also catch loaders whose internal
    # loadcore calls do not pass through import stubs. Never replace guest calls.
    service_helpers = ''.join(f'\t\tint ObserveModload{n}_HLE() {{ DebugServer::OnIOPModuleService({n}); return 0; }}\n'
                              for n in (4, 5, 6, 7, 9, 10, 11, 19, 20, 21, 26, 27))
    bios_text = replace_once(bios_text, '\t\tint ObserveLoadObject_HLE()',
        service_helpers + '\t\tint ObserveLoadObject_HLE()', str(iop_bios))
    service_cases = ''.join(f'\t\t\tEXPORT_H({n:3}, ObserveModload{n})\n' for n in (4, 5, 6, 7, 9, 10, 11, 19, 20, 21, 26, 27))
    service_exports = '\t\tif (libname == "modload") { using namespace loadcore; switch (index) {\n' + service_cases + '\t\t} }\n'
    bios_text = replace_once(bios_text, '\t\tMODULE(sysmem)\n', service_exports + '\t\tMODULE(sysmem)\n', str(iop_bios))
    breakpoint_files[iop_bios] = bios_text
    sif1 = source / 'pcsx2/Sif1.cpp'
    sif1_text = replace_once(sif1.read_text(encoding='utf-8'), '#include "IopHw.h"',
        '#include "IopHw.h"\n#include "DebugTools/DebugServer.h"', str(sif1))
    sif1_text = replace_once(sif1_text, '\tsif1.fifo.read((u32*)iopPhysMem(hw_dma10.madr), readSize);',
        '\tsif1.fifo.read((u32*)iopPhysMem(hw_dma10.madr), readSize);\n'
        '\tDebugServer::OnSIF1Write(hw_dma10.madr, static_cast<u32>(readSize));', str(sif1))
    sif1_text = replace_once(sif1_text, '\tif (sif1tag.IRQ  || (sif1tag.ID & 4)) sif1.iop.end = true;',
        '\tDebugServer::OnSIF1Tag(hw_dma10.madr, static_cast<u32>(sif1.iop.counter), sif1tag.IRQ || (sif1tag.ID & 4));\n'
        '\tif (sif1tag.IRQ  || (sif1tag.ID & 4)) sif1.iop.end = true;', str(sif1))
    breakpoint_files[sif1] = sif1_text
    for filename, functions in {
        'pcsx2/Interpreter.cpp': [('void intBreakpoint(bool memcheck)', False, 'memcheck')],
        'pcsx2/R3000AInterpreter.cpp': [('void psxBreakpoint(bool memcheck)', True, 'memcheck')],
        'pcsx2/x86/iR3000A.cpp': [('bool psxDynarecCheckBreakpoint()', True, 'false'), ('bool psxDynarecMemcheck()', True, 'true')],
        'pcsx2/x86/ix86-32/iR5900.cpp': [('void dynarecCheckBreakpoint()', False, 'false'), ('void dynarecMemcheck()', False, 'true')],
    }.items():
        target = source / filename
        text = target.read_text(encoding='utf-8')
        text = replace_once(text, '#include "VMManager.h"',
            '#include "VMManager.h"\n#include "DebugTools/DebugServer.h"', filename)
        if filename == 'pcsx2/x86/ix86-32/iR5900.cpp':
            # recSYSCALL's constant FlushCache fast path stays ahead of this call.
            text = replace_once(text,
                '\trecCall(R5900::Interpreter::OpcodeImpl::SYSCALL);',
                '\tiFlushCall(FLUSH_INTERPRETER);\n'
                '\txFastCall((void*)DebugServer::ExecuteEESyscall, (g_recompilingDelaySlot ? pc | 1u : pc - 4),\n'
                '\t\tstatic_cast<u32>(cpuRegs.code));', filename)
            text = replace_once(text,
                '\trecCall(R5900::Interpreter::OpcodeImpl::BREAK);',
                '\t// Carry the JIT instruction address/BD separately; preserve upstream BREAK semantics.\n'
                '\tiFlushCall(FLUSH_INTERPRETER);\n'
                '\t// The emitter accepts two arguments; aligned PC bit 0 carries BD.\n'
                '\txFastCall((void*)DebugServer::ExecuteEEBreak, (g_recompilingDelaySlot ? pc | 1u : pc - 4),\n'
                '\t\tstatic_cast<u32>(cpuRegs.code));', filename)
            text = replace_once(text, '\t\tif(encodeBreakpoint() || encodeMemcheck())',
                '\t\t// Emit both checks: an execute breakpoint must not hide a watchpoint.\n'
                '\t\tconst bool executeCheck = encodeBreakpoint();\n'
                '\t\tconst bool memoryCheck = encodeMemcheck();\n'
                '\t\tif (executeCheck || memoryCheck)', filename)
        if filename == 'pcsx2/x86/iR3000A.cpp':
            for code in ('0x20', '0x24'):
                call = '\txFastCall((void*)psxException, ' + code + ', psxbranch == 1);'
                exit_hook = ('\n\t// A selected MCP exception stops before executing its IOP handler.\n'
                             '\txFastCall((void*)DebugServer::IOPExceptionCaptured);\n'
                             '\txTEST(al, al);\n\txJNZ(iopExitRecompiledCode);')
                # Upgrade the previous integration as well as a pristine checkout.
                text = text.replace(call + exit_hook, call)
                wrapper = '\txFastCall((void*)DebugServer::ExecuteIOPException,\n' \
                    '\t\t(psxpc - 4) | (s_recompilingDelaySlot ? 1u : 0u), psxbranch == 1);'
                # Both trap call sites share this wrapper; narrow by opcode block.
                signature = 'void rpsx' + ('SYSCALL' if code == '0x20' else 'BREAK') + '()'
                start = text.index(signature)
                end = text.index('\n}', start) + 2
                block = replace_once(text[start:end], call, wrapper + exit_hook, filename)
                text = text[:start] + block + text[end:]
        for signature, iop, watch in functions:
            # Accept extra arguments on the dynarec functions, while keeping the
            # replacement confined to the correct function body.
            prefix = signature.split('(')[0] + '('
            start = text.find(prefix)
            end = text.find('\n}', start) + 2
            if start < 0 or end < 2:
                raise SystemExit(f'{filename}: breakpoint handler not found: {signature}')
            block = text[start:end]
            if filename == 'pcsx2/Interpreter.cpp':
                block = replace_once(block,
                    'if (CBreakPoints::CheckSkipFirst(BREAKPOINT_EE, pc) != 0)',
                    'if ((!memcheck || !DebugServer::PreserveStepWatchpoints()) && CBreakPoints::CheckSkipFirst(BREAKPOINT_EE, pc) != 0)', filename)
            elif filename == 'pcsx2/x86/ix86-32/iR5900.cpp' and watch == 'true':
                block = replace_once(block,
                    'if (CBreakPoints::CheckSkipFirst(BREAKPOINT_EE, pc) != 0)',
                    'if (!DebugServer::PreserveStepWatchpoints() && CBreakPoints::CheckSkipFirst(BREAKPOINT_EE, pc) != 0)', filename)
            hook = '\tVMManager::SetPaused(true);\n\tDebugServer::OnBreakpointHit(' + ('true' if iop else 'false') + ', ' + watch + ');'
            block = replace_once(block, '\tVMManager::SetPaused(true);', hook, filename)
            text = text[:start] + block + text[end:]
        breakpoint_files[target] = text

    # Keep ownership inside GSRenderer; the TCP worker never inspects renderer
    # internals. A natural end and fclose success are reported separately from
    # merely seeing a file in the output directory.
    renderer_h = source / 'pcsx2/GS/Renderers/Common/GSRenderer.h'
    renderer = source / 'pcsx2/GS/Renderers/Common/GSRenderer.cpp'
    dump = source / 'pcsx2/GS/GSDump.cpp'
    renderer_h_text = renderer_h.read_text(encoding='utf-8')
    renderer_h_text = replace_once(renderer_h_text, '\tvoid StopGSDump();',
        '\tvoid StopGSDump();\n\tbool QueueMCPDump(const std::string& base, u32 frames);\n'
        '\tvoid CancelMCPDump(const std::string& base);', str(renderer_h))
    renderer_text = renderer.read_text(encoding='utf-8')
    renderer_text = replace_once(renderer_text, '#include "VMManager.h"',
        '#include "VMManager.h"\n#include "DebugTools/DebugServer.h"', str(renderer))
    renderer_text = replace_once(renderer_text, 'static std::deque<std::thread> s_screenshot_threads;',
        '// GS thread only; preserve GSRenderer and derived object layouts.\n'
        'static std::string s_mcp_dump_base;\n\nstatic std::deque<std::thread> s_screenshot_threads;', str(renderer))
    renderer_text = replace_once(renderer_text, '\ts_last_draw_rect = GSVector4::zero();',
        '\ts_mcp_dump_base.clear();\n\ts_last_draw_rect = GSVector4::zero();', str(renderer))
    renderer_text = replace_once(renderer_text, '\t\t\tif (GSConfig.GSDumpCompression == GSDumpCompressionMethod::Uncompressed)',
        '\t\t\tif (GSConfig.GSDumpCompression == GSDumpCompressionMethod::Uncompressed || m_snapshot == s_mcp_dump_base)', str(renderer))
    renderer_text = replace_once(renderer_text, '\t\tconst bool internal_resolution = (GSConfig.ScreenshotSize >= GSScreenshotSize::InternalResolution);',
        '\t\t// MCP embeds a bounded image in the GS stream; do not also create an unbounded companion image.\n'
        '\t\tif (m_snapshot != s_mcp_dump_base)\n\t\t{\n'
        '\t\tconst bool internal_resolution = (GSConfig.ScreenshotSize >= GSScreenshotSize::InternalResolution);', str(renderer))
    renderer_text = replace_once(renderer_text, '\n\t\tm_snapshot = {};\n\t}\n\telse if (m_dump)',
        '\n\t\t}\n\t\tm_snapshot = {};\n\t}\n\telse if (m_dump)', str(renderer))
    renderer_text = replace_once(renderer_text, 'void GSRenderer::StopGSDump()\n{',
        'bool GSRenderer::QueueMCPDump(const std::string& base, u32 frames)\n{\n'
        '\tif (!m_snapshot.empty() || m_dump) return false;\n'
        '\ts_mcp_dump_base = base;\n\tQueueSnapshot(base + ".png", frames);\n\treturn true;\n}\n\n'
        'void GSRenderer::CancelMCPDump(const std::string& base)\n{\n'
        '\tif (m_snapshot == base) { m_snapshot.clear(); m_dump_frames = 0; }\n'
        '\tif (m_dump && m_dump->GetPath() == base + ".gs") { m_dump.reset(); m_dump_frames = 0; }\n'
        '\tif (s_mcp_dump_base == base) s_mcp_dump_base.clear();\n}\n\n'
        'void GSRenderer::StopGSDump()\n{', str(renderer))
    dump_text = dump.read_text(encoding='utf-8')
    dump_text = replace_once(dump_text, '#include "GS/GSDump.h"',
        '#include "GS/GSDump.h"\n#include "DebugTools/DebugServer.h"', str(dump))
    dump_text = replace_once(dump_text, '\tm_gs = FileSystem::OpenCFile(m_filename.c_str(), "wb");',
        '\tm_gs = FileSystem::OpenCFile(m_filename.c_str(), "wb");\n'
        '\tDebugServer::OnGSDumpOpened(m_filename, m_gs != nullptr);', str(dump))
    dump_text = replace_once(dump_text, 'GSDumpBase::~GSDumpBase()\n{\n\tif (m_gs)\n\t\tstd::fclose(m_gs);\n}',
        'GSDumpBase::~GSDumpBase()\n{\n\tbool complete = m_gs && std::ferror(m_gs) == 0;\n'
        '\tif (m_gs && std::fclose(m_gs) != 0) complete = false;\n'
        '\tDebugServer::OnGSDumpClosed(m_filename, complete);\n}', str(dump))
    dump_text = replace_once(dump_text, '\treturn (++m_frames & 1) == 0 && last && (m_extra_frames < 0);',
        '\tconst bool complete = (++m_frames & 1) == 0 && last && (m_extra_frames < 0);\n'
        '\tif (complete) DebugServer::OnGSDumpFramesComplete(m_filename);\n\treturn complete;', str(dump))
    dump_text = replace_once(dump_text, '\tsize_t written = fwrite(data, 1, size, m_gs);',
        '\tif (!DebugServer::GSDumpWriteAllowed(m_filename, size)) return;\n'
        '\tsize_t written = fwrite(data, 1, size, m_gs);', str(dump))
    # Per-request capture mode/resolution without mutating persistent GS settings.
    capture_h = source / 'pcsx2/GS/GSCapture.h'
    capture = source / 'pcsx2/GS/GSCapture.cpp'
    capture_h_text = replace_once(capture_h.read_text(encoding='utf-8'), '\tvoid EndCapture();',
        '\tvoid EndCapture();\n\tbool BeginMCPCapture(float fps, GSVector2i resolution, float aspect, std::string filename, bool audio);\n'
        '\tbool EndMCPCapture(const std::string& filename);', str(capture_h))
    renderer_h_text = replace_once(renderer_h_text, '\tvoid EndCapture();',
        '\tvoid EndCapture();\n\tbool BeginMCPCapture(std::string filename, const GSVector2i& size, bool audio);', str(renderer_h))
    renderer_text = replace_once(renderer_text, 'bool GSRenderer::BeginCapture(std::string filename, const GSVector2i& size)\n{',
        'bool GSRenderer::BeginMCPCapture(std::string filename, const GSVector2i& size, bool audio)\n{\n'
        '\treturn GSCapture::BeginMCPCapture(GetTvRefreshRate(), size,\n'
        '\t\tGetCurrentAspectRatioFloat(GetVideoMode() == GSVideoMode::SDTV_480P), std::move(filename), audio);\n}\n\n'
        'bool GSRenderer::BeginCapture(std::string filename, const GSVector2i& size)\n{', str(renderer))
    capture_text = replace_once(capture.read_text(encoding='utf-8'), '#include "GS/GSCapture.h"',
        '#include "GS/GSCapture.h"\n#include "DebugTools/DebugServer.h"', str(capture))
    capture_text = replace_once(capture_text, '\tstatic void InternalEndCapture(std::unique_lock<std::mutex>& lock);',
        '\tstatic void InternalEndCapture(std::unique_lock<std::mutex>& lock);\n'
        '\tstatic bool BeginCaptureWithMode(float fps, GSVector2i resolution, float aspect, std::string filename, bool capture_video, bool capture_audio);', str(capture))
    capture_text = replace_once(capture_text,
        'bool GSCapture::BeginCapture(float fps, GSVector2i recommendedResolution, float aspect, std::string filename)\n{\n'
        '\tconst bool capture_video = GSConfig.EnableVideoCapture;\n\tconst bool capture_audio = GSConfig.EnableAudioCapture;',
        'bool GSCapture::BeginCapture(float fps, GSVector2i recommendedResolution, float aspect, std::string filename)\n{\n'
        '\treturn BeginCaptureWithMode(fps, recommendedResolution, aspect, std::move(filename), GSConfig.EnableVideoCapture, GSConfig.EnableAudioCapture);\n}\n\n'
        'bool GSCapture::BeginMCPCapture(float fps, GSVector2i resolution, float aspect, std::string filename, bool audio)\n{\n'
        '\treturn BeginCaptureWithMode(fps, resolution, aspect, std::move(filename), true, audio);\n}\n\n'
        'bool GSCapture::BeginCaptureWithMode(float fps, GSVector2i recommendedResolution, float aspect, std::string filename, bool capture_video, bool capture_audio)\n{', str(capture))
    capture_text = replace_once(capture_text, '\tpf.pts = s_next_video_pts++;',
        '\tif (!DebugServer::CaptureVideoFrameAllowed(s_filename)) return false;\n\tpf.pts = s_next_video_pts++;', str(capture))
    capture_text = replace_once(capture_text,
        '\t\twrap_av_packet_rescale_ts(packet, codec_context->time_base, stream->time_base);',
        '\t\t// Fixed-rate MCP video advances PTS by one codec time-base tick per frame.\n'
        '\t\t// Newer muxers need the final packet duration explicitly to retain that frame.\n'
        '\t\tif (packet->duration <= 0 && codec_context->codec_type == AVMEDIA_TYPE_VIDEO &&\n'
        '\t\t\tDebugServer::OwnsMediaCapture(s_filename)) packet->duration = 1;\n'
        '\t\twrap_av_packet_rescale_ts(packet, codec_context->time_base, stream->time_base);', str(capture))
    capture_text = replace_once(capture_text, '\t\tres = wrap_av_interleaved_write_frame(s_format_context, packet);',
        '\t\tif (!DebugServer::CapturePacketAllowed(s_filename, static_cast<uint64_t>(packet->size)))\n'
        '\t\t{ wrap_av_packet_unref(packet); return false; }\n'
        '\t\tres = wrap_av_interleaved_write_frame(s_format_context, packet);', str(capture))
    capture_text = replace_once(capture_text, 'void GSCapture::LogAVError(int errnum, const char* format, ...)\n{',
        'void GSCapture::LogAVError(int errnum, const char* format, ...)\n{\n\tDebugServer::OnCaptureError(s_filename);', str(capture))
    capture_text = replace_once(capture_text, 'void GSCapture::InternalEndCapture(std::unique_lock<std::mutex>& lock)\n{\n\tint res;',
        'void GSCapture::InternalEndCapture(std::unique_lock<std::mutex>& lock)\n{\n'
        '\tconst std::string mcp_path = s_filename;\n\tbool mcp_complete = !s_encoding_error.load();\n\tint res;', str(capture))
    # Keep the filename until EOF packets have passed the ownership/payload gate.
    capture_text = replace_once(capture_text, '\t\ts_filename = {};\n\t\ts_encoding_error = false;',
        '\t\t// Filename retained until the muxer closes, including EOF packets.\n\t\ts_encoding_error = false;', str(capture))
    capture_text = replace_once(capture_text, '\t\tres = wrap_avio_closep(&s_format_context->pb);',
        '\t\tres = wrap_avio_closep(&s_format_context->pb);\n\t\tif (res < 0) mcp_complete = false;', str(capture))
    capture_text = replace_once(capture_text, '\tif (was_capturing)\n\t\tUnloadFFmpeg();\n}',
        '\ts_filename = {};\n\tif (was_capturing)\n\t{\n\t\tUnloadFFmpeg();\n'
        '\t\tDebugServer::OnCaptureClosed(mcp_path, mcp_complete);\n\t}\n}', str(capture))
    capture_text = replace_once(capture_text, 'void GSCapture::EndCapture()\n{',
        'bool GSCapture::EndMCPCapture(const std::string& filename)\n{\n'
        '\t{\n\t\tstd::unique_lock<std::mutex> lock(s_lock);\n'
        '\t\tif (!s_capturing.load(std::memory_order_acquire) || s_filename != filename) return false;\n'
        '\t\tInternalEndCapture(lock);\n\t}\n\tHost::OnCaptureStopped();\n\treturn true;\n}\n\n'
        'void GSCapture::EndCapture()\n{', str(capture))
    breakpoint_files.update({renderer_h: renderer_h_text, renderer: renderer_text, dump: dump_text,
                            capture_h: capture_h_text, capture: capture_text})

    # F5: keep the native format and GUI behavior, but reject partial pad reads.
    recording = source / 'pcsx2/Recording/InputRecording.cpp'
    recording_text = replace_once(recording.read_text(encoding='utf-8'), '#include "InputRecording.h"',
        '#include "InputRecording.h"\n#include "DebugTools/DebugServer.h"', str(recording))
    play_signature = 'bool InputRecording::play(const std::string& filename' + (', bool readOnly)' if 'bool readOnly)' in recording_text else ')')
    for signature in ('bool InputRecording::create(const std::string& fileName, const bool fromSaveState, const std::string& authorName)',
                      play_signature):
        recording_text = replace_once(recording_text, signature + '\n{',
            signature + '\n{\n\tif (!DebugServer::AllowInputRecordingStart()) return false;', str(recording))
    recording_text = replace_once(recording_text,
        '\t\tInputRec::consoleLog(fmt::format("Failed to write input data at [{}:{}:{}]", m_frame_counter, port, slot));',
        '\t\tDebugServer::OnInputRecordingIOError();\n\t\tInputRec::consoleLog(fmt::format("Failed to write input data at [{}:{}:{}]", m_frame_counter, port, slot));', str(recording))
    recording_text = replace_once(recording_text,
        '\t\tInputRec::consoleLog(fmt::format("Failed to read input data at [{}:{}:{}]", m_frame_counter, port, slot));',
        '\t\tDebugServer::OnInputRecordingIOError();\n\t\tInputRec::consoleLog(fmt::format("Failed to read input data at [{}:{}:{}]", m_frame_counter, port, slot));', str(recording))
    recording_text = replace_once(recording_text, 'bool InputRecording::play(const std::string& filename)',
        'bool InputRecording::play(const std::string& filename, bool readOnly)', str(recording))
    recording_text = replace_once(recording_text, 'm_file.openExisting(filename)', 'm_file.openExisting(filename, readOnly)', str(recording))
    recording_h = source / 'pcsx2/Recording/InputRecording.h'
    recording_h_text = replace_once(recording_h.read_text(encoding='utf-8'), 'bool play(const std::string& path);',
        'bool play(const std::string& path);\n\tbool play(const std::string& path, bool readOnly);', str(recording_h))
    recording_h_text = replace_once(recording_h_text, '\tvoid stop();',
        '\tvoid stop();\n\t// CPU thread only: close this exact movie without changing VM state or queuing a stop.\n\tbool stopOwnedMovie(const std::string& path);', str(recording_h))
    recording_text = replace_once(recording_text, 'void InputRecording::stop()\n{',
        'bool InputRecording::stopOwnedMovie(const std::string& path)\n{\n'
        '\tif (!m_is_active || m_file.getFilename() != path) return false;\n'
        '\tcloseActiveFile();\n\treturn !m_is_active;\n}\n\nvoid InputRecording::stop()\n{', str(recording))
    recording_text = replace_once(recording_text, 'bool InputRecording::play(const std::string& filename, bool readOnly)\n{',
        'bool InputRecording::play(const std::string& filename)\n{\n\treturn play(filename, false);\n}\n\n'
        'bool InputRecording::play(const std::string& filename, bool readOnly)\n{', str(recording))
    movie_file = source / 'pcsx2/Recording/InputRecordingFile.cpp'
    movie_file_text = replace_once(movie_file.read_text(encoding='utf-8'),
        'if (fseek(m_recordingFile, seek, SEEK_SET) != 0 || fread(&data, 1, 18, m_recordingFile) != 1)',
        'if (port < 2 && slot == 0 && fseek(m_recordingFile, seek, SEEK_SET) == 0 &&\n\t\tfread(data.data(), 1, data.size(), m_recordingFile) == data.size())', str(movie_file))
    movie_file_text = replace_once(movie_file_text, 'bool InputRecordingFile::openExisting(const std::string& path)',
        'bool InputRecordingFile::openExisting(const std::string& path, bool readOnly)', str(movie_file))
    movie_file_text = replace_once(movie_file_text, 'FileSystem::OpenCFile(path.data(), "rb+")',
        '(readOnly ? FileSystem::OpenSharedCFile(path.data(), "rb", FileSystem::FileShareMode::DenyWrite) : FileSystem::OpenCFile(path.data(), "rb+"))', str(movie_file))
    movie_file_h = source / 'pcsx2/Recording/InputRecordingFile.h'
    movie_file_h_text = replace_once(movie_file_h.read_text(encoding='utf-8'), 'bool openExisting(const std::string& path);',
        'bool openExisting(const std::string& path);\n\tbool openExisting(const std::string& path, bool readOnly);', str(movie_file_h))
    movie_file_text = replace_once(movie_file_text, 'bool InputRecordingFile::openExisting(const std::string& path, bool readOnly)\n{',
        'bool InputRecordingFile::openExisting(const std::string& path)\n{\n\treturn openExisting(path, false);\n}\n\n'
        'bool InputRecordingFile::openExisting(const std::string& path, bool readOnly)\n{', str(movie_file))
    breakpoint_files.update({recording: recording_text, recording_h: recording_h_text,
                            movie_file: movie_file_text, movie_file_h: movie_file_h_text})

    iop_hw_write = source / 'pcsx2/ps2/Iop/IopHwWrite.cpp'
    iop_hw_text = replace_once(iop_hw_write.read_text(encoding='utf-8'), '#include "IopHw_Internal.h"',
        '#include "IopHw_Internal.h"\n#include "DebugTools/DebugServer.h"', str(iop_hw_write))
    iop_hw_text = replace_once(iop_hw_text, '\t\tpsxDma2GpuW(addr, val);',
        '\t\t// Read backing storage only; the original MMIO handler still runs exactly once.\n'
        '\t\tconst u32 before = psxHu32(addr & ~3u);\n'
        '\t\tpsxDma2GpuW(addr, val);\n'
        '\t\tDebugServer::OnPgifDmaWrite(addr, val, sizeof(T) * 8, before, psxHu32(addr & ~3u));', str(iop_hw_write))
    breakpoint_files[iop_hw_write] = iop_hw_text

    qt_host = source / 'pcsx2-qt/QtHost.cpp'
    qt_text = replace_once(qt_host.read_text(encoding='utf-8'), '#include "QtHost.h"',
        '#include "QtHost.h"\n#include "MCPApplicationCapture.h"', str(qt_host))
    qt_text = replace_once(qt_text, 'void EmuThread::run()\n{',
        'void EmuThread::run()\n{\n\tMCPApplicationCapture::Register();', str(qt_host))
    breakpoint_files[qt_host] = qt_text

    qt_header = source / 'pcsx2-qt/MCPApplicationCapture.h'
    original = repo / 'pcsx2-plugin/QtApplicationCapture.h'
    if not qt_header.exists() or qt_header.read_bytes() != original.read_bytes():
        shutil.copy2(original, qt_header)
    for name in ('DebugServer.cpp', 'DebugServer.h', 'DebugServerCompat.h'):
        original = repo / 'pcsx2-plugin' / name
        target = source / 'pcsx2/DebugTools' / name
        if not target.exists() or target.read_bytes() != original.read_bytes():
            shutil.copy2(original, target)
    write_if_changed(cmake, cmake_text)
    write_if_changed(vm, vm_text)
    write_if_changed(vm_h, vm_h_text)
    write_if_changed(config, config_text)
    write_if_changed(console_h, console_h_text)
    write_if_changed(console_cpp, console_text)
    for target, text in breakpoint_files.items():
        write_if_changed(target, text)
    print(f'Integrated DebugServer sources, CMake target and VM lifecycle into {source}')


if __name__ == '__main__':
    main()
