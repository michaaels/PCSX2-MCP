#!/usr/bin/env python3
"""Integrate this DebugServer into upstream PCSX2 (tested on v2.6.3)."""
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
    vm_text = replace_once(vm_text, 'void VMManager::FrameAdvance(u32 num_frames /*= 1*/)\n{',
        'void VMManager::CancelFrameAdvance()\n{\n\ts_frame_advance_count = 0;\n}\n\n'
        'void VMManager::FrameAdvance(u32 num_frames /*= 1*/)\n{', str(vm))
    vm_h = source / 'pcsx2/VMManager.h'
    vm_h_text = replace_once(vm_h.read_text(encoding='utf-8'), '\tvoid FrameAdvance(u32 num_frames = 1);',
        '\tvoid FrameAdvance(u32 num_frames = 1);\n\n\t// CPU thread only: cancel remaining automated video frames.\n\tvoid CancelFrameAdvance();', str(vm_h))

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
    breakpoint_files[iop_bios] = bios_text
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

    for name in ('DebugServer.cpp', 'DebugServer.h'):
        original = repo / 'pcsx2-plugin' / name
        target = source / 'pcsx2/DebugTools' / name
        if not target.exists() or target.read_bytes() != original.read_bytes():
            shutil.copy2(original, target)
    write_if_changed(cmake, cmake_text)
    write_if_changed(vm, vm_text)
    write_if_changed(vm_h, vm_h_text)
    write_if_changed(console_h, console_h_text)
    write_if_changed(console_cpp, console_text)
    for target, text in breakpoint_files.items():
        write_if_changed(target, text)
    print(f'Integrated DebugServer sources, CMake target and VM lifecycle into {source}')


if __name__ == '__main__':
    main()
