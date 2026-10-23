// SPDX-License-Identifier: MIT
// Isolated resident IRX; deliberately traps only after its loader has returned.
#include <irx.h>
#include <loadcore.h>
#include <thbase.h>

thbase_IMPORTS_start
I_CreateThread
I_StartThread
I_DelayThread
I_SleepThread
thbase_IMPORTS_end

IRX_ID("mcp_exception_fixture", 1, 1);
static int fixture_mode;
volatile unsigned fixture_iop_counter;

static void worker(void *arg) {
    (void)arg;
    DelayThread(2000000);
    if (fixture_mode == 3) {
        for (;;) {
            fixture_iop_counter += 0x100;
            DelayThread(80000);
        }
    }
    if (fixture_mode == 1) {
        __asm__ volatile (
            ".set push\n.set noreorder\nlui $8, 0x1357\nori $8, $8, 0x9bdf\n"
            ".globl fixture_iop_branch\nfixture_iop_branch:\nbeq $zero, $zero, 1f\n"
            ".globl fixture_iop_delay_break\nfixture_iop_delay_break:\nbreak 0x123\n"
            "1: nop\n.set pop\n" ::: "$8", "memory");
    } else if (fixture_mode == 2) {
        __asm__ volatile (
            ".set push\n.set noreorder\nlui $8, 0x1357\nori $8, $8, 0x9bdf\n"
            ".globl fixture_iop_syscall\nfixture_iop_syscall:\nsyscall 0\n.set pop\n"
            ::: "$8", "memory");
    } else {
        __asm__ volatile (
            ".set push\n.set noreorder\nlui $8, 0x1357\nori $8, $8, 0x9bdf\n"
            ".globl fixture_iop_break\nfixture_iop_break:\nbreak 0x123\n.set pop\n"
            ::: "$8", "memory");
    }
    SleepThread();
}

int _start(int argc, char **argv) {
    iop_thread_t thread;
    int id;
    if (argc > 1 && argv[1][0] == 'd') fixture_mode = 1;
    if (argc > 1 && argv[1][0] == 's') fixture_mode = 2;
    if (argc > 1 && argv[1][0] == 'w') fixture_mode = 3;
    thread.attr = TH_C;
    thread.option = 0;
    thread.thread = worker;
    thread.stacksize = 0x1000;
    thread.priority = 40;
    id = CreateThread(&thread);
    if (id < 0 || StartThread(id, 0) < 0) return MODULE_NO_RESIDENT_END;
    return MODULE_RESIDENT_END;
}
