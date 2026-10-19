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

    for name in ('DebugServer.cpp', 'DebugServer.h'):
        shutil.copy2(repo / 'pcsx2-plugin' / name, source / 'pcsx2/DebugTools' / name)
    cmake.write_text(cmake_text, encoding='utf-8')
    vm.write_text(vm_text, encoding='utf-8')
    print(f'Integrated DebugServer sources, CMake target and VM lifecycle into {source}')


if __name__ == '__main__':
    main()
