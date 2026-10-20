/* Freestanding R5900-compatible integer loop for source-location validation.
 * This is a test program, not the SMS client or a PS2SDK replacement. */
volatile unsigned int source_counter = 0;

static __attribute__((always_inline)) inline void source_tick(void) {
    source_counter += 1;
}

void _start(void) {
    for (;;) {
        source_tick();
    }
}
