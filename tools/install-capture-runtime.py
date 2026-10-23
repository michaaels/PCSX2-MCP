#!/usr/bin/env python3
"""Install the pinned official FFmpeg 8 DLLs beside a local Windows PCSX2 build.

Downloads into an ignored cache, verifies SHA256 before extraction, refuses to
replace different DLLs, and checks their exported ABI versions before success.
Does not install ffprobe or modify the system PATH.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request

URL = 'https://github.com/PCSX2/pcsx2-windows-dependencies/releases/download/FFMPEG/ffmpeglibs-8.0.7z'
SHA256 = 'c4f8a5093997445fbb08c694be289b36eed660e46e02078d9371a2481453ae5a'
LIBRARIES = {'avutil': 60, 'swresample': 6, 'avcodec': 62, 'avformat': 62, 'swscale': 9}


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='Directory containing the patched pcsx2-qt.exe')
    parser.add_argument('--cache', type=Path, default=Path(__file__).resolve().parent.parent / 'release/capture-runtime-8.0')
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('This installer is for Windows native PCSX2 only')
    target = args.directory.resolve(strict=True)
    if not (target / 'pcsx2-qt.exe').is_file():
        parser.error('Expected an existing pcsx2-qt.exe in the target directory')
    tar = shutil.which('tar')
    if not tar:
        parser.error('Windows tar with 7z support is required for extraction')
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / 'ffmpeglibs-8.0.7z'
    if not archive.exists():
        urllib.request.urlretrieve(URL, archive)
    if digest(archive) != SHA256:
        raise SystemExit(f'Archive SHA256 mismatch; refusing extraction: {archive}')
    extracted = cache / 'extracted'
    extracted.mkdir(exist_ok=True)
    names = [f'{name}-{major}.dll' for name, major in LIBRARIES.items()]
    subprocess.run([tar, '-xf', str(archive), '-C', str(extracted), *names], check=True)
    for name in names:
        if not (extracted / name).is_file():
            raise SystemExit(f'Missing required archive member: {name}')
        if (target / name).exists() and digest(target / name) != digest(extracted / name):
            raise SystemExit(f'Refusing to overwrite a different existing DLL: {target / name}')
    for name in names:
        if not (target / name).exists():
            shutil.copy2(extracted / name, target / name)
    versions = {}
    with os.add_dll_directory(str(target)):
        for name, major in LIBRARIES.items():
            library = ctypes.CDLL(str(target / f'{name}-{major}.dll'))
            function = getattr(library, f'{name}_version')
            function.restype = ctypes.c_uint
            version = function()
            if version >> 16 != major:
                raise SystemExit(f'Unexpected {name} ABI: {version >> 16}, expected {major}')
            versions[name] = version
    receipt = {'source': URL, 'archive_sha256': SHA256, 'library_versions': versions,
               'dll_sha256': {name: digest(target / name) for name in names}}
    (cache / 'installation.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print('Verified and installed official FFmpeg 8 capture runtime:', target)


if __name__ == '__main__':
    main()
