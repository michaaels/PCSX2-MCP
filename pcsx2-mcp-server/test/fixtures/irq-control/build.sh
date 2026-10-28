#!/bin/sh
set -eu
if ! command -v make >/dev/null 2>&1; then apk add --no-cache make; fi
cd /fixture
make -f Makefile.iop
cp irq-control.irx irq-control.debug.irx
iop-strip --strip-debug irq-control.irx
make -f Makefile.ee
ee-gcc --version > toolchain.txt
iop-gcc --version >> toolchain.txt
cat "$PS2SDK/ID" >> toolchain.txt
