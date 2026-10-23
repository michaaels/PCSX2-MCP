#!/usr/bin/env python3
"""Compare pristine, previous and reapplied native integrations without building.

Requires the pinned upstream git checkout. Writes only to a new output directory.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--previous', default='26b5d06', help='MCP commit whose integration must upgrade cleanly')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    upstream = args.upstream.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    pinned = 'bc8151d2a46d4aba039ea5580afbfc7bfcf6d730'
    files = ['pcsx2/CMakeLists.txt', 'pcsx2/VMManager.cpp', 'pcsx2/VMManager.h',
             'pcsx2/Pcsx2Config.cpp', 'common/Console.h', 'common/Console.cpp',
             'pcsx2/R5900.cpp', 'pcsx2/R3000A.cpp', 'pcsx2/IopBios.cpp',
             'pcsx2/Interpreter.cpp', 'pcsx2/R3000AInterpreter.cpp',
             'pcsx2/x86/iR3000A.cpp', 'pcsx2/x86/ix86-32/iR5900.cpp',
             'pcsx2/GS/Renderers/Common/GSRenderer.cpp', 'pcsx2/GS/Renderers/Common/GSRenderer.h',
             'pcsx2/GS/GSDump.cpp', 'pcsx2/GS/GSCapture.h', 'pcsx2/GS/GSCapture.cpp', 'pcsx2/Sif1.cpp']
    generated = ['pcsx2/DebugTools/DebugServer.cpp', 'pcsx2/DebugTools/DebugServer.h']

    def git(root, revision, filename):
        return subprocess.check_output(['git', '-C', str(root), 'show', f'{revision}:{filename}'])

    def prepare(name):
        tree = output / name
        for filename in files:
            target = tree / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(upstream, pinned, filename))
        (tree / 'pcsx2/DebugTools').mkdir(parents=True)
        return tree

    def apply(script, tree):
        subprocess.run([sys.executable, str(script), str(tree)], check=True)

    def hashes(tree):
        return {name: hashlib.sha256((tree / name).read_bytes()).hexdigest() for name in files + generated}

    clean = prepare('pristine')
    script = repo / 'tools/apply-debug-server.py'
    apply(script, clean)
    expected = hashes(clean)
    apply(script, clean)
    assert hashes(clean) == expected, 'Reapplication changed integrated files'
    old_repo = output / 'previous-mcp'
    for name in ['tools/apply-debug-server.py', 'pcsx2-plugin/DebugServer.cpp', 'pcsx2-plugin/DebugServer.h']:
        target = old_repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git(repo, args.previous, name))
    upgraded = prepare('upgraded')
    apply(old_repo / 'tools/apply-debug-server.py', upgraded)
    apply(script, upgraded)
    assert hashes(upgraded) == expected, 'Upgrading the previous integration differs from pristine'
    actual = hashes(upstream)
    assert actual == expected, 'Build checkout differs from the checked integration'
    receipt = dict(upstream=pinned, previous=args.previous, idempotent=True,
                   pristine_and_previous_integration_match=True, build_checkout_matches=True, sha256=expected)
    (output / 'integration.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(f'PASS: pristine, upgrade, reapply and build checkout agree for {len(expected)} native files')


if __name__ == '__main__':
    main()
