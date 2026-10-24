#!/bin/sh
set -eu
if ! command -v make >/dev/null 2>&1; then apk add --no-cache make; fi
cd /fixture
make -f Makefile.iop
cp sif-transfer.irx sif-transfer.debug.irx
iop-strip --strip-debug sif-transfer.irx
make -f Makefile.ee NAME=half-dma MODE=0
make -f Makefile.ee NAME=full-dma MODE=1
make -f Makefile.ee NAME=full-pio MODE=2
make -f Makefile.ee NAME=half-pio MODE=3
ee-gcc --version > toolchain.txt
iop-gcc --version >> toolchain.txt
cat "$PS2SDK/ID" >> toolchain.txt
