/* Freestanding EE stepping fixture: real calls, conditional loop and delay slots. */
volatile unsigned int step_counter, step_control;
__attribute__((noinline)) unsigned int step_add(unsigned int value) {
    step_counter += value;
    return step_counter;
}
void _start(void) {
    step_counter = 0;
    for (unsigned int i = 0; i < 3; ++i) {
        step_add(i + 1);
    }
    step_counter = 42;
    if (step_control) {
        __asm__ volatile("break 0");
    }
    for (;;) { __asm__ volatile("nop"); }
}
