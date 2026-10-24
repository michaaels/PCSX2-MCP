// SPDX-License-Identifier: MIT
#include <irx.h>
#include <loadcore.h>
IRX_ID("mcp_instruction_control", 1, 1);
extern void fixture_normal(void), fixture_jal(void), fixture_return(void);
extern void fixture_callee(void), fixture_hang_call(void), fixture_spin(void);
extern void fixture_quiet(void), fixture_quiet_ready(void);
volatile unsigned fixture_status[2];
int _start(int argc, char **argv) {
    unsigned addr = 0, i;
    volatile unsigned *report;
    if (argc != 2) return MODULE_NO_RESIDENT_END;
    for (i = 0; i < 8; ++i) {
        unsigned c = argv[1][i];
        if (c >= '0' && c <= '9') c -= '0';
        else if (c >= 'a' && c <= 'f') c = c - 'a' + 10;
        else return MODULE_NO_RESIDENT_END;
        addr = (addr << 4) | c;
    }
    if (!addr || addr > 0x001fff00 || (addr & 15)) return MODULE_NO_RESIDENT_END;
    report = (volatile unsigned *)addr;
    for (i = 0; i < 64; ++i) report[i] = 0;
    report[1] = (unsigned)fixture_normal;
    report[2] = (unsigned)fixture_jal;
    report[3] = (unsigned)fixture_return;
    report[4] = (unsigned)fixture_callee;
    report[5] = (unsigned)fixture_hang_call;
    report[6] = (unsigned)fixture_spin;
    report[7] = (unsigned)fixture_quiet;
    report[8] = (unsigned)fixture_quiet_ready;
    report[9] = (unsigned)fixture_status;
    report[0] = 0x5354494f;
    return MODULE_RESIDENT_END;
}
