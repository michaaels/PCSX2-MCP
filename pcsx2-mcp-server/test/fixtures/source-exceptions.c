/* Freestanding fixture: no game assets, network or SDK dependencies. */
volatile unsigned exception_mode;
volatile unsigned exception_counter;

void _start(void) {
    exception_counter = 1; /* READY: breakpoint before the trap. */
    if (exception_mode == 1) {
        __asm__ volatile (
            ".set push\n.set noreorder\n"
            "beq $zero, $zero, 1f\n"
            "break 0\n"
            "1: nop\n.set pop\n");
    } else {
        __asm__ volatile ("break 0");
    }
    for (;;) { exception_counter++; }
}
