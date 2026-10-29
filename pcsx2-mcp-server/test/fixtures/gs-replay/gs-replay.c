// SPDX-License-Identifier: MIT
// Continuous GS traffic for replay acceptance; independent of any PS2 project.
#include <debug.h>

volatile unsigned gs_replay_counter;

int main(void) {
    init_scr();
    scr_printf("PCSX2 MCP - GS replay validation\n");
    scr_printf("Continuous drawing; no external services.\n");
    for (;;) {
        ++gs_replay_counter;
        if ((gs_replay_counter & 0xffff) == 0) {
            scr_setXY(0, 3);
            scr_printf("GS replay counter %08x", gs_replay_counter);
        }
    }
    return 0;
}
