// SPDX-FileCopyrightText: 2026 PS2Recomp Debug Bridge
// SPDX-License-Identifier: MIT
#pragma once

#include "DebugInterface.h"
#include "Breakpoints.h"
#include "MipsStackWalk.h"

// Compile-time adapters for the pinned 2.6 and 2.9 debugger APIs. Keep native
// validity/error results; do not replace failed reads with successful zeroes.
namespace DebugServer::Compat
{
	template <typename CPU> u32 Read8(CPU& cpu, u32 address, bool& valid)
	{
		if constexpr (requires { cpu.Read8(address, &valid); }) return cpu.Read8(address, &valid);
		else return cpu.read8(address, valid);
	}
	template <typename CPU> u32 Read16(CPU& cpu, u32 address, bool& valid)
	{
		if constexpr (requires { cpu.Read16(address, &valid); }) return cpu.Read16(address, &valid);
		else return cpu.read16(address, valid);
	}
	template <typename CPU> u32 Read32(CPU& cpu, u32 address, bool& valid)
	{
		if constexpr (requires { cpu.Read32(address, &valid); }) return cpu.Read32(address, &valid);
		else return cpu.read32(address, valid);
	}
	template <typename CPU> bool Write8(CPU& cpu, u32 address, u8 value)
	{
		if constexpr (requires { cpu.Write8(address, value); }) return cpu.Write8(address, value);
		else
		{
			if (!cpu.isValidAddress(address)) return false;
			cpu.write8(address, value); return true;
		}
	}
	template <typename Check> u32 Hits(const Check& check)
	{
		if constexpr (requires { check.totalHits; }) return check.totalHits;
		else return check.numHits;
	}
	template <typename Point> bool DefaultBreakpointOptions(const Point& point)
	{
		if constexpr (requires { point.instrumentationEnabled; })
			return point.maxHits == 0 && !point.instrumentationEnabled && point.logFormat.empty() && !point.continueOnHit;
		else return true;
	}
	template <typename Manager = CBreakPoints>
	void AddMemCheck(BreakPointCpu cpu, u32 start, u32 end, MemCheckCondition condition, const std::string& action)
	{
		if constexpr (requires { Manager::ChangeMemCheckInstrumentation(cpu, start, end, true, std::string{}, true); })
		{
			Manager::AddMemCheck(cpu, start, end, condition, MEMCHECK_BREAK);
			Manager::ChangeMemCheckInstrumentation(cpu, start, end, action != "break", {}, action == "log");
		}
		else
		{
			// Legacy MemCheckResult bits: log=1, break=2, both=3.
			const auto result = static_cast<MemCheckResult>(action == "log" ? 1 : action == "both" ? 3 : 2);
			Manager::AddMemCheck(cpu, start, end, condition, result);
		}
	}
	template <typename Thread> u32 StackTop(const Thread& thread)
	{
		if constexpr (requires { thread.StackTop(); }) return thread.StackTop();
		else return 0;
	}
	template <typename CPU> auto Walk(CPU* cpu, u32 pc, u32 ra, u32 sp, u32 entry, u32 stackTop)
	{
		if constexpr (requires { MipsStackWalk::Walk(cpu, pc, ra, sp, entry); })
			return MipsStackWalk::Walk(cpu, pc, ra, sp, entry);
		else return MipsStackWalk::Walk(cpu, pc, ra, sp, entry, stackTop);
	}
}
