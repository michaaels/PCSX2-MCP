// SPDX-License-Identifier: MIT
#include <kernel.h>
#include <sifrpc.h>
#include <loadfile.h>
#include <iopcontrol.h>

#ifndef FIXTURE_MODE
#define FIXTURE_MODE 0
#endif
volatile int fixture_result = -999;
__attribute__((noinline)) void fixture_ready(int result) {
    fixture_result = result;
    __asm__ volatile ("nop"); /* READY: loaded IRX, genuine EE source breakpoint. */
}
int main(void) {
#if FIXTURE_MODE == 1
    static const char args[] = "delay";
#elif FIXTURE_MODE == 2
    static const char args[] = "syscall";
#else
    static const char args[] = "normal";
#endif
    int id;
    SifInitRpc(0);
    id = SifLoadModule("host:iop-exceptions.irx", sizeof(args), args);
    fixture_ready(id);
    if (id >= 0 && FIXTURE_MODE == 3) {
        while (!SifIopReset("rom0:UDNL rom0:EELOADCNF", 0)) {}
        while (!SifIopSync()) {}
    }
    if (id >= 0 && FIXTURE_MODE == 4) {
        /* Pinned PCSX2 HwWrite.cpp SBUS_F240 bit 19 invokes psxReset.
           Isolated emulator-only reset probe; not a physical PS2 test. */
        *(volatile unsigned *)0x1000f240 = 1u << 19;
    }
    for (;;) { __asm__ volatile ("nop"); }
    return 0;
}
