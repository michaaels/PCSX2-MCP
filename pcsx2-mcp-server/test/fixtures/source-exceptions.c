/* Freestanding fixture: no game assets, network or SDK dependencies. */
volatile unsigned exception_mode;
volatile unsigned exception_counter;

void _start(void) {
    exception_counter = 1; /* READY: breakpoint before the trap. */
    if (exception_mode == 1) {
        __asm__ volatile (
            ".set push\n.set noreorder\n"
            ".globl exception_delay_branch\nexception_delay_branch:\n"
            "beq $zero, $zero, 1f\n"
            ".globl exception_delay_break\nexception_delay_break:\n"
            "break 0\n"
            "1: nop\n.set pop\n");
    } else if (exception_mode == 2) {
        __asm__ volatile (
            ".set push\n.set noreorder\n"
            "lui $8, 0x0010\nori $8, $8, 0x1234\nmtc0 $8, $14\n"
            "mfc0 $8, $12\nori $8, $8, 2\nmtc0 $8, $12\nnop\nnop\n"
            ".globl exception_nested_break\nexception_nested_break:\nbreak 0\n"
            ".set pop\n" ::: "$8", "memory");
    } else if (exception_mode == 3) {
        /* Capture code 8 before the BIOS handles this deliberately selected syscall. */
        __asm__ volatile (
            ".set push\n.set noreorder\naddiu $3, $zero, 0\n"
            ".globl exception_syscall\nexception_syscall:\nsyscall 0\n.set pop\n"
            ::: "$3", "memory");
    } else {
        __asm__ volatile (".globl exception_normal_break\nexception_normal_break:\nbreak 0");
    }
    for (;;) { exception_counter++; }
}
