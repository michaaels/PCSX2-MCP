// SPDX-License-Identifier: MIT
#include <irx.h>
#include <loadcore.h>
#include <thbase.h>
#include <vblank.h>
IRX_ID("mcp_irq_control", 1, 1);
thbase_IMPORTS_start
I_CreateThread
I_StartThread
thbase_IMPORTS_end
vblank_IMPORTS_start
I_RegisterVblankHandler
vblank_IMPORTS_end
extern void fixture_normal(void), fixture_jal(void), fixture_return(void);
extern void fixture_callee(void), fixture_hang_call(void), fixture_spin(void);
extern void irq_worker(void *), irq_ready(void);
volatile unsigned *irq_report;
static int on_vblank(void *arg) {
    volatile unsigned *report = arg;
    unsigned status;
    __asm__ volatile ("mfc0 %0, $12" : "=r"(status));
    report[12] = status;
    ++report[10];
    return 1;
}
int _start(int argc, char **argv) {
    unsigned addr = 0, i;
    iop_thread_t thread;
    if (argc != 2) return MODULE_NO_RESIDENT_END;
    for (i = 0; i < 8; ++i) {
        unsigned c = argv[1][i];
        if (c >= '0' && c <= '9') c -= '0';
        else if (c >= 'a' && c <= 'f') c = c - 'a' + 10;
        else return MODULE_NO_RESIDENT_END;
        addr = (addr << 4) | c;
    }
    if (!addr || addr > 0x001fff00 || (addr & 15)) return MODULE_NO_RESIDENT_END;
    irq_report = (volatile unsigned *)addr;
    for (i = 0; i < 64; ++i) irq_report[i] = 0;
    irq_report[1] = (unsigned)fixture_normal;
    irq_report[2] = (unsigned)fixture_jal;
    irq_report[3] = (unsigned)fixture_return;
    irq_report[4] = (unsigned)fixture_callee;
    irq_report[5] = (unsigned)fixture_hang_call;
    irq_report[6] = (unsigned)fixture_spin;
    irq_report[7] = (unsigned)irq_worker;
    irq_report[8] = (unsigned)irq_ready;
    irq_report[11] = RegisterVblankHandler(0, 16, on_vblank, (void *)irq_report);
    if (irq_report[11] != 0) return MODULE_NO_RESIDENT_END;
    thread.attr = TH_C;
    thread.option = 0;
    thread.thread = irq_worker;
    thread.stacksize = 4096;
    thread.priority = 126;
    irq_report[9] = CreateThread(&thread);
    if ((int)irq_report[9] < 0) return MODULE_NO_RESIDENT_END;
    irq_report[14] = StartThread(irq_report[9], (void *)irq_report);
    irq_report[0] = 0x49525149;
    return MODULE_RESIDENT_END;
}
