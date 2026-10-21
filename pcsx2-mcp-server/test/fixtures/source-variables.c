/* Freestanding locals fixture. The breakpoint is reached through a real call. */
typedef struct Probe { int number; unsigned int values[3]; } Probe;
static Probe observed = { 29, { 31, 37, 41 } };
volatile int variables_sink;
__attribute__((noinline)) void inspect_values(int argument, Probe *input) {
    int computed = argument * 2;
    volatile int signed_local = -7;
    volatile unsigned long long wide = 0xfedcba9876543210ULL;
    int values[3] = { 3, 5, 8 };
    Probe record = { 11, { 13, 17, 19 } };
    Probe *pointer = &record;
    int *invalid = (int *)0x10000000;
    int *nothing = (int *)0;
    {
        int shadow = argument + 24;
        __asm__ volatile("nop" : : "r"(computed), "m"(shadow), "m"(signed_local), "m"(wide), "m"(values), "m"(record), "m"(pointer), "m"(invalid), "m"(nothing)); /* INSPECT_HERE */
    }
    variables_sink = argument + input->number + signed_local + values[1] + pointer->number;
    for (;;) { __asm__ volatile("nop"); }
}
void _start(void) {
    inspect_values(23, &observed);
    for (;;) { __asm__ volatile("nop"); }
}
