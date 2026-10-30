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
    repo = Path(__file__).resolve().parent.parent
    pin = json.loads((repo / 'tools/upstream.json').read_text(encoding='utf-8'))
    parser.add_argument('upstream', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--previous', default='26b5d06', help='MCP commit whose integration must upgrade cleanly')
    parser.add_argument('--upstream-ref', default=pin['revision'], help='Pinned upstream revision for pristine/build checks')
    parser.add_argument('--previous-upstream-ref', default=pin['previous_revision'], help='Upstream revision used by the previous MCP commit')
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    def revision(ref):
        return subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', ref + '^{commit}'], text=True).strip()
    pinned = revision(args.upstream_ref)
    previous_upstream = revision(args.previous_upstream_ref)
    assert revision('HEAD') == pinned, 'Build checkout HEAD does not match requested upstream revision'
    files = ['pcsx2/CMakeLists.txt', 'pcsx2/VMManager.cpp', 'pcsx2/VMManager.h',
             'pcsx2/Pcsx2Config.cpp', 'common/Console.h', 'common/Console.cpp',
             'pcsx2/R5900.cpp', 'pcsx2/R3000A.cpp', 'pcsx2/IopBios.cpp',
             'pcsx2/Interpreter.cpp', 'pcsx2/R3000AInterpreter.cpp',
             'pcsx2/x86/iR3000A.cpp', 'pcsx2/x86/ix86-32/iR5900.cpp',
             'pcsx2/GS/Renderers/Common/GSRenderer.cpp', 'pcsx2/GS/Renderers/Common/GSRenderer.h',
             'pcsx2/GS/GSDump.cpp', 'pcsx2/GS/GSCapture.h', 'pcsx2/GS/GSCapture.cpp', 'pcsx2/Sif1.cpp',
             'pcsx2/Recording/InputRecording.cpp', 'pcsx2/Recording/InputRecordingFile.cpp',
             'pcsx2/Recording/InputRecording.h', 'pcsx2/Recording/InputRecordingFile.h',
             'pcsx2/ps2/Iop/IopHwWrite.cpp', 'pcsx2-qt/QtHost.cpp']
    generated = ['pcsx2/DebugTools/DebugServer.cpp', 'pcsx2/DebugTools/DebugServer.h', 'pcsx2/DebugTools/DebugServerCompat.h',
                 'pcsx2-qt/MCPApplicationCapture.h']

    def git(root, revision, filename):
        return subprocess.check_output(['git', '-C', str(root), 'show', f'{revision}:{filename}'])

    def prepare(name, ref=pinned):
        tree = output / name
        for filename in files:
            target = tree / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(upstream, ref, filename))
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
    previous_plugin_files = subprocess.check_output(
        ['git', '-C', str(repo), 'ls-tree', '-r', '--name-only', args.previous, 'pcsx2-plugin'], text=True).splitlines()
    for name in ['tools/apply-debug-server.py'] + previous_plugin_files:
        target = old_repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(git(repo, args.previous, name))
    upgraded = prepare('upgraded', previous_upstream)
    apply(old_repo / 'tools/apply-debug-server.py', upgraded)
    apply(script, upgraded)
    upgrade_expected = expected
    if previous_upstream != pinned:
        previous_clean = prepare('previous-upstream-pristine', previous_upstream)
        apply(script, previous_clean)
        upgrade_expected = hashes(previous_clean)
        apply(script, previous_clean)
        assert hashes(previous_clean) == upgrade_expected, 'Previous upstream reapplication changed files'
    assert hashes(upgraded) == upgrade_expected, 'Upgrading previous integration differs from its upstream pristine result'
    actual = hashes(upstream)
    assert actual == expected, 'Build checkout differs from the checked integration'
    receipt = dict(upstream=pinned, previous=args.previous, previous_upstream=previous_upstream, idempotent=True,
                   previous_integration_upgrade_matches_its_pristine=True, build_checkout_matches=True,
                   sha256=expected, previous_upstream_sha256=upgrade_expected)
    (output / 'integration.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(f'PASS: {len(expected)} target upstream files match pristine/reapply/build; previous integration upgrade matches its own upstream pristine')


if __name__ == '__main__':
    main()
