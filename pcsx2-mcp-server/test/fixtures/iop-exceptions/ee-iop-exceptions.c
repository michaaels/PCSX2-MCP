// SPDX-License-Identifier: MIT
#include <kernel.h>
#include <sifrpc.h>
#include <loadfile.h>
#include <iopcontrol.h>

#ifndef FIXTURE_MODE
#define FIXTURE_MODE 0
#endif
volatile int fixture_result = -999;
volatile unsigned fixture_ee_counter;
__attribute__((noinline)) void fixture_before_load(void) {
    __asm__ volatile ("nop"); /* BEFORE_LOAD: arm provenance before SifLoadModule. */
}
__attribute__((noinline)) void fixture_ready(int result) {
    fixture_result = result;
    __asm__ volatile ("nop"); /* READY: loaded IRX, genuine EE source breakpoint. */
}
__attribute__((noinline)) void fixture_after_reset(void) {
    __asm__ volatile ("nop"); /* AFTER_SOFTWARE_RESET: SifIopSync returned. */
}
int main(void) {
#if FIXTURE_MODE == 1
    static const char args[] = "delay";
#elif FIXTURE_MODE == 2
    static const char args[] = "syscall";
#elif FIXTURE_MODE == 5
    static const char args[] = "watch";
#elif FIXTURE_MODE == 6
    static const char args[] = "lifetime";
#elif FIXTURE_MODE == 7
    static const char args[] = "module";
#else
    static const char args[] = "normal";
#endif
    int id;
    SifInitRpc(0);
    fixture_before_load();
    id = SifLoadModule("host:iop-exceptions.irx", sizeof(args), args);
    fixture_ready(id);
    if (id >= 0 && FIXTURE_MODE == 3) {
        while (!SifIopReset("rom0:UDNL rom0:EELOADCNF", 0)) {}
        while (!SifIopSync()) {}
        fixture_after_reset();
    }
    if (id >= 0 && FIXTURE_MODE == 4) {
        /* Pinned PCSX2 HwWrite.cpp SBUS_F240 bit 19 invokes psxReset.
           Isolated emulator-only reset probe; not a physical PS2 test. */
        *(volatile unsigned *)0x1000f240 = 1u << 19;
    }
    for (;;) {
        if (FIXTURE_MODE == 5) fixture_ee_counter += 0x100;
        __asm__ volatile ("nop");
    }
    return 0;
}
