#!/usr/bin/env python3
"""Build an isolated four-case EE/IOP SIF2 transfer probe with the pinned SDK."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='New directory, never an existing build')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    helper_path = repo / 'tools/build-iop-exception-fixture.py'
    spec = importlib.util.spec_from_file_location('irx_build', helper_path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    output = args.output.resolve()
    if output.exists():
        parser.error('Output already exists; use a new directory')
    shutil.copytree(repo / 'pcsx2-mcp-server/test/fixtures/sif-transfer', output)
    subprocess.run(['docker', 'run', '--rm', '--mount', f'type=bind,source={output},target=/fixture',
                    '-w', '/fixture', helper.IMAGE, 'sh', '/fixture/build.sh'], check=True)
    helper.restore_iop_program_headers(output, 'sif-transfer')
    names = ['half-dma.elf', 'full-dma.elf', 'full-pio.elf', 'half-pio.elf',
             'sif-transfer.irx', 'sif-transfer.debug.irx', 'toolchain.txt',
             'ee-sif-transfer.c', 'iop-sif-transfer.c', 'Makefile.ee', 'Makefile.iop', 'build.sh']
    hashes = {n: hashlib.sha256((output/n).read_bytes()).hexdigest() for n in names}
    manifest = {'kind': 'isolated_sif2_transfer_fixture', 'image': helper.IMAGE, 'sha256': hashes,
                'scope': 'emulator_probe_not_SMS_audio_or_physical_acceptance'}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(output/'manifest.json')

if __name__ == '__main__':
    main()
