// SPDX-License-Identifier: MIT
#include <irx.h>
#include <loadcore.h>
#include <intrman.h>

intrman_IMPORTS_start
I_RegisterIntrHandler
I_EnableIntr
intrman_IMPORTS_end
IRX_ID("mcp_sif_transfer", 1, 1);
#define REG32(a) (*(volatile unsigned *)(a))
#define REG16(a) (*(volatile unsigned short *)(a))

static int completed(void *arg) {
    volatile unsigned *report = arg;
    ++report[5];
    report[7] = REG32(0xbf8010a4);
    report[8] = REG32(0xbf8010a8);
    report[9] = REG32(0xbf8010f4);
    return 1;
}
static unsigned hex_address(const char *text) {
    unsigned value = 0, i;
    for (i = 0; i < 8; ++i) {
        unsigned c = text[i];
        if (c >= '0' && c <= '9') c -= '0';
        else if (c >= 'a' && c <= 'f') c = c - 'a' + 10;
        else return 0;
        value = (value << 4) | c;
    }
    return value;
}
int _start(int argc, char **argv) {
    volatile unsigned *report;
    unsigned addr, mode, i;
    int rc;
    if (argc != 3 || argv[1][0] < '0' || argv[1][0] > '3') return MODULE_NO_RESIDENT_END;
    mode = argv[1][0] - '0'; addr = hex_address(argv[2]);
    if (!addr || addr > 0x001fff00 || (addr & 15)) return MODULE_NO_RESIDENT_END;
    report = (volatile unsigned *)addr;
    for (i = 0; i < 64; ++i) report[i] = 0;
    for (i = 16; i < 24; ++i) report[i] = 0xcafecafe;
    report[0] = 0x53494649; report[1] = mode;
    rc = RegisterIntrHandler(IOP_IRQ_DMA_SIF2, 1, completed, (void *)report);
    report[10] = rc;
    if (rc != 0) return MODULE_NO_RESIDENT_END;
    report[11] = EnableIntr(IOP_IRQ_DMA_SIF2);
    REG32(0xbf8010f0) |= 0x800; /* Channel 2 DPCR enable. */
    REG32(0xbf8010a8) = 0;
    REG32(0xbf8010a0) = addr + 64;
    REG32(0xbf8010a4) = 0;
    if (mode == 0 || mode == 3) {
        REG16(0xbf8010a4) = 8;
        REG16(0xbf8010a6) = 1;
    } else REG32(0xbf8010a4) = 0x00010008;
    report[3] = REG32(0xbf8010a4);
    REG32(0xbf8010a8) = 0x01000200; /* Request mode, FIFO -> IOP, STR. */
    report[4] = REG32(0xbf8010a8);
    report[2] = 1;
    return MODULE_RESIDENT_END;
}
