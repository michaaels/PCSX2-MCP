#!/usr/bin/env python3
"""Build a tiny MIPS ELF with genuine Clang DWARF, without modifying a user project."""
import argparse
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path)
parser.add_argument('--wsl', action='store_true', help='Use Clang/LLD in the default WSL distribution')
parser.add_argument('--dwarf-version', type=int, choices=(4, 5), default=4)
parser.add_argument('--clang', default='clang-18')
parser.add_argument('--linker', default='ld.lld-18')
args = parser.parse_args()
output = args.output.resolve()
if output.exists():
    parser.error('Output directory already exists; use a new directory')
output.mkdir(parents=True)
source = Path(__file__).resolve().parent.parent / 'pcsx2-mcp-server/test/fixtures'
for name in ('source-debug.c', 'source-debug.ld'):
    shutil.copyfile(source / name, output / name)


def tool_path(filename):
    if args.wsl:
        return subprocess.check_output(['wsl.exe', '--exec', 'wslpath', '-a', '-u', str(filename)], text=True).strip()
    return str(filename)


prefix = ['wsl.exe', '--exec'] if args.wsl else []
subprocess.run(prefix + [args.clang, '--target=mipsel-none-elf', '-march=mips3', '-mabi=32',
                        '-mno-abicalls', '-fno-pic', '-G0', '-g', f'-gdwarf-{args.dwarf_version}',
                        '-O0', '-ffreestanding', '-c', tool_path(output / 'source-debug.c'),
                        '-o', tool_path(output / 'source-debug.o')], check=True)
subprocess.run(prefix + [args.linker, '-m', 'elf32ltsmip', '-T', tool_path(output / 'source-debug.ld'),
                        tool_path(output / 'source-debug.o'), '-o', tool_path(output / 'source-debug.elf')], check=True)
print(output / 'source-debug.elf')
