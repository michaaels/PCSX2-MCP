// SPDX-License-Identifier: MIT
// Isolated emulator probe. No SMS, decoder, network or audio code is involved.
#include <kernel.h>
#include <sifrpc.h>
#include <loadfile.h>
#include <iopheap.h>
#include <stdio.h>

#ifndef FIXTURE_MODE
#define FIXTURE_MODE 0
#endif
#define REG32(a) (*(volatile unsigned *)(a))
volatile unsigned fixture_ee[16];
static unsigned payload[8] __attribute__((aligned(64))) = {
    0x53494632, 0x12345678, 0xabcdef01, 0x87654321,
    0x0badf00d, 0x55aa55aa, 0xa55aa55a, 0xdeadbeef
};
__attribute__((noinline)) void fixture_ready(void) {
    __asm__ volatile ("nop"); /* READY: receiver configured, producer not started. */
}
__attribute__((noinline)) void fixture_done(void) {
    __asm__ volatile ("nop"); /* DONE: bounded observation interval has elapsed. */
}
int main(void) {
    char args[16];
    int id, i;
    unsigned addr;
    fixture_ee[0] = 0x53494645;
    fixture_ee[1] = FIXTURE_MODE;
    SifInitRpc(0);
    SifInitIopHeap();
    addr = (unsigned)SifAllocIopHeap(256);
    fixture_ee[3] = addr;
    if (!addr || addr >= 0x00200000) { fixture_ee[2] = -1000; fixture_done(); for (;;) {} }
    args[0] = '0' + FIXTURE_MODE; args[1] = 0;
    snprintf(args + 2, 9, "%08x", addr);
    id = SifLoadModule("host:sif-transfer.irx", 11, args);
    fixture_ee[2] = id;
    fixture_ee[4] = 1;
    fixture_ready();
    if (id >= 0) {
        /* Clear only the pending SIF2 completion bit; no interrupt mask changes. */
        REG32(0x1000e010) = 0x80;
        fixture_ee[7] = REG32(0x1000e010);
        FlushCache(0);
        if (FIXTURE_MODE < 2) {
            REG32(0x1000c810) = (unsigned)payload & 0x1fffffff;
            REG32(0x1000c820) = 2;
            __asm__ volatile ("sync.l" ::: "memory");
            REG32(0x1000c800) = 0x101; /* Normal, memory -> FIFO, STR. */
        } else {
            /* Programmed-I/O positive control using the same eight payload words. */
            for (i = 0; i < 8; ++i) REG32(0x1000f3e0) = payload[i];
        }
        /* Bounded guest execution without relying on an EE DelayThread API. */
        {
            unsigned start, now;
            __asm__ volatile ("mfc0 %0, $9" : "=r"(start));
            do { __asm__ volatile ("mfc0 %0, $9" : "=r"(now)); }
            while ((unsigned)(now - start) < 20000000);
        }
    }
    fixture_ee[5] = REG32(0x1000c800);
    fixture_ee[6] = REG32(0x1000c820);
    fixture_ee[8] = REG32(0x1000e010);
    fixture_ee[4] = 2;
    fixture_done();
    for (;;) __asm__ volatile ("nop");
    return 0;
}
