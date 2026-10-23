#!/bin/sh
set -eu
if ! command -v make >/dev/null 2>&1; then apk add --no-cache make; fi
cd /fixture
make -f Makefile.iop
# Legacy loadcore can process every SHT_REL, including file-only DWARF ones.
# Keep the debug companion for source lookup and load only the stripped copy.
cp iop-exceptions.irx iop-exceptions.debug.irx
iop-strip --strip-debug iop-exceptions.irx
make -f Makefile.ee NAME=normal MODE=0
make -f Makefile.ee NAME=delay MODE=1
make -f Makefile.ee NAME=syscall MODE=2
make -f Makefile.ee NAME=reset MODE=3
make -f Makefile.ee NAME=hardreset MODE=4
make -f Makefile.ee NAME=watch MODE=5
make -f Makefile.ee NAME=lifetime MODE=6
ee-gcc --version > toolchain.txt
iop-gcc --version >> toolchain.txt
cat "$PS2SDK/ID" >> toolchain.txt
