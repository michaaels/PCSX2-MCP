/* Freestanding progress fixture: no SDK, network or game content. */
volatile unsigned progress_heartbeat;
volatile unsigned progress_active = 1;
volatile unsigned progress_mode;

void _start(void) {
    progress_heartbeat = 1; /* READY: genuine source breakpoint before the loop. */
    for (;;) {
        __asm__ volatile (".globl progress_loop\nprogress_loop:\nnop");
        if (progress_mode == 0) progress_heartbeat++;
        __asm__ volatile ("nop");
    }
}
