// SPDX-License-Identifier: MIT
// Minimal PS2 homebrew fixture for MCP validation; no game/project dependencies.
#include <debug.h>
volatile unsigned standalone_counter;
volatile unsigned standalone_magic = 0x4d435032;
__attribute__((noinline)) void standalone_tick(unsigned increment) {
    standalone_counter += increment; /* MCP_TICK: genuine executable source line. */
}
int main(void) {
    init_scr();
    scr_printf("PCSX2 MCP - standalone validation\n");
    scr_printf("No SMS, media server or network required.\n");
    for (;;) standalone_tick(1);
    return 0;
}
