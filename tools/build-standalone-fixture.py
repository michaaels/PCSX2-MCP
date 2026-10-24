#!/usr/bin/env python3
"""Build the standalone rendered MCP homebrew with the pinned PS2SDK image."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path,help='New output directory')
    args=parser.parse_args()
    repo=Path(__file__).resolve().parent.parent
    spec=importlib.util.spec_from_file_location('fixture_sdk',repo/'tools/build-iop-exception-fixture.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    output=args.output.resolve()
    if output.exists():parser.error('Output already exists; choose a new directory')
    shutil.copytree(repo/'pcsx2-mcp-server/test/fixtures/standalone',output)
    subprocess.run(['docker','run','--rm','--mount',f'type=bind,source={output},target=/fixture',
                    '-w','/fixture',helper.IMAGE,'sh','-c',
                    'if ! command -v make >/dev/null; then apk add --no-cache make; fi; make && ee-gcc --version > toolchain.txt && cat "$PS2SDK/ID" >> toolchain.txt'],check=True)
    names=['standalone.c','Makefile','standalone.elf','toolchain.txt']
    manifest={'kind':'standalone_mcp_render_fixture','image':helper.IMAGE,
              'sha256':{n:hashlib.sha256((output/n).read_bytes()).hexdigest() for n in names}}
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(output/'manifest.json')

if __name__=='__main__':main()
