/* SPDX-License-Identifier: MIT
 * Same known instruction vectors assembled independently for EE and IOP.
 * Tests redirect only their own fixture PC/registers, never application code. */
.set noreorder
.text
.align 2
.globl fixture_normal
fixture_normal:
    addiu $8, $8, 1
    addiu $8, $8, 2
    jr $31
    nop
.globl fixture_call
fixture_call:
    or $9, $31, $0
.globl fixture_jal
fixture_jal:
    jal fixture_callee
    nop
.globl fixture_return
fixture_return:
    or $31, $9, $0
    jr $31
    nop
.globl fixture_callee
fixture_callee:
    addiu $8, $8, 4
    jr $31
    nop
.globl fixture_hang_call
fixture_hang_call:
    jal fixture_spin
    nop
.globl fixture_hang_return
fixture_hang_return:
    nop
    jr $31
    nop
.globl fixture_spin
fixture_spin:
    b fixture_spin
    nop
#ifdef _IOP
.globl fixture_quiet
fixture_quiet:
    mfc0 $10, $12
    lui $11, %hi(fixture_status)
    addiu $11, $11, %lo(fixture_status)
    sw $10, 0($11)
    addiu $8, $0, -2
    and $10, $10, $8
    mtc0 $10, $12
    nop
    nop
    sw $10, 4($11)
.globl fixture_quiet_ready
fixture_quiet_ready:
    nop
    b fixture_quiet_ready
    nop
#endif
