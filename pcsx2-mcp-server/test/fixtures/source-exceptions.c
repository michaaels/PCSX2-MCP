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
    } else if (exception_mode == 4) {
        __asm__ volatile (
            ".set push\n.set noreorder\naddiu $3, $zero, 0\n"
            ".globl exception_syscall_branch\nexception_syscall_branch:\nbeq $zero, $zero, 1f\n"
            ".globl exception_delay_syscall\nexception_delay_syscall:\nsyscall 0\n"
            "1: nop\n.set pop\n" ::: "$3", "memory");
    } else if (exception_mode == 5) {
        __asm__ volatile (
            ".set push\n.set noreorder\n"
            "lui $8, 0x0010\nori $8, $8, 0x1234\nmtc0 $8, $14\n"
            "mfc0 $8, $12\nori $8, $8, 2\nmtc0 $8, $12\nnop\nnop\n"
            "addiu $3, $zero, 0\n"
            ".globl exception_nested_syscall\nexception_nested_syscall:\nsyscall 0\n"
            ".set pop\n" ::: "$3", "$8", "memory");
    } else if (exception_mode == 6) {
        /* The JIT resolves constant FlushCache/iFlushCache without cpuException. */
        __asm__ volatile (
            ".set push\n.set noreorder\naddiu $3, $zero, 0x64\nsyscall 0\n"
            "addiu $3, $zero, 0x68\nsyscall 0\n"
            ".globl exception_after_flushcache\nexception_after_flushcache:\nbreak 0\n"
            ".set pop\n" ::: "$3", "memory");
    } else if (exception_mode == 7) {
        /* GetOsdConfigParam2 has an HLE early return on the pinned retail BIOS. */
        __asm__ volatile (
            ".set push\n.set noreorder\naddiu $3, $zero, 111\n"
            "or $4, $zero, $zero\nor $5, $zero, $zero\nor $6, $zero, $zero\nsyscall 0\n"
            ".globl exception_after_hle\nexception_after_hle:\nbreak 0\n"
            ".set pop\n" ::: "$3", "$4", "$5", "$6", "memory");
    } else if (exception_mode == 8) {
        exception_counter = 0x64;
        /* A runtime load deliberately defeats the JIT constant fast path. */
        __asm__ volatile (
            ".set push\n.set noreorder\nlui $8, %%hi(exception_counter)\n"
            "lw $3, %%lo(exception_counter)($8)\nnop\n"
            ".globl exception_runtime_flushcache\nexception_runtime_flushcache:\nsyscall 0\n"
            ".set pop\n" ::: "$3", "$8", "memory");
    } else {
        __asm__ volatile (".globl exception_normal_break\nexception_normal_break:\nbreak 0");
    }
    for (;;) { exception_counter++; }
}
