#!/usr/bin/env python3
"""Build isolated EE + resident IOP exception fixtures with the pinned SDK image."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

IMAGE = 'ps2dev/ps2dev@sha256:da02eb0870afcfdb7198195de40d04cd121bd893668c7342fb84b3c4d273e9d1'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='New directory; existing artifacts are never overwritten')
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        parser.error('Output directory already exists; choose a new directory')
    source = Path(__file__).resolve().parent.parent / 'pcsx2-mcp-server/test/fixtures/iop-exceptions'
    shutil.copytree(source, output)
    subprocess.run(['docker', 'run', '--rm', '--mount', f'type=bind,source={output},target=/fixture',
                    '-w', '/fixture', IMAGE, 'sh', '/fixture/build.sh'], check=True)
    names = ['normal.elf', 'delay.elf', 'syscall.elf', 'reset.elf', 'hardreset.elf', 'watch.elf', 'iop-exceptions.irx',
             'iop-exceptions.c', 'ee-iop-exceptions.c', 'toolchain.txt']
    hashes = {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in names}
    (output / 'manifest.json').write_text(json.dumps({'image': IMAGE, 'sha256': hashes}, indent=2) + '\n', encoding='utf-8')
    print(output / 'manifest.json')

if __name__ == '__main__':
    main()
