/* SPDX-License-Identifier: MIT
 * Controlled vectors in a fixture-owned IOP thread. Never masks CP0 IE. */
.set noreorder
.text
.align 2
.globl irq_worker
irq_worker:
    or $16, $4, $0
    mfc0 $9, $12
    nop
    sw $9, 52($16)
.globl irq_ready
irq_ready:
    b irq_ready
    nop
.globl fixture_normal
fixture_normal:
    addiu $8, $8, 1
    addiu $8, $8, 2
    b irq_ready
    nop
.globl fixture_jal
fixture_jal:
    jal fixture_callee
    nop
.globl fixture_return
fixture_return:
    b irq_ready
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
    b irq_ready
    nop
.globl fixture_spin
fixture_spin:
    b fixture_spin
    nop
