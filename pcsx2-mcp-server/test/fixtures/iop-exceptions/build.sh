#!/bin/sh
set -eu
if ! command -v make >/dev/null 2>&1; then apk add --no-cache make; fi
cd /fixture
make -f Makefile.iop
make -f Makefile.ee NAME=normal MODE=0
make -f Makefile.ee NAME=delay MODE=1
make -f Makefile.ee NAME=syscall MODE=2
make -f Makefile.ee NAME=reset MODE=3
make -f Makefile.ee NAME=hardreset MODE=4
make -f Makefile.ee NAME=watch MODE=5
ee-gcc --version > toolchain.txt
iop-gcc --version >> toolchain.txt
cat "$PS2SDK/ID" >> toolchain.txt
