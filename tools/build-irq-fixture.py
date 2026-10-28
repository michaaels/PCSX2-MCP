#!/usr/bin/env python3
"""Build an independent IOP thread and Vblank interrupt callback fixture."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='New directory')
    args = parser.parse_args(); output = args.output.resolve()
    if output.exists(): parser.error('Output exists; choose a new directory')
    repo = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location('sdk', repo/'tools/build-iop-exception-fixture.py')
    sdk = importlib.util.module_from_spec(spec); spec.loader.exec_module(sdk)
    source = repo/'pcsx2-mcp-server/test/fixtures/irq-control'
    shutil.copytree(source, output)
    subprocess.run(['docker','run','--rm','--mount',f'type=bind,source={output},target=/fixture',
                    '-w','/fixture',sdk.IMAGE,'sh','/fixture/build.sh'], check=True)
    sdk.restore_iop_program_headers(output, 'irq-control')
    names = sorted(p.name for p in source.iterdir() if p.is_file()) + [
        'irq-control.elf','irq-control.irx','irq-control.debug.irx','toolchain.txt']
    manifest = {'kind':'standalone_irq_fixture','image':sdk.IMAGE,
        'sha256':{n:hashlib.sha256((output/n).read_bytes()).hexdigest() for n in names}}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(output/'manifest.json')

if __name__ == '__main__': main()
