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

/* The pinned legacy SDK omits these public ordinal declarations.
   ABI reference: PS2SDK 89b9d8c loadcore.h, ordinals 16/17/24. */
extern void fixture_register_module(ModuleInfo_t *module);
extern void fixture_release_module(ModuleInfo_t *module);
extern ModuleInfo_t *fixture_find_module(void *address);
loadcore_IMPORTS_start
I_RegisterLibraryEntries
DECLARE_IMPORT(16, fixture_register_module)
DECLARE_IMPORT(17, fixture_release_module)
DECLARE_IMPORT(24, fixture_find_module)
loadcore_IMPORTS_end

extern struct irx_export_table _exp_mcptest;
int fixture_exported(void) { return 0x1234; }

IRX_ID("mcp_exception_fixture", 1, 1);
static int fixture_mode;
volatile unsigned fixture_iop_counter;
int _start(int argc, char **argv);
volatile int fixture_lifetime_result;
static void lifetime_probe(void) {
    ModuleInfo_t *own = fixture_find_module((void *)&_start);
    if (!own) { fixture_lifetime_result = -1; return; }
    fixture_release_module(own);
    __asm__ volatile (".globl fixture_released\nfixture_released: nop");
    fixture_register_module(own);
    __asm__ volatile (".globl fixture_reregistered\nfixture_reregistered: nop");
    fixture_lifetime_result = 1;
}

static void worker(void *arg) {
    (void)arg;
    DelayThread(2000000);
    if (fixture_mode == 4) { lifetime_probe(); SleepThread(); return; }
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
    if (RegisterLibraryEntries(&_exp_mcptest) != 0) return MODULE_NO_RESIDENT_END;
    if (argc > 1 && argv[1][0] == 'd') fixture_mode = 1;
    if (argc > 1 && argv[1][0] == 's') fixture_mode = 2;
    if (argc > 1 && argv[1][0] == 'w') fixture_mode = 3;
    if (argc > 1 && argv[1][0] == 'l') fixture_mode = 4;
    thread.attr = TH_C;
    thread.option = 0;
    thread.thread = worker;
    thread.stacksize = 0x1000;
    thread.priority = 40;
    id = CreateThread(&thread);
    if (id < 0 || StartThread(id, 0) < 0) return MODULE_NO_RESIDENT_END;
    return MODULE_RESIDENT_END;
}

DECLARE_EXPORT_TABLE(mcptest, 1, 0)
DECLARE_EXPORT(_start)
DECLARE_EXPORT(fixture_exported)
DECLARE_EXPORT(fixture_exported)
DECLARE_EXPORT(fixture_exported)
END_EXPORT_TABLE
