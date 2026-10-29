#!/usr/bin/env python3
"""Install ABI-verified FFmpeg DLLs beside a local Windows PCSX2 build.

Downloads into an ignored cache, verifies SHA256 before extraction, refuses to
replace different DLLs, and checks their exported ABI versions before success.
The legacy default downloads pinned FFmpeg 8. --from-build-deps instead uses the
exact dependency prefix used for compilation, including its ABI version headers.
Does not install ffprobe or modify the system PATH.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
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
    parser.add_argument('--cache', type=Path, help='Receipt/cache directory; build-prefix and legacy download modes have separate defaults')
    parser.add_argument('--from-build-deps', type=Path, help='Use bin DLLs and include ABI headers from the exact dependency prefix used to build PCSX2; no download')
    args = parser.parse_args()
    if args.cache is None:
        name = 'capture-runtime-from-build' if args.from_build_deps else 'capture-runtime-8.0'
        args.cache = Path(__file__).resolve().parent.parent / 'release' / name
    if os.name != 'nt':
        parser.error('This installer is for Windows native PCSX2 only')
    target = args.directory.resolve(strict=True)
    if not (target / 'pcsx2-qt.exe').is_file():
        parser.error('Expected an existing pcsx2-qt.exe in the target directory')
    if args.from_build_deps:
        install_from_build_deps(target, args.from_build_deps.resolve(strict=True), args.cache.resolve())
        return
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


def install_from_build_deps(target: Path, prefix: Path, cache: Path):
    """Match locally built FFmpeg DLLs to the compiler's own version headers."""
    libraries = {}
    headers = {}
    for name in LIBRARIES:
        folder = 'lib' + name
        major_header = prefix / 'include' / folder / 'version_major.h'
        header = major_header if major_header.is_file() else prefix / 'include' / folder / 'version.h'
        text = header.read_text(encoding='utf-8')
        match = re.search(r'^#define\s+' + folder.upper() + r'_VERSION_MAJOR\s+(\d+)\s*$', text, re.MULTILINE)
        if not match:
            raise SystemExit(f'Missing numeric ABI definition in {header}')
        libraries[name] = int(match.group(1)); headers[str(header)] = digest(header)
    names = [f'{name}-{major}.dll' for name, major in libraries.items()]
    for name in names:
        source = prefix / 'bin' / name
        if not source.is_file(): raise SystemExit(f'Missing dependency DLL: {source}')
        if (target / name).exists() and digest(target / name) != digest(source):
            raise SystemExit(f'Refusing to overwrite a different existing DLL: {target / name}')
    for name in names:
        if not (target / name).exists(): shutil.copy2(prefix / 'bin' / name, target / name)
    versions = {}
    with os.add_dll_directory(str(target)):
        for name, major in libraries.items():
            library = ctypes.CDLL(str(target / f'{name}-{major}.dll'))
            function = getattr(library, f'{name}_version'); function.restype = ctypes.c_uint
            value = function()
            if value >> 16 != major: raise SystemExit(f'Unexpected {name} ABI: {value >> 16}, expected {major}')
            versions[name] = value
    cache.mkdir(parents=True, exist_ok=True)
    receipt = {'source_kind':'local_build_dependency_prefix','prefix':str(prefix),
               'executable_sha256':digest(target / 'pcsx2-qt.exe'), 'header_sha256':headers,
               'library_versions':versions, 'dll_sha256':{name:digest(target / name) for name in names}}
    (cache / 'installation.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    print('Verified and installed build-matched FFmpeg capture runtime:', target)


if __name__ == '__main__':
    main()
