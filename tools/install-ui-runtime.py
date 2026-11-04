#!/usr/bin/env python3
"""Install the UI service's matching Qt Network DLL into a Windows runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('runtime', type=Path)
    parser.add_argument('qt_bin', type=Path, help='bin of the exact Qt SDK used for this runtime')
    args = parser.parse_args()
    runtime, qt_bin = args.runtime.resolve(strict=True), args.qt_bin.resolve(strict=True)
    if digest(runtime / 'Qt6Core.dll') != digest(qt_bin / 'Qt6Core.dll'):
        parser.error('Runtime Qt6Core.dll differs from the provided SDK; refusing to mix Qt builds')
    source, target = qt_bin / 'Qt6Network.dll', runtime / 'Qt6Network.dll'
    expected = digest(source)
    if target.exists() and digest(target) != expected:
        parser.error('Existing Qt6Network.dll differs; preserve/review it before replacement')
    if not target.exists():
        shutil.copy2(source, target)
    assert digest(target) == expected
    print(json.dumps({'path': str(target), 'sha256': expected, 'matching_qt_core_verified': True}))


if __name__ == '__main__':
    main()
