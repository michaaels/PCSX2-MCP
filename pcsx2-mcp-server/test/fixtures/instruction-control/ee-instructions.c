// SPDX-License-Identifier: MIT
#include <kernel.h>
#include <sifrpc.h>
#include <loadfile.h>
#include <iopheap.h>
#include <stdio.h>
extern void fixture_normal(void);
volatile unsigned instruction_meta[16];
__attribute__((noinline)) void instruction_ready(void) {
    __asm__ volatile ("nop"); /* READY: actual resident module reported its addresses. */
}
int main(void) {
    char args[9];
    unsigned addr;
    SifInitRpc(0); SifInitIopHeap();
    instruction_meta[0] = 0x53544545;
    addr = (unsigned)SifAllocIopHeap(256);
    instruction_meta[2] = addr;
    if (!addr || addr > 0x001fff00) { instruction_meta[1] = -1000; for (;;) {} }
    snprintf(args, sizeof(args), "%08x", addr);
    instruction_meta[1] = SifLoadModule("host:instruction-control.irx", sizeof(args), args);
    instruction_meta[3] = 1;
    instruction_ready();
    for (;;) fixture_normal();
    return 0;
}
