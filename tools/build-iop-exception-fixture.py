#!/usr/bin/env python3
"""Build isolated EE + resident IOP exception fixtures with the pinned SDK image."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import struct

IMAGE = 'ps2dev/ps2dev@sha256:da02eb0870afcfdb7198195de40d04cd121bd893668c7342fb84b3c4d273e9d1'


def restore_iop_program_headers(output, stem='iop-exceptions'):
    """Legacy iop-strip drops PHT for 0xff80; preserve the original load contract."""
    debug = (output / (stem + '.debug.irx')).read_bytes()
    filename = output / (stem + '.irx')
    stripped = filename.read_bytes()
    if struct.unpack_from('<HH', stripped, 42) != (0, 0):
        raise ValueError('Unexpected iop-strip program table; review pinned toolchain')
    shoff = struct.unpack_from('<I', stripped, 32)[0]
    shnum, names_index = struct.unpack_from('<HH', stripped, 48)
    names_offset, names_size = struct.unpack_from('<II', stripped, shoff + names_index * 40 + 16)
    names = stripped[names_offset:names_offset + names_size]
    sections = {}
    result = bytearray(stripped[:52] + bytes(64) + stripped[52:])
    for i in range(shnum):
        header = shoff + i * 40
        name = names[struct.unpack_from('<I', stripped, header)[0]:].split(b'\0')[0].decode('ascii')
        offset, size = struct.unpack_from('<II', stripped, header + 16)
        sections[name] = (offset, size)
        if i:
            struct.pack_into('<I', result, header + 64 + 16, offset + 64)
    phoff = struct.unpack_from('<I', debug, 28)[0]
    programs = bytearray(debug[phoff:phoff + 64])
    load_offset, load_size = struct.unpack_from('<I', programs, 36)[0], struct.unpack_from('<I', programs, 48)[0]
    text_offset = sections['.text'][0]
    mod_offset, mod_size = sections['.iopmod']
    original_mod = struct.unpack_from('<I', programs, 4)[0]
    if (stripped[text_offset:text_offset + load_size] != debug[load_offset:load_offset + load_size] or
            stripped[mod_offset:mod_offset + mod_size] != debug[original_mod:original_mod + mod_size]):
        raise ValueError('Stripping changed the allocated IRX image or module metadata')
    struct.pack_into('<I', programs, 4, mod_offset + 64)
    struct.pack_into('<I', programs, 36, text_offset + 64)
    result[52:116] = programs
    struct.pack_into('<I', result, 28, 52)
    struct.pack_into('<I', result, 32, shoff + 64)
    struct.pack_into('<HH', result, 42, 32, 2)
    filename.write_bytes(result)


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
    restore_iop_program_headers(output)
    names = ['normal.elf', 'delay.elf', 'syscall.elf', 'reset.elf', 'hardreset.elf', 'watch.elf', 'lifetime.elf', 'service.elf', 'iop-exceptions.irx', 'iop-exceptions.debug.irx',
             'iop-exceptions.c', 'ee-iop-exceptions.c', 'toolchain.txt']
    hashes = {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in names}
    (output / 'manifest.json').write_text(json.dumps({'image': IMAGE, 'sha256': hashes}, indent=2) + '\n', encoding='utf-8')
    print(output / 'manifest.json')

if __name__ == '__main__':
    main()
