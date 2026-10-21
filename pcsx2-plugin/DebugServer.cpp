// SPDX-FileCopyrightText: 2026 PS2Recomp Debug Bridge
// SPDX-License-Identifier: MIT
//
// PCSX2 Debug Server — JSON/TCP API wrapping full DebugInterface
// Protocol: newline-delimited JSON over TCP (port 21512)
//
// Request:  {"cmd":"read_registers","cpu":"ee","category":0}\n
// Response: {"ok":true,"data":{...}}\n
//
// Integration:
//   1. Drop DebugServer.h + DebugServer.cpp into pcsx2/DebugTools/
//   2. Add to CMakeLists.txt
//   3. Call DebugServer::Start() from VMManager::Initialize()
//   4. Call DebugServer::Stop() from VMManager::Shutdown()
//   5. Integrate breakpoint, state and console hooks with tools/apply-debug-server.py

// ============================================================
// NOTE: This file uses a minimal inline JSON builder to avoid
// external dependencies. PCSX2 doesn't bundle nlohmann/json
// in all configurations.
// ============================================================

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
typedef SOCKET socket_t;
#define SOCKET_INVALID INVALID_SOCKET
#define CLOSE_SOCKET closesocket
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
typedef int socket_t;
#define SOCKET_INVALID (-1)
#define CLOSE_SOCKET close
#endif

#include "DebugServer.h"
#include "DebugInterface.h"
#include "Breakpoints.h"
#include "MipsStackWalk.h"
#include "MIPSAnalyst.h"
#include "R5900.h"
#include "R5900OpcodeTables.h"
#include "SymbolGuardian.h"
#include "SymbolImporter.h"
#include "Host.h"
#include "MTGS.h"
#include "VMManager.h"
#include "Achievements.h"
#include "Recording/InputRecording.h"
#include "SIO/Pad/Pad.h"
#include "SIO/Pad/PadDualshock2.h"
#include "common/Image.h"
#include "common/Console.h"
#include "common/FileSystem.h"

#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <condition_variable>
#include <sstream>
#include <algorithm>
#include <chrono>
#include <memory>
#include <cerrno>
#include <deque>
#include <future>
#include <array>

// Forward declarations — these are PCSX2 globals
extern R5900DebugInterface r5900Debug;
extern R3000DebugInterface r3000Debug;

namespace DebugServer
{
	static std::atomic<bool> s_running{false};
	struct HistoryEntry
	{
		uint64_t sequence;
		int64_t timestamp;
		std::string kind;
		std::string detail;
		std::string cpu;
		u32 pc = 0;
		int level = 0;
		bool truncated = false;
	};
	static std::mutex s_historyMutex;
	static std::condition_variable s_eventReady;
	static std::deque<HistoryEntry> s_events, s_logs;
	static uint64_t s_eventSequence = 0, s_logSequence = 0;
	static std::atomic<uint64_t> s_session{0};
	// Accessed exclusively on the CPU thread. Count VSync boundaries, not host FPS.
	static uint64_t s_videoFrame = 0, s_operationSequence = 0;
	static constexpr std::array<u32, 16> s_buttonBits = {12, 13, 14, 15, 4, 5, 6, 7, 8, 11, 2, 0, 3, 1, 9, 10};
	struct FrameOperation
	{
		uint64_t id = 0, start = 0, target = 0, end = 0;
		bool active = false, input = false;
		u8 controller = 0;
		u32 buttons = 0, savedButtons = 0;
		std::array<u8, 4> axes{127, 127, 127, 127};
		std::array<u8, 16> savedPressures{};
		std::tuple<u8, u8> savedLeft, savedRight;
		PadBase* savedPad = nullptr;
		std::string reason;
		std::chrono::steady_clock::time_point deadline;
	};
	static FrameOperation s_operation;
	// CPU-thread state; only the watchdog deadline crosses threads.
	static uint64_t s_executionEpoch = 1, s_stepSequence = 0;
	static uint64_t s_inspectionRevision = 1;
	struct GuardedStep
	{
		uint64_t id = 0, epoch = 0;
		u32 start = 0, target = 0, opcode = 0, units = 0;
		bool active = false, owned = false, cleanup = true, call = false, ret = false;
		std::string marker, reason;
	};
	static GuardedStep s_step;
	static std::atomic<int64_t> s_stepDeadline{0};
	static std::atomic<uint64_t> s_stepWatchId{0};
	// CPU-thread POD only: cpuException may safe-exit via longjmp. Its hook
	// consumes this before pausing; no RAII lifetime may cross that exit.
	struct EEBreakOrigin
	{
		bool active = false, branchDelay = false, opcodeMatchesMemory = false;
		u32 pc = 0, opcode = 0;
	};
	static EEBreakOrigin s_eeBreakOrigin;
	struct ExceptionWatch
	{
		std::string id, state, elf, report;
		uint64_t sequence = 0, session = 0, epoch = 0, revision = 0;
		u32 crc = 0, mask = 0, code = 0, exceptionPC = 0, postPC = 0;
		bool branchDelay = false, nested = false, screenshot = true;
		int64_t deadline = 0, timestamp = 0;
		std::array<u128, 32> gpr{};
		std::array<u32, 32> cp0{};
		EEBreakOrigin instruction;
	};
	static ExceptionWatch s_exception;
	static uint64_t s_exceptionSequence = 0;
	static std::atomic<uint64_t> s_exceptionPending{0};
	static std::atomic<uint64_t> s_exceptionWatchId{0};
	static std::atomic<int64_t> s_exceptionDeadline{0};
	static int64_t steadyMillis()
	{
		return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
	}

	static int64_t timestampMillis()
	{
		return std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::system_clock::now().time_since_epoch()).count();
	}

	static void recordEvent(const char* kind, const char* cpu = "", u32 pc = 0, std::string detail = {})
	{
		std::lock_guard lock(s_historyMutex);
		s_events.push_back({++s_eventSequence, timestampMillis(), kind, std::move(detail), cpu, pc});
		if (s_events.size() > 512) s_events.pop_front();
		s_eventReady.notify_all();
	}

	static void recordLog(LOGLEVEL level, ConsoleColors color, std::string_view message)
	{
		if (!s_running.load()) return;
		// Colors alone are not reliable CPU attribution; preserve a console source.
		std::string text(message.substr(0, 2048));
		std::lock_guard lock(s_historyMutex);
		s_logs.push_back({++s_logSequence, timestampMillis(), "console", std::move(text), "", 0,
			static_cast<int>(level), message.size() > 2048});
		if (s_logs.size() > 2048) s_logs.pop_front();
	}

	// ============================================================
	// Minimal JSON Builder
	// ============================================================
	class JsonBuilder
	{
	public:
		void startObject() { comma(); m_buf += '{'; m_needComma.push_back(false); }
		void endObject() { m_buf += '}'; m_needComma.pop_back(); if (!m_needComma.empty()) m_needComma.back() = true; }
		void startArray() { comma(); m_buf += '['; m_needComma.push_back(false); }
		void endArray() { m_buf += ']'; m_needComma.pop_back(); if (!m_needComma.empty()) m_needComma.back() = true; }

		void key(const char* k)
		{
			comma();
			m_buf += '"';
			escapeStr(k);
			m_buf += "\":";
			m_needComma.back() = false; // value follows
		}

		void valStr(const char* v) { comma(); m_buf += '"'; escapeStr(v); m_buf += '"'; m_needComma.back() = true; }
		void valStr(const std::string& v) { valStr(v.c_str()); }
		void valInt(int64_t v) { comma(); m_buf += std::to_string(v); m_needComma.back() = true; }
		void valUint(uint64_t v) { comma(); m_buf += std::to_string(v); m_needComma.back() = true; }
		void valBool(bool v) { comma(); m_buf += v ? "true" : "false"; m_needComma.back() = true; }
		void valNull() { comma(); m_buf += "null"; m_needComma.back() = true; }
		// Only for JSON produced by this server, never untrusted request text.
		void valJson(const std::string& value) { comma(); m_buf += value; m_needComma.back() = true; }

		void valHex32(uint32_t v)
		{
			char buf[16];
			snprintf(buf, sizeof(buf), "0x%08x", v);
			comma();
			m_buf += '"';
			m_buf += buf;
			m_buf += '"';
			m_needComma.back() = true;
		}

		void valHex128(u128 v)
		{
			char buf[40];
			snprintf(buf, sizeof(buf), "%08x%08x%08x%08x",
				v._u32[3], v._u32[2], v._u32[1], v._u32[0]);
			comma();
			m_buf += '"';
			m_buf += buf;
			m_buf += '"';
			m_needComma.back() = true;
		}

		// Key-value shortcuts
		void kv(const char* k, const char* v) { key(k); valStr(v); }
		void kv(const char* k, const std::string& v) { key(k); valStr(v); }
		void kv(const char* k, int v) { key(k); valInt(static_cast<int64_t>(v)); }
		void kv(const char* k, unsigned int v) { key(k); valUint(static_cast<uint64_t>(v)); }
		void kv(const char* k, int64_t v) { key(k); valInt(v); }
		void kv(const char* k, uint64_t v) { key(k); valUint(v); }
		void kv(const char* k, bool v) { key(k); valBool(v); }

		std::string str() const { return m_buf; }
		void clear() { m_buf.clear(); m_needComma.clear(); }

	private:
		void comma()
		{
			if (!m_needComma.empty() && m_needComma.back())
				m_buf += ',';
		}
		void escapeStr(const char* s)
		{
			for (; *s; ++s)
			{
				switch (*s)
				{
					case '"': m_buf += "\\\""; break;
					case '\\': m_buf += "\\\\"; break;
					case '\n': m_buf += "\\n"; break;
					case '\r': m_buf += "\\r"; break;
					case '\t': m_buf += "\\t"; break;
					default:
						if (static_cast<unsigned char>(*s) < 0x20)
						{
							char escaped[7];
							snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned char>(*s));
							m_buf += escaped;
						}
						else m_buf += *s;
						break;
				}
			}
		}

		std::string m_buf;
		std::vector<bool> m_needComma;
	};

	// ============================================================
	// Minimal JSON Parser (just enough for our commands)
	// ============================================================
	struct JsonValue
	{
		enum Type { NONE, STRING, NUMBER, BOOL, OBJECT };
		Type type = NONE;
		std::string strVal;
		int64_t numVal = 0;
		bool boolVal = false;
	};

	static std::unordered_map<std::string, JsonValue> parseJsonObject(const std::string& json)
	{
		std::unordered_map<std::string, JsonValue> result;
		size_t i = 0;
		// Skip to first '{'
		while (i < json.size() && json[i] != '{') i++;
		i++; // skip '{'

		while (i < json.size())
		{
			// Skip whitespace/commas
			while (i < json.size() && (json[i] == ' ' || json[i] == '\t' || json[i] == '\n' || json[i] == '\r' || json[i] == ','))
				i++;
			if (i >= json.size() || json[i] == '}') break;

			// Read key
			if (json[i] != '"') break;
			i++;
			std::string key;
			while (i < json.size() && json[i] != '"')
			{
				if (json[i] == '\\' && i + 1 < json.size()) { key += json[i + 1]; i += 2; }
				else { key += json[i]; i++; }
			}
			i++; // skip closing '"'

			// Skip colon
			while (i < json.size() && json[i] != ':') i++;
			i++;

			// Skip whitespace
			while (i < json.size() && (json[i] == ' ' || json[i] == '\t')) i++;

			JsonValue val;
			if (json[i] == '"')
			{
				// String value
				i++;
				std::string sv;
				while (i < json.size() && json[i] != '"')
				{
					if (json[i] == '\\' && i + 1 < json.size()) { sv += json[i + 1]; i += 2; }
					else { sv += json[i]; i++; }
				}
				i++; // skip closing '"'
				val.type = JsonValue::STRING;
				val.strVal = sv;
			}
			else if (json[i] == 't' || json[i] == 'f')
			{
				val.type = JsonValue::BOOL;
				val.boolVal = (json[i] == 't');
				while (i < json.size() && json[i] != ',' && json[i] != '}') i++;
			}
			else if (json[i] == '-' || (json[i] >= '0' && json[i] <= '9'))
			{
				std::string ns;
				bool isHex = false;
				if (json[i] == '0' && i + 1 < json.size() && (json[i + 1] == 'x' || json[i + 1] == 'X'))
				{
					isHex = true;
					i += 2;
				}
				while (i < json.size() && ((json[i] >= '0' && json[i] <= '9') ||
					   json[i] == '-' ||
					   (isHex && ((json[i] >= 'a' && json[i] <= 'f') || (json[i] >= 'A' && json[i] <= 'F')))))
				{
					ns += json[i]; i++;
				}
				val.type = JsonValue::NUMBER;
				if (isHex) val.numVal = (int64_t)strtoull(ns.c_str(), nullptr, 16);
				else val.numVal = strtoll(ns.c_str(), nullptr, 10);
			}
			else
			{
				// Skip unknown
				while (i < json.size() && json[i] != ',' && json[i] != '}') i++;
			}

			result[key] = val;
		}

		return result;
	}

	static std::string getStr(const std::unordered_map<std::string, JsonValue>& m, const char* key, const char* def = "")
	{
		auto it = m.find(key);
		if (it != m.end() && it->second.type == JsonValue::STRING) return it->second.strVal;
		return def;
	}

	static int64_t getNum(const std::unordered_map<std::string, JsonValue>& m, const char* key, int64_t def = 0)
	{
		auto it = m.find(key);
		if (it != m.end() && it->second.type == JsonValue::NUMBER) return it->second.numVal;
		// Also try parsing string as hex
		if (it != m.end() && it->second.type == JsonValue::STRING)
		{
			const auto& s = it->second.strVal;
			if (s.size() > 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
				return (int64_t)strtoull(s.c_str() + 2, nullptr, 16);
			return strtoll(s.c_str(), nullptr, 10);
		}
		return def;
	}

	static bool getBool(const std::unordered_map<std::string, JsonValue>& m, const char* key, bool def = false)
	{
		auto it = m.find(key);
		if (it != m.end() && it->second.type == JsonValue::BOOL) return it->second.boolVal;
		return def;
	}

	// ============================================================
	// Get DebugInterface by CPU name
	// ============================================================
	static DebugInterface* getCpu(const std::string& name)
	{
		if (name == "iop" || name == "r3000" || name == "IOP")
			return &r3000Debug;
		return &r5900Debug; // default to EE
	}

	static BreakPointCpu getBpCpu(const std::string& name)
	{
		if (name == "iop" || name == "r3000" || name == "IOP")
			return BREAKPOINT_IOP;
		return BREAKPOINT_EE;
	}

	// ============================================================
	// Command Handlers
	// ============================================================

	static std::string encodeBase64(const std::vector<u8>& bytes)
	{
		static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		std::string result;
		result.reserve(((bytes.size() + 2) / 3) * 4);
		for (size_t i = 0; i < bytes.size(); i += 3)
		{
			const u32 value = (static_cast<u32>(bytes[i]) << 16) |
				((i + 1 < bytes.size()) ? (static_cast<u32>(bytes[i + 1]) << 8) : 0) |
				((i + 2 < bytes.size()) ? bytes[i + 2] : 0);
			result += alphabet[(value >> 18) & 63];
			result += alphabet[(value >> 12) & 63];
			result += (i + 1 < bytes.size()) ? alphabet[(value >> 6) & 63] : '=';
			result += (i + 2 < bytes.size()) ? alphabet[value & 63] : '=';
		}
		return result;
	}

	static std::string captureScreenshot(u32 requestedWidth, u32 requestedHeight)
	{
		struct Capture
		{
			std::mutex mutex;
			std::condition_variable ready;
			bool done = false;
			bool cancelled = false;
			bool success = false;
			u32 width = 0;
			u32 height = 0;
			std::vector<u32> pixels;
		};
		auto capture = std::make_shared<Capture>();
		// MTGS has a single producer: queue the capture from the CPU thread,
		// never from this TCP worker. Shared ownership also covers a late callback.
		Host::RunOnCPUThread([capture, requestedWidth, requestedHeight]() {
			{
				std::lock_guard lock(capture->mutex);
				if (capture->cancelled)
					return;
			}
			u32 width = 0, height = 0;
			std::vector<u32> pixels;
			bool success = false;
			const VMState state = VMManager::GetState();
			if ((state == VMState::Running || state == VMState::Paused) && MTGS::IsOpen())
			{
				success = MTGS::SaveMemorySnapshot(requestedWidth, requestedHeight, true, true,
					&width, &height, &pixels);
			}
			std::lock_guard lock(capture->mutex);
			if (capture->cancelled)
				return;
			capture->success = success;
			capture->width = width;
			capture->height = height;
			capture->pixels = std::move(pixels);
			capture->done = true;
			capture->ready.notify_one();
		});

		JsonBuilder j;
		j.startObject();
		std::unique_lock lock(capture->mutex);
		if (!capture->ready.wait_for(lock, std::chrono::seconds(5), [&capture]() { return capture->done; }))
		{
			capture->cancelled = true;
			j.kv("ok", false);
			j.kv("error", "Screenshot timed out waiting for CPU/GS threads");
		}
		else if (!capture->success || capture->width == 0 || capture->height == 0 ||
			capture->width > requestedWidth || capture->height > requestedHeight ||
			capture->pixels.size() != static_cast<size_t>(capture->width) * capture->height)
		{
			j.kv("ok", false);
			j.kv("error", "No rendered frame available. Boot a game and use an active graphics renderer.");
		}
		else
		{
			RGBA8Image image(capture->width, capture->height, std::move(capture->pixels));
			const auto png = image.SaveToBuffer("screenshot.png");
			if (!png || png->empty() || png->size() > 6 * 1024 * 1024)
			{
				j.kv("ok", false);
				j.kv("error", "Failed to encode screenshot within the 6 MiB PNG limit");
			}
			else
			{
				j.kv("ok", true);
				j.kv("width", static_cast<int64_t>(capture->width));
				j.kv("height", static_cast<int64_t>(capture->height));
				j.kv("mime_type", "image/png");
				j.kv("data", encodeBase64(*png));
			}
		}
		j.endObject();
		return j.str();
	}

	static std::string failure(const std::string& error)
	{
		JsonBuilder j; j.startObject(); j.kv("ok", false); j.kv("error", error); j.endObject();
		return j.str();
	}

	// Only short CPU operations belong here. A queued operation which hasn't
	// started by its deadline is cancelled, so a late callback cannot reset a VM.
	static std::string onCPU(std::function<std::string()> operation)
	{
		struct Work
		{
			std::atomic<int> state{0}; // queued, started, cancelled
			std::promise<std::string> result;
		};
		auto work = std::make_shared<Work>();
		auto result = work->result.get_future();
		Host::RunOnCPUThread([work, operation = std::move(operation)]() {
			int queued = 0;
			if (!work->state.compare_exchange_strong(queued, 1)) return;
			try { work->result.set_value(operation()); }
			catch (const std::exception& e) { work->result.set_value(failure(e.what())); }
		});
		if (result.wait_for(std::chrono::seconds(8)) != std::future_status::ready)
		{
			int queued = 0;
			const bool cancelled = work->state.compare_exchange_strong(queued, 2);
			return failure(cancelled ? "CPU operation timed out and was cancelled" :
				"CPU operation timed out after starting; query VM state before retrying");
		}
		return result.get();
	}

	static std::string readHistory(bool events, uint64_t after, size_t limit, int waitMs = 0)
	{
		std::unique_lock lock(s_historyMutex);
		auto& entries = events ? s_events : s_logs;
		if (events && waitMs > 0)
			s_eventReady.wait_for(lock, std::chrono::milliseconds(waitMs), [&]() {
				return !s_running.load() || (!entries.empty() && entries.back().sequence > after);
			});
		JsonBuilder j; j.startObject(); j.kv("ok", true);
		j.kv("session", s_session.load());
		j.kv("oldest_sequence", entries.empty() ? after + 1 : entries.front().sequence);
		j.kv("dropped", !entries.empty() && after < entries.front().sequence - 1);
		uint64_t cursor = after;
		j.key(events ? "events" : "logs"); j.startArray();
		for (const auto& entry : entries)
		{
			if (entry.sequence <= after) continue;
			if (limit-- == 0) break;
			j.startObject(); j.kv("sequence", entry.sequence); j.kv("timestamp_ms", entry.timestamp);
			if (events)
			{
				j.kv("type", entry.kind); j.kv("cpu", entry.cpu);
				j.key("pc"); j.valHex32(entry.pc); j.kv("detail", entry.detail);
			}
			else
			{
				j.kv("source", entry.kind); j.kv("level", entry.level);
				j.kv("message", entry.detail); j.kv("truncated", entry.truncated);
			}
			j.endObject(); cursor = entry.sequence;
		}
		j.endArray(); j.kv("next_cursor", cursor); j.endObject(); return j.str();
	}

	static std::string handleCommand(const std::string& jsonLine);
	static void finalizeException(uint64_t sequence);

	static std::string exceptionWatch(const std::unordered_map<std::string, JsonValue>& params, const std::string& cmd)
	{
		const auto id = getStr(params, "watch_id");
		if (id.size() != 32 || !std::all_of(id.begin(), id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }))
			return failure("Invalid exception watch ID");
		if (cmd == "exception_watch_start")
		{
#ifdef _WIN32
			const uint64_t process = GetCurrentProcessId();
#else
			const uint64_t process = getpid();
#endif
			if (s_step.active || s_operation.active) return failure("An execution operation is active; finish or cancel it before arming");
			if (s_exception.state == "armed" && steadyMillis() >= s_exception.deadline) s_exception.state = "expired";
			if (s_exception.state == "armed" || s_exception.state == "capturing") return failure("An exception watch is already active");
			if (!VMManager::HasValidVM() || VMManager::GetCurrentELF().empty()) return failure("Boot an EE ELF before arming an exception watch");
			if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
				getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
				getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
				getStr(params, "expected_elf") != VMManager::GetCurrentELF() || getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
				return failure("Exception watch VM/ELF identity changed");
			const auto mask = getNum(params, "exception_mask", 0), timeout = getNum(params, "timeout_ms", 30000);
			if (mask < 1 || mask > UINT32_MAX || timeout < 100 || timeout > 300000) return failure("Invalid exception mask or timeout (100-300000 ms)");
			s_exception = {}; s_exception.id = id; s_exception.sequence = ++s_exceptionSequence;
			s_exception.state = "armed"; s_exception.mask = static_cast<u32>(mask); s_exception.deadline = steadyMillis() + timeout;
			s_exception.session = s_session.load(); s_exception.epoch = s_executionEpoch;
			s_exception.elf = VMManager::GetCurrentELF(); s_exception.crc = VMManager::GetCurrentCRC();
			s_exception.screenshot = getBool(params, "screenshot", true);
			s_exceptionWatchId.store(s_exception.sequence); s_exceptionDeadline.store(s_exception.deadline);
		}
		else
		{
			if (s_exception.id != id) return failure("Unknown or superseded exception watch");
			if (cmd == "exception_watch_cancel" && s_exception.state == "capturing") finalizeException(s_exception.sequence);
			if (s_exception.state == "armed" && (cmd == "exception_watch_cancel" || steadyMillis() >= s_exception.deadline))
			{
				s_exception.state = cmd == "exception_watch_cancel" ? "cancelled" : "expired";
				s_exceptionDeadline.store(0);
			}
		}
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("watch_id", id); j.kv("state", s_exception.state);
		j.kv("active", s_exception.state == "armed" || s_exception.state == "capturing");
		j.kv("session", s_exception.session); j.kv("execution_epoch", s_exception.epoch);
		j.kv("elf", s_exception.elf); j.key("elf_crc"); j.valHex32(s_exception.crc);
		j.key("report"); if (s_exception.report.empty()) j.valJson("null"); else j.valJson(s_exception.report);
		j.endObject(); return j.str();
	}

	static std::string inspectEE(const std::unordered_map<std::string, JsonValue>& params)
	{
#ifdef _WIN32
		const uint64_t process = GetCurrentProcessId();
#else
		const uint64_t process = getpid();
#endif
		if (!VMManager::HasValidVM() || VMManager::GetState() != VMState::Paused || getStr(params, "cpu", "ee") != "ee")
			return failure("Variable inspection requires a paused EE VM");
		if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
			getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
			getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
			getStr(params, "expected_elf") != VMManager::GetCurrentELF() ||
			getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC()) return failure("Variable inspection VM/ELF identity changed");
		const auto revision = getNum(params, "expected_revision", -1);
		if (revision != -1 && (revision != static_cast<int64_t>(s_inspectionRevision) || getNum(params, "expected_pc", -1) != r5900Debug.getPC()))
			return failure("Paused inspection state changed; discard variable results");
		const int64_t address = getNum(params, "address", -1), length = getNum(params, "length", 0);
		if (length < 0 || length > 4096 || (length && (address < 0 || address > UINT32_MAX || static_cast<uint64_t>(address) + length > 0x100000000ULL)))
			return failure("Variable memory read must be 1-4096 bytes without wraparound");
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("revision", s_inspectionRevision);
		j.kv("execution_epoch", s_executionEpoch); j.key("pc"); j.valHex32(r5900Debug.getPC());
		j.key("gpr"); j.startArray(); for (int reg = 0; reg < 32; ++reg) j.valHex128(r5900Debug.getRegister(0, reg));
		j.endArray();
		if (length)
		{
			// Deliberately exclude MMIO/ROM/TLB aliases: inspection must not trigger device reads.
			const bool ram = static_cast<uint64_t>(address) + length <= 0x02000000ULL;
			bool valid = ram; std::string hex;
			if (ram) for (int64_t i = 0; i < length; ++i)
			{
				bool byteValid = false; const auto byte = r5900Debug.read8(static_cast<u32>(address + i), byteValid);
				if (!byteValid) { valid = false; break; }
				char encoded[3]; std::snprintf(encoded, sizeof(encoded), "%02x", byte); hex += encoded;
			}
			j.key("memory"); j.startObject(); j.key("address"); j.valHex32(static_cast<u32>(address));
			j.kv("length", length); j.kv("valid", valid);
			if (valid) j.kv("hex", hex);
			else j.kv("reason", ram ? "invalid_memory" : "unsupported_memory_region");
			j.endObject();
		}
		j.endObject(); return j.str();
	}

	static void finishGuardedStep(const char* reason)
	{
		if (!s_step.active) return;
		s_step.reason = reason;
		s_stepDeadline.store(0);
		if (s_step.owned && s_step.epoch == s_executionEpoch)
		{
			const auto points = CBreakPoints::GetBreakpoints(BREAKPOINT_EE, true);
			const auto count = std::count_if(points.begin(), points.end(), [](const BreakPoint& bp) { return bp.addr == s_step.target; });
			const auto own = std::find_if(points.begin(), points.end(), [](const BreakPoint& bp) {
				return bp.addr == s_step.target && bp.description == s_step.marker && bp.enabled && !bp.temporary && !bp.stepping && !bp.hasCond;
			});
			if (count == 1 && own != points.end()) CBreakPoints::RemoveBreakPoint(BREAKPOINT_EE, s_step.target);
			else if (count) s_step.cleanup = false; // Never remove a replacement/overlap.
		}
		else if (s_step.owned) s_step.cleanup = false;
		s_step.active = false;
	}

	static std::string guardedStepStatus()
	{
		if (s_step.active && VMManager::GetState() == VMState::Paused)
			finishGuardedStep(s_step.reason.empty() ? "paused" : s_step.reason.c_str());
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("operation_id", s_step.id);
		j.kv("active", s_step.active); j.kv("reason", s_step.reason); j.kv("cleanup_complete", s_step.cleanup);
		j.kv("execution_epoch", s_executionEpoch); j.kv("paused", VMManager::GetState() == VMState::Paused);
		j.key("old_pc"); j.valHex32(s_step.start); j.key("pc"); j.valHex32(r5900Debug.getPC());
		j.key("target"); j.valHex32(s_step.target); j.key("opcode"); j.valHex32(s_step.opcode);
		j.kv("instruction_units", s_step.units); j.kv("is_call", s_step.call); j.kv("is_return", s_step.ret);
		j.key("cause"); j.valHex32(cpuRegs.CP0.n.Cause); j.key("epc"); j.valHex32(cpuRegs.CP0.n.EPC);
		j.endObject(); return j.str();
	}

	static std::string startGuardedStep(const std::unordered_map<std::string, JsonValue>& params)
	{
#ifdef _WIN32
		const uint64_t process = GetCurrentProcessId();
#else
		const uint64_t process = getpid();
#endif
		if (s_step.active || s_operation.active) return failure("Another native execution operation is active");
		if (getStr(params, "cpu", "ee") != "ee" || !VMManager::HasValidVM() || VMManager::GetState() != VMState::Paused)
			return failure("Guarded instruction stepping requires a paused EE VM");
		if (!CHECK_EEREC) return failure("Guarded stepping requires the EE recompiler; the Release interpreter has no instruction breakpoint instrumentation");
		if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
			getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
			getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
			getStr(params, "expected_elf") != VMManager::GetCurrentELF() ||
			getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC() ||
			getNum(params, "expected_pc", -1) != r5900Debug.getPC()) return failure("VM/ELF/PC identity changed before guarded step");
		const auto timeout = getNum(params, "timeout_ms", 500);
		const auto budget = getNum(params, "instruction_budget", 2);
		if (timeout < 10 || timeout > 1000 || budget < 1 || budget > 2) return failure("Invalid guarded step timeout/budget");
		const u32 pc = r5900Debug.getPC();
		if ((pc & 3) || pc != standardizeBreakpointAddress(pc) || !r5900Debug.isValidAddress(pc)) return failure("EE PC must be aligned, valid and canonical");
		const auto info = MIPSAnalyst::GetOpcodeInfo(&r5900Debug, pc);
		// Do not guess exception/ERET successors or support branch-in-delay-slot code.
		if (info.isSyscall || info.encodedOpcode == 0x42000018) return failure("Syscall/ERET stepping is not supported; VM remains paused");
		bool taken = info.isBranch && (!info.isConditional || info.conditionMet);
		const u32 op = info.encodedOpcode >> 26;
		// Analyst treats comparisons of identical registers as unconditional, including BNE.
		if ((op == 5 || op == 21) && ((info.encodedOpcode >> 21) & 31) == ((info.encodedOpcode >> 16) & 31)) taken = false;
		const u32 units = info.isBranch && !(info.isLikelyBranch && !taken) ? 2 : 1;
		if (budget < units) return failure("Insufficient instruction budget for branch plus delay slot");
		const u32 target = info.isBranch ? (taken ? info.branchTarget : pc + 8) : pc + 4;
		if ((target & 3) || target != standardizeBreakpointAddress(target) || !r5900Debug.isValidAddress(target)) return failure("Invalid guarded step successor");
		if (info.isBranch)
		{
			const auto delay = MIPSAnalyst::GetOpcodeInfo(&r5900Debug, pc + 4);
			if (!r5900Debug.isValidAddress(pc + 4) || delay.isBranch || delay.isSyscall || delay.encodedOpcode == 0x42000018)
				return failure("Unsupported branch/delay-slot instruction; VM remains paused");
		}
		const auto points = CBreakPoints::GetBreakpoints(BREAKPOINT_EE, true);
		for (const auto& bp : points)
			if (bp.addr == target || (info.isBranch && bp.addr == pc + 4))
				return failure("Existing breakpoint at successor/delay slot; VM remains paused and breakpoint is preserved");
		s_step = {}; s_step.id = ++s_stepSequence; s_step.epoch = s_executionEpoch;
		s_step.start = pc; s_step.target = target; s_step.opcode = info.encodedOpcode; s_step.units = units;
		s_step.call = taken && info.isLinkedBranch;
		s_step.ret = info.encodedOpcode == 0x03e00008; // Physical JR $ra only; no heuristic unwinding.
		s_step.marker = "MCP guarded step " + std::to_string(s_step.id);
		// Ordinary private breakpoint: Qt may clear ALL temporary breakpoints when pausing.
		CBreakPoints::AddBreakPoint(BREAKPOINT_EE, target, false, true, false);
		CBreakPoints::ChangeBreakPointDescription(BREAKPOINT_EE, target, s_step.marker);
		s_step.active = s_step.owned = true;
		// Skip only an actual execute breakpoint at the starting PC. Setting this
		// unconditionally also suppresses a memory watchpoint on that instruction.
		CBreakPoints::SetSkipFirst(BREAKPOINT_EE, target == pc || std::any_of(points.begin(), points.end(), [pc](const BreakPoint& bp) {
			return bp.addr == pc && bp.enabled;
		}) ? pc : 0);
		s_stepWatchId.store(s_step.id);
		s_stepDeadline.store(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count() + timeout);
		VMManager::SetPaused(false);
		return guardedStepStatus();
	}

	struct SourceBreakpointGroup
	{
		uint64_t session;
		std::string elf;
		u32 crc;
		std::vector<u32> addresses, relinquished;
	};
	// CPU-thread only. Descriptions plus explicit legacy-command invalidation guard ownership.
	static std::unordered_map<std::string, SourceBreakpointGroup> s_sourceGroups;
	static void relinquishSourceBreakpoint(BreakPointCpu cpu, u32 address)
	{
		if (cpu != BREAKPOINT_EE) return;
		address = standardizeBreakpointAddress(address);
		for (auto& [id, group] : s_sourceGroups)
			if (std::find(group.addresses.begin(), group.addresses.end(), address) != group.addresses.end() &&
				std::find(group.relinquished.begin(), group.relinquished.end(), address) == group.relinquished.end())
				group.relinquished.push_back(address);
	}

	static std::string sourceBreakpoints(const std::unordered_map<std::string, JsonValue>& params, bool install)
	{
		if (getStr(params, "cpu", "ee") != "ee") return failure("Source breakpoint groups support EE only");
		if (!VMManager::HasValidVM() || VMManager::GetState() != VMState::Paused)
			return failure("Pause the active VM before changing source breakpoint groups");
		const auto id = getStr(params, "group_id");
		if (id.size() != 32 || !std::all_of(id.begin(), id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }))
			return failure("Invalid source breakpoint group ID");
		const std::string marker = "MCP source group " + id;
		if (!install)
		{
			const auto found = s_sourceGroups.find(id);
			if (found == s_sourceGroups.end()) return failure("Unknown source breakpoint group");
			const auto& group = found->second;
			if (group.session != s_session.load() || group.elf != VMManager::GetCurrentELF() || group.crc != VMManager::GetCurrentCRC())
				return failure("VM/ELF identity changed; source breakpoints were not removed");
			const auto current = CBreakPoints::GetBreakpoints(BREAKPOINT_EE, true);
			std::vector<u32> removed, preserved;
			for (u32 address : group.addresses)
			{
				const auto bp = std::find_if(current.begin(), current.end(), [address](const BreakPoint& value) { return value.addr == address; });
				if (bp == current.end()) continue;
				if (std::find(group.relinquished.begin(), group.relinquished.end(), address) != group.relinquished.end() ||
					bp->description != marker || !bp->enabled || bp->temporary || bp->stepping || bp->hasCond)
				{ preserved.push_back(address); continue; }
				CBreakPoints::RemoveBreakPoint(BREAKPOINT_EE, address); removed.push_back(address);
			}
			s_sourceGroups.erase(found);
			JsonBuilder result; result.startObject(); result.kv("ok", true); result.kv("group_id", id);
			result.kv("complete", preserved.empty()); result.key("removed_addresses"); result.startArray();
			for (u32 address : removed) result.valHex32(address);
			result.endArray(); result.key("preserved_addresses"); result.startArray();
			for (u32 address : preserved) result.valHex32(address);
			result.endArray(); result.endObject(); return result.str();
		}
#ifdef _WIN32
		const uint64_t process = GetCurrentProcessId();
#else
		const uint64_t process = getpid();
#endif
		if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
			getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
			getStr(params, "expected_elf") != VMManager::GetCurrentELF() ||
			getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
			return failure("VM/ELF identity changed; source breakpoints were not installed");
		if (s_sourceGroups.size() >= 256 || s_sourceGroups.contains(id)) return failure("Source breakpoint group limit reached or ID already exists");
		const auto encoded = getStr(params, "addresses");
		if (encoded.empty() || encoded.size() > 703 || encoded.back() == ',') return failure("Expected 1-64 canonical hexadecimal addresses");
		std::vector<u32> addresses;
		std::istringstream stream(encoded); std::string item;
		while (std::getline(stream, item, ','))
		{
			if (item.size() != 10 || item.substr(0, 2) != "0x" || !std::all_of(item.begin() + 2, item.end(), [](char c) {
				return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }))
				return failure("Malformed source breakpoint address");
			const u32 address = static_cast<u32>(std::strtoul(item.c_str() + 2, nullptr, 16));
			if ((address & 3) || address != standardizeBreakpointAddress(address) || !r5900Debug.isValidAddress(address))
				return failure("Source breakpoint address must be valid, aligned and canonical");
			if (std::find(addresses.begin(), addresses.end(), address) != addresses.end()) return failure("Duplicate source breakpoint address");
			addresses.push_back(address);
			if (addresses.size() > 64) return failure("Source breakpoint address limit exceeded");
		}
		for (const auto& bp : CBreakPoints::GetBreakpoints(BREAKPOINT_EE, true))
			if (std::find(addresses.begin(), addresses.end(), bp.addr) != addresses.end())
				return failure("An existing breakpoint occupies a source target; no breakpoints changed");
		// Validation and installation share one CPU-thread operation, so ELF reset cannot interleave.
		for (u32 address : addresses)
		{
			CBreakPoints::AddBreakPoint(BREAKPOINT_EE, address, false, true);
			CBreakPoints::ChangeBreakPointDescription(BREAKPOINT_EE, address, marker);
		}
		s_sourceGroups.emplace(id, SourceBreakpointGroup{s_session.load(), VMManager::GetCurrentELF(), VMManager::GetCurrentCRC(), addresses, {}});
		JsonBuilder result; result.startObject(); result.kv("ok", true); result.kv("group_id", id);
		result.kv("session", s_session.load()); result.kv("elf", VMManager::GetCurrentELF());
		result.key("elf_crc"); result.valHex32(VMManager::GetCurrentCRC()); result.key("addresses"); result.startArray();
		for (u32 address : addresses) result.valHex32(address);
		result.endArray(); result.endObject(); return result.str();
	}

	static void appendSymbol(JsonBuilder& j, const ccc::Symbol& symbol, const char* kind, const std::string& source)
	{
		j.startObject(); j.kv("name", symbol.name()); j.kv("kind", kind);
		j.key("address"); j.valHex32(symbol.address().value); j.kv("size", symbol.size());
		j.kv("source_file", source); j.endObject();
	}

	static std::string lookupSymbols(DebugInterface* cpu, const std::unordered_map<std::string, JsonValue>& params)
	{
		const auto query = getStr(params, "query"), kind = getStr(params, "kind", "all");
		const int64_t offset = getNum(params, "offset", 0), limit = getNum(params, "limit", 50);
		const bool exact = getBool(params, "exact", false);
		if (query.size() > 256 || offset < 0 || offset > 1000000 || limit < 1 || limit > 100 ||
			(kind != "all" && kind != "function" && kind != "global")) return failure("Invalid symbol filter or pagination");
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("session", s_session.load());
		j.kv("elf", VMManager::GetCurrentELF()); j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC());
		j.key("symbols"); j.startArray();
		uint64_t matches = 0, returned = 0;
		cpu->GetSymbolGuardian().Read([&](const ccc::SymbolDatabase& database) {
			auto visit = [&](const auto& symbols, const char* symbolKind) {
				for (const auto& symbol : symbols)
				{
					if (!symbol.address().valid() || (exact ? symbol.name() != query : symbol.name().find(query) == std::string::npos)) continue;
					if (matches++ < static_cast<uint64_t>(offset) || returned >= static_cast<uint64_t>(limit)) continue;
					const auto* file = database.source_files.symbol_from_handle(symbol.source_file());
					appendSymbol(j, symbol, symbolKind, file ? (file->command_line_path.empty() ? file->name() : file->command_line_path) : "");
					++returned;
				}
			};
			if (kind != "global") visit(database.functions, "function");
			if (kind != "function") visit(database.global_variables, "global");
		});
		j.endArray(); j.kv("total_matches", matches); j.kv("next_offset", static_cast<uint64_t>(offset) + returned);
		j.kv("has_more", static_cast<uint64_t>(offset) + returned < matches); j.endObject(); return j.str();
	}

	static std::string resolveAddress(DebugInterface* cpu, u32 address)
	{
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.key("address"); j.valHex32(address);
		j.kv("session", s_session.load()); j.kv("elf", VMManager::GetCurrentELF());
		j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC());
		j.key("symbols"); j.startArray();
		cpu->GetSymbolGuardian().Read([&](const ccc::SymbolDatabase& database) {
			size_t count = 0;
			auto visit = [&](const auto& symbols, const char* kind) {
				for (const auto& symbol : symbols)
				{
					if (!symbol.address().valid() || address < symbol.address().value) continue;
					const u32 delta = address - symbol.address().value;
					if (symbol.size() ? delta >= symbol.size() : delta != 0) continue;
					const auto* file = database.source_files.symbol_from_handle(symbol.source_file());
					appendSymbol(j, symbol, kind, file ? (file->command_line_path.empty() ? file->name() : file->command_line_path) : "");
					if (++count >= 100) break;
				}
			};
			visit(database.functions, "function");
			if (count < 100) visit(database.global_variables, "global");
		});
		j.endArray(); j.endObject(); return j.str();
	}

	static void restoreController()
	{
		if (!s_operation.input) return;
		auto* pad = Pad::GetPad(s_operation.controller);
		if (pad == s_operation.savedPad && pad && pad->GetType() == Pad::ControllerType::DualShock2)
		{
			for (u32 i = 0; i < 16; ++i)
				pad->SetRawPressureButton(i, {!(s_operation.savedButtons & (1u << s_buttonBits[i])), s_operation.savedPressures[i]});
			pad->SetRawAnalogs(s_operation.savedLeft, s_operation.savedRight);
		}
	}

	static void finishOperation(const char* reason)
	{
		if (!s_operation.active) return;
		s_operation.active = false;
		s_operation.reason = reason;
		s_operation.end = s_videoFrame;
		VMManager::CancelFrameAdvance();
		restoreController();
		recordEvent(std::strcmp(reason, "completed") == 0 ? "automation_completed" : "automation_interrupted",
			"ee", r5900Debug.getPC(), reason);
	}

	static std::string operationStatus()
	{
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("session", s_session.load());
		j.kv("operation_id", s_operation.id); j.kv("active", s_operation.active);
		j.kv("start_frame", s_operation.start); j.kv("target_frame", s_operation.target);
		j.kv("current_frame", s_videoFrame); j.kv("reason", s_operation.reason);
		j.kv("frames_advanced", (s_operation.active ? s_videoFrame : s_operation.end) - s_operation.start);
		j.kv("paused", VMManager::GetState() == VMState::Paused); j.endObject(); return j.str();
	}

	static std::string startFrames(const std::unordered_map<std::string, JsonValue>& params, bool input)
	{
		const int64_t frames = getNum(params, "frames", 1);
		if (frames < 1 || frames > 600) return failure("frames must be 1-600");
		if (s_operation.active) return failure("Another frame/input operation is active");
		if (VMManager::GetState() != VMState::Paused) return failure("Pause the VM before frame/input automation");
		if (Achievements::IsHardcoreModeActive()) return failure("Frame automation is unavailable in hardcore mode");
		if (g_InputRecording.isActive()) return failure("Stop input recording/playback before frame automation");
		FrameOperation operation;
		if (input)
		{
			const int64_t controller = getNum(params, "controller", 0), buttons = getNum(params, "buttons", 0);
			if (controller < 0 || controller > 1 || buttons < 0 || buttons > 65535)
				return failure("controller must be 0-1 and buttons must be a 16-bit mask");
			operation.controller = static_cast<u8>(controller);
			auto* pad = Pad::GetPad(operation.controller);
			if (!pad || pad->GetType() != Pad::ControllerType::DualShock2)
				return failure("Selected controller must be configured as DualShock2");
			const char* axisNames[] = {"left_x", "left_y", "right_x", "right_y"};
			for (size_t i = 0; i < 4; ++i)
			{
				const int64_t value = getNum(params, axisNames[i], 127);
				if (value < 0 || value > 255) return failure("Analog coordinates must be 0-255 (127 neutral)");
				operation.axes[i] = static_cast<u8>(value);
			}
			operation.input = true; operation.buttons = static_cast<u32>(buttons); operation.savedPad = pad;
			operation.savedButtons = pad->GetButtons();
			for (u32 i = 0; i < 16; ++i) operation.savedPressures[i] = pad->GetRawInput(i);
			operation.savedLeft = pad->GetRawLeftAnalog(); operation.savedRight = pad->GetRawRightAnalog();
		}
		operation.id = ++s_operationSequence; operation.start = s_videoFrame;
		operation.target = s_videoFrame + static_cast<uint64_t>(frames); operation.active = true;
		operation.deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
		s_operation = std::move(operation);
		OnInputPoll();
		VMManager::FrameAdvance(static_cast<u32>(frames));
		return operationStatus();
	}

	static std::string captureContext(const std::unordered_map<std::string, JsonValue>& params)
	{
		const std::string cpuName = getStr(params, "cpu", "ee");
		const int64_t width = getNum(params, "width", 640), height = getNum(params, "height", 480);
		const int64_t length = getNum(params, "memory_length", 0);
		if (width < 1 || width > 1280 || height < 1 || height > 1024 || length < 0 || length > 4096)
			return failure("Invalid context dimensions or memory length (maximum 4096)");
		const auto state = VMManager::GetState();
		if (state != VMState::Running && state != VMState::Paused) return failure("No active VM");
		const bool wasRunning = state == VMState::Running;
		if (wasRunning) VMManager::SetPaused(true);
		struct Restore
		{
			bool running;
			~Restore() { if (running && VMManager::GetState() == VMState::Paused) VMManager::SetPaused(false); }
		} restore{wasRunning};

		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("timestamp_ms", timestampMillis());
		j.kv("session", s_session.load()); j.kv("cpu", cpuName); j.kv("was_running", wasRunning);
		j.kv("elf", VMManager::GetCurrentELF()); j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC());
		for (const char* cmd : {"status", "read_registers", "get_backtrace"})
		{
			j.key(cmd);
			j.valJson(handleCommand(std::string("{\"cmd\":\"") + cmd + "\",\"cpu\":\"" + cpuName + "\"}"));
		}
		if (length > 0)
		{
			const u32 address = static_cast<u32>(getNum(params, "memory_address"));
			j.key("memory");
			j.valJson(handleCommand("{\"cmd\":\"read_memory\",\"cpu\":\"" + cpuName +
				"\",\"address\":" + std::to_string(address) + ",\"length\":" + std::to_string(length) + "}"));
		}
		uint64_t after;
		{ std::lock_guard lock(s_historyMutex); after = s_logSequence > 100 ? s_logSequence - 100 : 0; }
		j.key("recent_logs"); j.valJson(readHistory(false, after, 100));
		j.key("screenshot");
		u32 actualWidth = 0, actualHeight = 0;
		std::vector<u32> pixels;
		if (getBool(params, "skip_screenshot", false)) j.valJson(failure("Screenshot disabled for this capture"));
		else if (MTGS::IsOpen() && MTGS::SaveMemorySnapshot(static_cast<u32>(width), static_cast<u32>(height),
			true, true, &actualWidth, &actualHeight, &pixels) && actualWidth && actualHeight &&
			actualWidth <= width && actualHeight <= height && pixels.size() == static_cast<size_t>(actualWidth) * actualHeight)
		{
			RGBA8Image image(actualWidth, actualHeight, std::move(pixels));
			const auto png = image.SaveToBuffer("context.png");
			if (png && !png->empty() && png->size() <= 6 * 1024 * 1024)
			{
				j.startObject(); j.kv("ok", true); j.kv("width", actualWidth); j.kv("height", actualHeight);
				j.kv("mime_type", "image/png"); j.kv("data", encodeBase64(*png)); j.endObject();
			}
			else j.valJson(failure("Could not encode context screenshot within 6 MiB"));
		}
		else j.valJson(failure("No rendered frame available"));
		j.endObject(); return j.str();
	}

	static void exceptionMemory(JsonBuilder& j, u32 address, u32 length)
	{
		j.startObject(); j.key("address"); j.valHex32(address); j.kv("length", length);
		bool valid = static_cast<uint64_t>(address) + length <= 0x02000000ULL;
		std::string hex;
		if (valid) for (u32 i = 0; i < length; ++i)
		{
			bool readable = false; const auto value = r5900Debug.read8(address + i, readable);
			if (!readable) { valid = false; break; }
			char encoded[3]; std::snprintf(encoded, sizeof(encoded), "%02x", value); hex += encoded;
		}
		j.kv("valid", valid); if (valid) j.kv("hex", hex); else j.kv("reason", "unavailable_or_excluded_RAM");
		j.endObject();
	}

	static void finalizeException(uint64_t sequence)
	{
		if (s_exception.sequence != sequence || s_exception.state != "capturing") return;
		s_exceptionPending.store(0);
		bool matches = VMManager::GetState() == VMState::Paused && s_exception.session == s_session.load() &&
			s_exception.epoch == s_executionEpoch && s_exception.elf == VMManager::GetCurrentELF() &&
			s_exception.crc == VMManager::GetCurrentCRC() && s_exception.revision == s_inspectionRevision && s_exception.postPC == r5900Debug.getPC();
		for (int i = 0; matches && i < 32; ++i)
			matches = std::memcmp(&s_exception.gpr[i], &cpuRegs.GPR.r[i], sizeof(u128)) == 0;
		JsonBuilder j; j.startObject(); j.kv("watch_id", s_exception.id); j.kv("cpu", "ee");
		j.kv("timestamp_ms", s_exception.timestamp); j.kv("session", s_exception.session); j.kv("execution_epoch", s_exception.epoch);
		j.kv("elf", s_exception.elf); j.key("elf_crc"); j.valHex32(s_exception.crc); j.kv("context_matches_stop", matches);
		j.kv("screenshot_requested", s_exception.screenshot);
		j.key("core"); j.startObject(); j.key("exception_pc"); j.valHex32(s_exception.exceptionPC);
		j.key("post_exception_pc"); j.valHex32(s_exception.postPC); j.key("raw_code"); j.valHex32(s_exception.code);
		j.kv("exception_code", (s_exception.code >> 2) & 31); j.kv("requested_branch_delay", s_exception.branchDelay);
		j.kv("previous_exl", s_exception.nested);
		for (const auto [name, reg] : {std::pair{"cause", 13}, {"epc", 14}, {"bad_vaddr", 8}, {"status", 12}})
		{ j.key(name); j.valHex32(s_exception.cp0[reg]); }
		j.kv("bad_vaddr_relevant", ((s_exception.code >> 2) & 31) >= 1 && ((s_exception.code >> 2) & 31) <= 5);
		j.key("instruction");
		if (s_exception.instruction.active)
		{
			j.startObject(); j.kv("source", "ee_recompiler_break");
			j.key("pc"); j.valHex32(s_exception.instruction.pc);
			j.key("opcode"); j.valHex32(s_exception.instruction.opcode);
			j.kv("branch_delay", s_exception.instruction.branchDelay);
			j.kv("opcode_matches_memory", s_exception.instruction.opcodeMatchesMemory); j.endObject();
		}
		else j.valJson("null");
		j.key("gpr"); j.startArray(); for (const auto& reg : s_exception.gpr) j.valHex128(reg); j.endArray();
		j.key("cp0"); j.startArray(); for (u32 reg : s_exception.cp0) j.valHex32(reg); j.endArray(); j.endObject();
		const std::string corePrefix = j.str();
		j.key("memory"); j.startObject();
		if (matches)
		{
			j.key("code"); exceptionMemory(j, s_exception.exceptionPC >= 16 ? s_exception.exceptionPC - 16 : s_exception.exceptionPC, 64);
			j.key("stack"); exceptionMemory(j, s_exception.gpr[29]._u32[0], 256);
		}
		j.endObject();
		j.key("events");
		uint64_t after; { std::lock_guard lock(s_historyMutex); after = s_eventSequence > 32 ? s_eventSequence - 32 : 0; }
		j.valJson(readHistory(true, after, 32));
		j.key("context");
		if (matches)
		{
			finishGuardedStep("exception");
			auto params = parseJsonObject("{\"cpu\":\"ee\",\"width\":640,\"height\":480,\"memory_length\":0}");
			params["skip_screenshot"].type = JsonValue::BOOL; params["skip_screenshot"].boolVal = !s_exception.screenshot;
			j.valJson(captureContext(params));
		}
		else j.valJson(failure("Paused state changed before deferred capture; only exception core is retained"));
		j.endObject(); s_exception.report = j.str();
		if (s_exception.report.size() > 3 * 1024 * 1024)
			s_exception.report = corePrefix + ",\"memory\":{},\"context\":" + failure("Extended capture exceeded 3 MiB limit; exception core retained") + "}";
		s_exception.state = "captured";
	}

	static std::string handleCommand(const std::string& jsonLine)
	{
		auto params = parseJsonObject(jsonLine);
		std::string cmd = getStr(params, "cmd");
		if (cmd == "exception_watch_start" || cmd == "exception_watch_status" || cmd == "exception_watch_cancel") return exceptionWatch(params, cmd);
		if (cmd == "guarded_step") return startGuardedStep(params);
		if (cmd == "guarded_step_status" || cmd == "guarded_step_cancel")
		{
			if (!s_step.id || getNum(params, "operation_id", -1) != static_cast<int64_t>(s_step.id)) return failure("Unknown guarded step operation");
			if (cmd == "guarded_step_cancel" && s_step.active)
			{
				VMManager::SetPaused(true); finishGuardedStep("cancelled");
			}
			return guardedStepStatus();
		}
		if (s_step.active && cmd != "status" && cmd != "capabilities" && cmd != "read_events" && cmd != "read_logs")
			return failure("A guarded instruction operation owns execution; poll or cancel it first");
		if (cmd == "inspect_ee") return inspectEE(params);
		if (cmd == "write_register" || cmd == "write_memory" || cmd == "set_pc") ++s_inspectionRevision;
		std::string cpuName = getStr(params, "cpu", "ee");
		DebugInterface* cpu = getCpu(cpuName);
		if (cpuName != "ee" && cpuName != "iop") return failure("cpu must be ee or iop");
		if (cmd == "lookup_symbols") return lookupSymbols(cpu, params);
		if (cmd == "install_source_breakpoints" || cmd == "remove_source_breakpoints")
			return sourceBreakpoints(params, cmd == "install_source_breakpoints");
		if (cmd == "import_symbols")
		{
			auto* importer = cpu->GetSymbolImporter();
			if (!importer) return failure("Explicit ELF symbol import is available for EE only");
			if (!VMManager::HasValidVM() || VMManager::GetCurrentELF().empty()) return failure("Boot an ELF before importing symbols");
			auto options = EmuConfig.DebuggerAnalysis;
			options.ImportSymbolsFromELF = true;
			options.FunctionScanMode = DebugFunctionScanMode::SKIP;
			options.GenerateFunctionHashes = false;
			importer->LoadAndAnalyseElf(std::move(options));
			JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("requested", true);
			j.kv("session", s_session.load()); j.kv("elf", VMManager::GetCurrentELF());
			j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC()); j.endObject(); return j.str();
		}
		if (cmd == "resolve_address")
		{
			const int64_t address = getNum(params, "address", -1);
			if (address < 0 || address > UINT32_MAX) return failure("Address must be an unsigned 32-bit value");
			return resolveAddress(cpu, static_cast<u32>(address));
		}
		if (cmd == "breakpoint_symbol")
		{
			const std::string name = getStr(params, "name");
			if (name.empty() || name.size() > 256) return failure("Function name must be 1-256 bytes");
			std::vector<u32> addresses;
			cpu->GetSymbolGuardian().Read([&](const ccc::SymbolDatabase& database) {
				for (const auto& function : database.functions)
					if (function.address().valid() && function.name() == name &&
						std::find(addresses.begin(), addresses.end(), function.address().value) == addresses.end())
						addresses.push_back(function.address().value);
			});
			if (addresses.empty()) return failure("Function symbol not found");
			if (addresses.size() != 1) return failure("Function name is ambiguous; select an explicit address");
			const u32 address = addresses.front();
			if ((address & 3) || !cpu->isValidAddress(address)) return failure("Function address is not executable/aligned in this CPU memory");
			JsonBuilder request; request.startObject(); request.kv("cmd", "set_breakpoint");
			request.kv("cpu", cpuName); request.key("address"); request.valHex32(address);
			request.kv("temporary", getBool(params, "temporary", false)); request.endObject();
			const auto response = handleCommand(request.str());
			if (!getBool(parseJsonObject(response), "ok", false)) return response;
			JsonBuilder result; result.startObject(); result.kv("ok", true); result.kv("name", name);
			result.key("address"); result.valHex32(address); result.kv("session", s_session.load());
			result.kv("elf", VMManager::GetCurrentELF()); result.key("elf_crc"); result.valHex32(VMManager::GetCurrentCRC());
			result.endObject(); return result.str();
		}
		// These commands are already marshalled by executeCommand().
		if (cmd == "frame_advance" || cmd == "input_frames") return startFrames(params, cmd == "input_frames");
		if (cmd == "automation_status" || cmd == "automation_cancel")
		{
			if (getNum(params, "operation_id", -1) != static_cast<int64_t>(s_operation.id) || s_operation.id == 0)
				return failure("Unknown or superseded automation operation");
			if (cmd == "automation_cancel" && s_operation.active)
			{
				finishOperation("cancelled");
				VMManager::SetPaused(true);
			}
			return operationStatus();
		}
		if (cmd == "controller_state")
		{
			const int64_t controller = getNum(params, "controller", 0);
			if (controller < 0 || controller > 1) return failure("controller must be 0-1");
			auto* pad = Pad::GetPad(static_cast<u8>(controller));
			if (!pad || pad->GetType() != Pad::ControllerType::DualShock2) return failure("Selected controller is not DualShock2");
			u32 pressed = 0;
			for (u32 i = 0; i < 16; ++i) if (!(pad->GetButtons() & (1u << s_buttonBits[i]))) pressed |= 1u << i;
			JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("controller", static_cast<int>(controller));
			j.kv("pressed_mask", pressed);
			const auto [lx, ly] = pad->GetRawLeftAnalog(); const auto [rx, ry] = pad->GetRawRightAnalog();
			j.kv("left_x", lx); j.kv("left_y", ly); j.kv("right_x", rx); j.kv("right_y", ry);
			j.endObject(); return j.str();
		}

		if (cmd == "read_events" || cmd == "read_logs")
		{
			const int64_t after = getNum(params, "after", 0), limit = getNum(params, "limit", 100);
			const int64_t wait = getNum(params, "wait_ms", 0);
			if (after < 0 || limit < 1 || limit > 200 || wait < 0 || wait > 1000)
				return failure("Invalid history cursor, limit (1-200), or wait_ms (0-1000)");
			return readHistory(cmd == "read_events", static_cast<uint64_t>(after), static_cast<size_t>(limit), static_cast<int>(wait));
		}
		if (cmd == "capture_context") return onCPU([params]() { return captureContext(params); });
		if (cmd == "capabilities")
		{
			return onCPU([]() {
				JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("protocol_version", 2);
#ifdef _WIN32
				j.kv("process_id", static_cast<uint64_t>(GetCurrentProcessId()));
#else
				j.kv("process_id", static_cast<uint64_t>(getpid()));
#endif
				j.kv("session", s_session.load()); j.kv("elf", VMManager::GetCurrentELF());
				j.kv("execution_epoch", s_executionEpoch);
				j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC());
				j.key("features"); j.startArray();
				for (const char* feature : {"screenshot", "events", "console_logs", "capture_context", "load_elf", "frame_advance", "input_frames", "controller_state", "symbols", "source_breakpoints", "guarded_step", "variable_inspection", "ee_exception_watch", "ee_break_provenance"}) j.valStr(feature);
				j.endArray(); j.endObject(); return j.str();
			});
		}
		if (cmd == "load_elf")
		{
			const std::string filename = getStr(params, "path");
			if (filename.empty() || filename.size() > 4096) return failure("ELF path is required (maximum 4096 bytes)");
			return onCPU([filename]() {
				if (!VMManager::HasValidVM()) return failure("Start a VM before loading an ELF");
				if (!VMManager::IsElfFileName(filename) || !FileSystem::FileExists(filename.c_str()))
					return failure("ELF file does not exist on the emulator host, or has an unsupported extension");
				const auto file = FileSystem::OpenManagedCFile(filename.c_str(), "rb");
				unsigned char header[52] = {};
				if (!file || std::fread(header, 1, sizeof(header), file.get()) != sizeof(header) ||
					std::memcmp(header, "\x7f" "ELF", 4) != 0 || header[4] != 1 || header[5] != 1 ||
					header[18] != 8 || header[19] != 0)
					return failure("Expected a readable 32-bit little-endian MIPS ELF; VM was not reset");
				if (!VMManager::SetELFOverride(filename)) return failure("PCSX2 rejected the ELF override");
				recordEvent("elf_load_requested", "ee", 0, filename);
				JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("path", filename);
				j.kv("reset_requested", true); j.endObject(); return j.str();
			});
		}

		JsonBuilder j;

		if (cmd == "screenshot")
		{
			const int64_t width = getNum(params, "width", 640);
			const int64_t height = getNum(params, "height", 480);
			if (width < 1 || width > 1280 || height < 1 || height > 1024)
			{
				j.startObject();
				j.kv("ok", false);
				j.kv("error", "Screenshot width must be 1-1280 and height 1-1024");
				j.endObject();
				return j.str();
			}
			return captureScreenshot(static_cast<u32>(width), static_cast<u32>(height));
		}

		// ----- STATUS -----
		if (cmd == "status")
		{
			j.startObject();
			j.kv("ok", true);
			j.key("data"); j.startObject();
			j.kv("alive", cpu->isAlive());
			j.kv("paused", cpu->isCpuPaused());
			j.key("pc"); j.valHex32(cpu->getPC());
			j.kv("cycles", (int64_t)cpu->getCycles());
			j.endObject();
			j.endObject();
		}
		// ----- READ REGISTERS (ALL) -----
		else if (cmd == "read_registers")
		{
			int cat = (int)getNum(params, "category", -1);
			j.startObject();
			j.kv("ok", true);
			j.key("data"); j.startObject();

			int catStart = (cat >= 0) ? cat : 0;
			int catEnd = (cat >= 0) ? cat + 1 : cpu->getRegisterCategoryCount();

			for (int c = catStart; c < catEnd; c++)
			{
				j.key(cpu->getRegisterCategoryName(c));
				j.startObject();
				j.kv("size", cpu->getRegisterSize(c));
				j.kv("count", cpu->getRegisterCount(c));
				j.key("regs"); j.startArray();
				for (int r = 0; r < cpu->getRegisterCount(c); r++)
				{
					j.startObject();
					j.kv("name", cpu->getRegisterName(c, r));
					j.key("value"); j.valHex128(cpu->getRegister(c, r));
					j.kv("display", cpu->getRegisterString(c, r));
					j.endObject();
				}
				j.endArray();
				j.endObject();
			}

			j.key("pc"); j.valHex32(cpu->getPC());
			j.key("hi"); j.valHex128(cpu->getHI());
			j.key("lo"); j.valHex128(cpu->getLO());
			j.endObject();
			j.endObject();
		}
		// ----- WRITE REGISTER -----
		else if (cmd == "write_register")
		{
			int cat = (int)getNum(params, "category", 0);
			int num = (int)getNum(params, "index", 0);
			// Value can be a hex string or number
			std::string valStr = getStr(params, "value", "0");
			u128 newVal = {};
			// Parse hex string (up to 128-bit)
			if (valStr.size() > 2 && valStr[0] == '0' && (valStr[1] == 'x' || valStr[1] == 'X'))
				valStr = valStr.substr(2);
			// Pad to 32 hex chars (128 bits)
			while (valStr.size() < 32) valStr = "0" + valStr;
			for (int i = 0; i < 4; i++)
			{
				std::string part = valStr.substr(24 - i * 8, 8);
				newVal._u32[i] = (uint32_t)strtoul(part.c_str(), nullptr, 16);
			}
			cpu->setRegister(cat, num, newVal);

			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- SET PC -----
		else if (cmd == "set_pc")
		{
			u32 pc = (u32)getNum(params, "value", 0);
			cpu->setPc(pc);
			j.startObject();
			j.kv("ok", true);
			j.key("pc"); j.valHex32(pc);
			j.endObject();
		}
		// ----- READ MEMORY -----
		else if (cmd == "read_memory")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			int len = (int)getNum(params, "length", 256);
			if (len > 65536) len = 65536;
			const bool strict = getBool(params, "strict", false);
			if (strict && (len < 1 || len > 4096 || static_cast<uint64_t>(addr) + len > 0x100000000ULL))
				return failure("Strict memory reads require 1-4096 bytes without address wraparound");

			j.startObject();
			j.kv("ok", true);
			j.key("address"); j.valHex32(addr);
			j.kv("length", (int64_t)len);

			// Hex string output
			j.key("hex");
			std::string hexStr;
			hexStr.reserve(len * 2);
			int invalidBytes = 0;
			for (int i = 0; i < len; i++)
			{
				bool valid = true;
				u32 byte = cpu->read8(addr + i, valid);
				if (!valid) { byte = 0; ++invalidBytes; }
				char hb[4];
				snprintf(hb, sizeof(hb), "%02x", byte & 0xFF);
				hexStr += hb;
			}
			if (strict && invalidBytes) return failure("Strict memory read contains unmapped bytes");
			j.valStr(hexStr);
			j.kv("invalid_bytes", invalidBytes);
			j.endObject();
		}
		// ----- WRITE MEMORY -----
		else if (cmd == "write_memory")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			std::string hexData = getStr(params, "data", "");
			int written = 0;
			for (size_t i = 0; i + 1 < hexData.size(); i += 2)
			{
				u8 byte = (u8)strtoul(hexData.substr(i, 2).c_str(), nullptr, 16);
				cpu->write8(addr + written, byte);
				written++;
			}
			j.startObject();
			j.kv("ok", true);
			j.kv("written", (int64_t)written);
			j.endObject();
		}
		// ----- DISASSEMBLE -----
		else if (cmd == "disassemble")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			int count = (int)getNum(params, "count", 20);
			bool simplify = getBool(params, "simplify", true);
			if (count > 500) count = 500;

			j.startObject();
			j.kv("ok", true);
			j.key("instructions"); j.startArray();
			for (int i = 0; i < count; i++)
			{
				u32 pc = addr + i * 4;
				if (!cpu->isValidAddress(pc)) break;

				bool valid = true;
				u32 opcode = cpu->read32(pc, valid);

				j.startObject();
				j.key("address"); j.valHex32(pc);
				j.key("opcode"); j.valHex32(opcode);
				j.kv("disasm", cpu->disasm(pc, simplify));
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- EVALUATE EXPRESSION -----
		else if (cmd == "evaluate")
		{
			std::string expr = getStr(params, "expression", "0");
			u64 result = 0;
			std::string error;
			bool ok = cpu->evaluateExpression(expr.c_str(), result, error);

			j.startObject();
			j.kv("ok", ok);
			if (ok)
			{
				j.key("result"); j.valUint(result);
				char hexBuf[20];
				snprintf(hexBuf, sizeof(hexBuf), "0x%llx", (unsigned long long)result);
				j.kv("hex", hexBuf);
			}
			else
			{
				j.kv("error", error);
			}
			j.endObject();
		}
		// ----- SET BREAKPOINT -----
		else if (cmd == "set_breakpoint")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			bool temp = getBool(params, "temporary", false);
			bool enabled = getBool(params, "enabled", true);
			std::string condExpr = getStr(params, "condition", "");
			std::string desc = getStr(params, "description", "");
			auto bpCpu = getBpCpu(cpuName);

			relinquishSourceBreakpoint(bpCpu, addr);
			CBreakPoints::AddBreakPoint(bpCpu, addr, temp, enabled);

			if (!desc.empty())
				CBreakPoints::ChangeBreakPointDescription(bpCpu, addr, desc);

			if (!condExpr.empty())
			{
				BreakPointCond cond;
				cond.debug = cpu;
				cond.expressionString = condExpr;
				std::string error;
				if (cpu->initExpression(condExpr.c_str(), cond.expression, error))
				{
					CBreakPoints::ChangeBreakPointAddCond(bpCpu, addr, cond);
				}
			}

			j.startObject();
			j.kv("ok", true);
			j.key("address"); j.valHex32(addr);
			j.endObject();
		}
		// ----- REMOVE BREAKPOINT -----
		else if (cmd == "remove_breakpoint")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			relinquishSourceBreakpoint(getBpCpu(cpuName), addr);
			CBreakPoints::RemoveBreakPoint(getBpCpu(cpuName), addr);
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- SET MEMCHECK (WATCHPOINT) -----
		else if (cmd == "set_memcheck")
		{
			u32 start = (u32)getNum(params, "address", 0);
			u32 end = (u32)getNum(params, "end", start + 4);
			std::string typeStr = getStr(params, "type", "write");
			std::string actionStr = getStr(params, "action", "break");
			std::string desc = getStr(params, "description", "");
			std::string condExpr = getStr(params, "condition", "");

			MemCheckCondition cond = MEMCHECK_WRITE;
			if (typeStr == "read") cond = MEMCHECK_READ;
			else if (typeStr == "readwrite" || typeStr == "access") cond = MEMCHECK_READWRITE;
			else if (typeStr == "onchange") cond = (MemCheckCondition)(MEMCHECK_WRITE | MEMCHECK_WRITE_ONCHANGE);

			MemCheckResult result = MEMCHECK_BREAK;
			if (actionStr == "log") result = MEMCHECK_LOG;
			else if (actionStr == "both") result = MEMCHECK_BOTH;

			auto bpCpu = getBpCpu(cpuName);
			CBreakPoints::AddMemCheck(bpCpu, start, end, cond, result);

			if (!desc.empty())
				CBreakPoints::ChangeMemCheckDescription(bpCpu, start, end, desc);

			if (!condExpr.empty())
			{
				BreakPointCond bpCond;
				bpCond.debug = cpu;
				bpCond.expressionString = condExpr;
				std::string error;
				if (cpu->initExpression(condExpr.c_str(), bpCond.expression, error))
					CBreakPoints::ChangeMemCheckAddCond(bpCpu, start, end, bpCond);
			}

			j.startObject();
			j.kv("ok", true);
			j.key("start"); j.valHex32(start);
			j.key("end"); j.valHex32(end);
			j.endObject();
		}
		// ----- REMOVE MEMCHECK -----
		else if (cmd == "remove_memcheck")
		{
			u32 start = (u32)getNum(params, "address", 0);
			u32 end = (u32)getNum(params, "end", start + 4);
			CBreakPoints::RemoveMemCheck(getBpCpu(cpuName), start, end);
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- LIST BREAKPOINTS -----
		else if (cmd == "list_breakpoints")
		{
			auto bps = CBreakPoints::GetBreakpoints(getBpCpu(cpuName), true);
			j.startObject();
			j.kv("ok", true);
			j.key("breakpoints"); j.startArray();
			for (const auto& bp : bps)
			{
				j.startObject();
				j.key("address"); j.valHex32(bp.addr);
				j.kv("enabled", bp.enabled);
				j.kv("temporary", bp.temporary);
				j.kv("stepping", bp.stepping);
				j.kv("has_condition", bp.hasCond);
				if (bp.hasCond)
					j.kv("condition", bp.cond.expressionString);
				if (!bp.description.empty())
					j.kv("description", bp.description);
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- LIST MEMCHECKS -----
		else if (cmd == "list_memchecks")
		{
			auto mcs = CBreakPoints::GetMemChecks(getBpCpu(cpuName));
			j.startObject();
			j.kv("ok", true);
			j.key("memchecks"); j.startArray();
			for (const auto& mc : mcs)
			{
				j.startObject();
				j.key("start"); j.valHex32(mc.start);
				j.key("end"); j.valHex32(mc.end);
				j.kv("hits", (int64_t)mc.numHits);
				j.key("last_pc"); j.valHex32(mc.lastPC);
				j.key("last_addr"); j.valHex32(mc.lastAddr);
				if (!mc.description.empty())
					j.kv("description", mc.description);
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- PAUSE -----
		else if (cmd == "pause")
		{
			return onCPU([cpu]() {
				cpu->pauseCpu();
				JsonBuilder result; result.startObject(); result.kv("ok", true);
				result.key("pc"); result.valHex32(cpu->getPC()); result.endObject(); return result.str();
			});
		}
		// ----- RESUME -----
		else if (cmd == "resume")
		{
			// Skip current BP if we're sitting on one (matches PCSX2 GUI behavior)
			return onCPU([cpu, cpuName]() {
				CBreakPoints::SetSkipFirst(getBpCpu(cpuName), cpu->getPC());
				cpu->resumeCpu();
				JsonBuilder result; result.startObject(); result.kv("ok", true); result.endObject(); return result.str();
			});
		}
		// ----- STEP -----
		else if (cmd == "step")
		{
			u32 pc = cpu->getPC();

			// Skip current BP if we're sitting on one (matches PCSX2 GUI behavior)
			CBreakPoints::SetSkipFirst(getBpCpu(cpuName), pc);

			u32 nextPc = pc + 4;
			CBreakPoints::AddBreakPoint(getBpCpu(cpuName), nextPc, true, true, true);
			cpu->resumeCpu();

			// Wait for it to hit (with timeout)
			int timeout = 5000; // ms
			while (!cpu->isCpuPaused() && timeout > 0)
			{
				std::this_thread::sleep_for(std::chrono::milliseconds(1));
				timeout--;
			}

			u32 newPc = cpu->getPC();
			bool inBios = (newPc < 0x00100000) || (newPc >= 0x80000000 && newPc < 0x80100000);

			j.startObject();
			j.kv("ok", true);
			j.key("old_pc"); j.valHex32(pc);
			j.key("new_pc"); j.valHex32(newPc);
			j.kv("disasm", cpu->disasm(newPc, true));
			j.kv("in_bios", inBios);

			bool valid = true;
			u32 opcode = cpu->read32(newPc, valid);
			j.key("opcode"); j.valHex32(opcode);
			j.endObject();
		}
		// ----- STEP OVER -----
		else if (cmd == "step_over")
		{
			u32 pc = cpu->getPC();

			// Skip current BP if we're sitting on one (matches PCSX2 GUI behavior)
			CBreakPoints::SetSkipFirst(getBpCpu(cpuName), pc);

			bool valid = true;
			u32 opcode = cpu->read32(pc, valid);
			u32 op = (opcode >> 26) & 63;

			u32 bpAddr = pc + 8; // default: skip instruction + delay slot
			if (op == 3 || // JAL
				(op == 0 && (opcode & 63) == 9)) // JALR
			{
				bpAddr = pc + 8;
			}
			else
			{
				bpAddr = pc + 4;
			}

			CBreakPoints::AddBreakPoint(getBpCpu(cpuName), bpAddr, true, true, true);
			cpu->resumeCpu();

			int timeout = 10000;
			while (!cpu->isCpuPaused() && timeout > 0)
			{
				std::this_thread::sleep_for(std::chrono::milliseconds(1));
				timeout--;
			}

			u32 newPc = cpu->getPC();
			bool inBios = (newPc < 0x00100000) || (newPc >= 0x80000000 && newPc < 0x80100000);

			j.startObject();
			j.kv("ok", true);
			j.key("old_pc"); j.valHex32(pc);
			j.key("new_pc"); j.valHex32(newPc);
			j.kv("disasm", cpu->disasm(newPc, true));
			j.kv("in_bios", inBios);
			j.endObject();
		}
		// ----- GET THREADS -----
		else if (cmd == "get_threads")
		{
			auto threads = cpu->GetThreadList();
			j.startObject();
			j.kv("ok", true);
			j.key("threads"); j.startArray();
			for (const auto& t : threads)
			{
				j.startObject();
				j.kv("id", (int64_t)t->TID());
				j.key("pc"); j.valHex32(t->PC());
				j.kv("status", (int64_t)(int)t->Status());
				j.kv("wait_type", (int64_t)(int)t->Wait());
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- GET MODULES (IOP only) -----
		else if (cmd == "get_modules")
		{
			auto mods = cpu->GetModuleList();
			j.startObject();
			j.kv("ok", true);
			j.key("modules"); j.startArray();
			for (const auto& m : mods)
			{
				j.startObject();
				j.kv("name", m.name);
				j.kv("version", (int64_t)m.version);
				j.endObject();
			}
			j.endArray();
			j.endObject();
		}
		// ----- GET BACKTRACE -----
		else if (cmd == "get_backtrace")
		{
			int maxFrames = (int)getNum(params, "max_frames", 32);
			if (maxFrames > 128) maxFrames = 128;

			u32 pc = cpu->getPC();
			u32 ra = cpu->getRegister(0, 31); // $ra
			u32 sp = cpu->getRegister(0, 29); // $sp

			// Find the running thread to get entry point and stack top
			u32 threadEntry = 0;
			u32 threadStackTop = 0;
			auto threads = cpu->GetThreadList();
			for (const auto& t : threads)
			{
				if (t->Status() == ThreadStatus::THS_RUN)
				{
					threadEntry = t->EntryPoint();
					threadStackTop = t->StackTop();
					break;
				}
			}

			auto frames = MipsStackWalk::Walk(cpu, pc, ra, sp, threadEntry, threadStackTop);

			j.startObject();
			j.kv("ok", true);
			j.kv("frame_count", (int64_t)(std::min)((int)frames.size(), maxFrames));
			j.key("frames"); j.startArray();
			int count = 0;
			for (const auto& f : frames)
			{
				if (count >= maxFrames) break;
				j.startObject();
				j.key("entry"); j.valHex32(f.entry);
				j.key("pc"); j.valHex32(f.pc);
				j.key("sp"); j.valHex32(f.sp);
				j.kv("stack_size", (int64_t)f.stackSize);
				j.kv("disasm", cpu->disasm(f.pc, true));
				j.endObject();
				count++;
			}
			j.endArray();
			j.endObject();
		}
		// ----- IS VALID ADDRESS -----
		else if (cmd == "is_valid_address")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			j.startObject();
			j.kv("ok", true);
			j.kv("valid", cpu->isValidAddress(addr));
			j.endObject();
		}
		// ----- READ STRING -----
		else if (cmd == "read_string")
		{
			u32 addr = (u32)getNum(params, "address", 0);
			int maxLen = (int)getNum(params, "max_length", 256);
			if (maxLen > 4096) maxLen = 4096;

			std::string str;
			for (int i = 0; i < maxLen; i++)
			{
				bool valid = true;
				u32 byte = cpu->read8(addr + i, valid);
				if (!valid || byte == 0) break;
				str += (char)byte;
			}

			j.startObject();
			j.kv("ok", true);
			j.kv("string", str);
			j.kv("length", (int64_t)str.size());
			j.endObject();
		}
		// ----- CLEAR ALL BREAKPOINTS -----
		else if (cmd == "clear_breakpoints")
		{
			for (auto& [id, group] : s_sourceGroups) group.relinquished = group.addresses;
			CBreakPoints::ClearAllBreakPoints();
			CBreakPoints::ClearAllMemChecks();
			j.startObject();
			j.kv("ok", true);
			j.endObject();
		}
		// ----- UNKNOWN COMMAND -----
		else
		{
			j.startObject();
			j.kv("ok", false);
			j.kv("error", "Unknown command: " + cmd);
			j.key("available_commands"); j.startArray();
			const char* cmds[] = {
				"status", "capabilities", "read_events", "read_logs", "capture_context", "load_elf",
				"frame_advance", "input_frames", "automation_status", "automation_cancel", "controller_state",
				"lookup_symbols", "resolve_address", "breakpoint_symbol", "import_symbols",
				"install_source_breakpoints", "remove_source_breakpoints",
				"screenshot", "read_registers", "write_register", "set_pc",
				"read_memory", "write_memory", "read_string",
				"disassemble", "evaluate",
				"set_breakpoint", "remove_breakpoint", "list_breakpoints",
				"set_memcheck", "remove_memcheck", "list_memchecks",
				"pause", "resume", "step", "step_over",
				"get_threads", "get_modules",
				"is_valid_address", "clear_breakpoints"
			};
			for (const char* c : cmds) j.valStr(c);
			j.endArray();
			j.endObject();
		}

		return j.str();
	}

	// ============================================================
	// TCP Server
	// ============================================================
	static std::thread s_serverThread;
	static socket_t s_listenSocket = SOCKET_INVALID;
	static std::mutex s_commandMutex;

	static std::string executeCommand(const std::string& line)
	{
		const auto params = parseJsonObject(line);
		const std::string cmd = getStr(params, "cmd");
		// Event long-polls must not prevent a different client from resuming.
		if (cmd == "read_events" || cmd == "read_logs") return handleCommand(line);
		std::lock_guard lock(s_commandMutex);
		if (cmd == "screenshot" || cmd == "capture_context" || cmd == "capabilities" ||
			cmd == "load_elf" || cmd == "pause" || cmd == "resume" || cmd == "step" || cmd == "step_over")
			return handleCommand(line);
		// Register/memory/breakpoint operations share the CPU thread with snapshots.
		return onCPU([line]() { return handleCommand(line); });
	}

	static void clientHandler(socket_t clientSock)
	{
		std::string buffer;
		char recvBuf[4096];

		while (s_running.load())
		{
			int bytes = recv(clientSock, recvBuf, sizeof(recvBuf) - 1, 0);
			if (bytes <= 0) break;

			recvBuf[bytes] = '\0';
			buffer += recvBuf;
			if (buffer.size() > 65536) break; // bounded requests, including unterminated lines

			// Process complete lines
			size_t newlinePos;
			while ((newlinePos = buffer.find('\n')) != std::string::npos)
			{
				std::string line = buffer.substr(0, newlinePos);
				buffer = buffer.substr(newlinePos + 1);

				// Trim
				while (!line.empty() && (line.back() == '\r' || line.back() == '\n'))
					line.pop_back();

				if (line.empty()) continue;

				std::string response = executeCommand(line);
				response += "\n";

				// A PNG response can exceed the socket's send buffer.
				size_t sent = 0;
				int sendFlags = 0;
#ifdef MSG_NOSIGNAL
				sendFlags = MSG_NOSIGNAL;
#endif
				while (sent < response.size())
				{
					const int count = send(clientSock, response.data() + sent, static_cast<int>(response.size() - sent), sendFlags);
					if (count < 0)
					{
#ifdef _WIN32
						if (WSAGetLastError() == WSAEINTR) continue;
#else
						if (errno == EINTR) continue;
#endif
					}
					if (count <= 0)
					{
						CLOSE_SOCKET(clientSock);
						return;
					}
					sent += static_cast<size_t>(count);
				}
			}
		}

		CLOSE_SOCKET(clientSock);
	}

	static void serverLoop(int port)
	{
#ifdef _WIN32
		WSADATA wsaData;
		WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif

		s_listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
		if (s_listenSocket == SOCKET_INVALID)
		{
			fprintf(stderr, "[DebugServer] Failed to create socket\n");
			return;
		}

		int opt = 1;
		setsockopt(s_listenSocket, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));

		struct sockaddr_in addr = {};
		addr.sin_family = AF_INET;
		addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // localhost only
		addr.sin_port = htons((u_short)port);

		if (bind(s_listenSocket, (struct sockaddr*)&addr, sizeof(addr)) != 0)
		{
			fprintf(stderr, "[DebugServer] Failed to bind on port %d\n", port);
			CLOSE_SOCKET(s_listenSocket);
			s_listenSocket = SOCKET_INVALID;
			return;
		}

		if (listen(s_listenSocket, 2) != 0)
		{
			fprintf(stderr, "[DebugServer] Failed to listen\n");
			CLOSE_SOCKET(s_listenSocket);
			s_listenSocket = SOCKET_INVALID;
			return;
		}

		fprintf(stderr, "[DebugServer] Listening on 127.0.0.1:%d\n", port);

		while (s_running.load())
		{
			// Use select with timeout to allow clean shutdown
			fd_set readSet;
			FD_ZERO(&readSet);
			FD_SET(s_listenSocket, &readSet);

			struct timeval tv;
			tv.tv_sec = 1;
			tv.tv_usec = 0;

			int selectResult = select((int)s_listenSocket + 1, &readSet, nullptr, nullptr, &tv);
			if (selectResult <= 0) continue;

			socket_t clientSock = accept(s_listenSocket, nullptr, nullptr);
			if (clientSock == SOCKET_INVALID) continue;

			fprintf(stderr, "[DebugServer] Client connected\n");

			// Handle client in a new thread
			std::thread(clientHandler, clientSock).detach();
		}

		CLOSE_SOCKET(s_listenSocket);
		s_listenSocket = SOCKET_INVALID;

#ifdef _WIN32
		WSACleanup();
#endif
	}

	void Start(int port)
	{
		if (s_running.exchange(true)) return;
		s_sourceGroups.clear();
		s_step = {}; s_stepDeadline.store(0); ++s_executionEpoch;
		s_exception = {}; s_exceptionDeadline.store(0); s_exceptionPending.store(0);
		s_eeBreakOrigin = {};
		++s_session;
		const uint64_t watchdogSession = s_session.load();
		std::thread([watchdogSession]() {
			uint64_t queuedOperation = 0, queuedException = 0, queuedExpiry = 0;
			while (s_running.load() && s_session.load() == watchdogSession)
			{
				std::this_thread::sleep_for(std::chrono::milliseconds(10));
				const auto operationId = s_stepWatchId.load();
				const auto deadline = s_stepDeadline.load();
				const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
				const auto pending = s_exceptionPending.load();
				const auto expiry = s_exceptionDeadline.load();
				const auto watchSequence = s_exceptionWatchId.load();
				if (pending && pending != queuedException)
				{
					queuedException = pending;
					Host::RunOnCPUThread([watchdogSession, pending]() { if (s_session.load() == watchdogSession) finalizeException(pending); });
				}
				if (expiry && expiry <= now && watchSequence != queuedExpiry)
				{
					queuedExpiry = watchSequence;
					Host::RunOnCPUThread([watchdogSession, expiry, watchSequence]() {
						if (s_session.load() == watchdogSession && s_exception.sequence == watchSequence && s_exception.state == "armed" && s_exception.deadline == expiry)
						{ s_exception.state = "expired"; s_exceptionDeadline.store(0); }
					});
				}
				if (!deadline || now < deadline || queuedOperation == operationId) continue;
				queuedOperation = operationId;
				Host::RunOnCPUThread([watchdogSession, deadline, operationId]() {
					if (s_session.load() != watchdogSession || !s_step.active || s_step.id != operationId) return;
					// A newer step may have started while this callback was queued.
					if (s_stepDeadline.load() != deadline) return;
					if (VMManager::GetState() == VMState::Paused) { guardedStepStatus(); return; }
					VMManager::SetPaused(true); finishGuardedStep("timeout");
				});
			}
		}).detach();
		Log::SetObserver(&recordLog);
		recordEvent("vm_started");
		s_serverThread = std::thread(serverLoop, port);
		s_serverThread.detach();
	}

	void Stop()
	{
		if (s_exception.state == "capturing") finalizeException(s_exception.sequence);
		if (s_exception.state == "armed") s_exception.state = "vm_stopped";
		s_exceptionDeadline.store(0);
		finishGuardedStep("vm_stopping");
		finishOperation("vm_stopping");
		recordEvent("vm_stopping");
		Log::SetObserver(nullptr);
		s_running.store(false);
		s_eventReady.notify_all();
		if (s_listenSocket != SOCKET_INVALID)
		{
			CLOSE_SOCKET(s_listenSocket);
			s_listenSocket = SOCKET_INVALID;
		}
	}

	bool IsRunning()
	{
		return s_running.load();
	}

	void OnBreakpointHit(bool iop, bool watchpoint)
	{
		if (!s_running.load()) return;
		if (s_step.active) s_step.reason = !iop && !watchpoint && r5900Debug.getPC() == s_step.target ? "completed" : (watchpoint ? "watchpoint" : "breakpoint");
		recordEvent(watchpoint ? "watchpoint" : "breakpoint", iop ? "iop" : "ee",
			iop ? r3000Debug.getPC() : r5900Debug.getPC());
	}

	void OnVMStateChanged(int state)
	{
		++s_inspectionRevision;
		if (!s_running.load()) return;
		if (state == static_cast<int>(VMState::Paused) && s_operation.active)
			finishOperation(s_videoFrame >= s_operation.target ? "completed" : "paused_early");
		if (state == static_cast<int>(VMState::Paused)) recordEvent("paused", "ee", r5900Debug.getPC());
		else if (state == static_cast<int>(VMState::Running)) recordEvent("resumed", "ee", r5900Debug.getPC());
	}

	void OnVSync()
	{
		if (!s_running.load()) return;
		++s_videoFrame;
		if (s_operation.active && std::chrono::steady_clock::now() >= s_operation.deadline)
		{
			finishOperation("deadline");
			VMManager::SetPaused(true);
		}
	}

	void OnInputPoll()
	{
		if (s_operation.active && std::chrono::steady_clock::now() >= s_operation.deadline)
		{
			finishOperation("deadline");
			VMManager::SetPaused(true);
		}
		if (!s_operation.active || !s_operation.input) return;
		auto* pad = Pad::GetPad(s_operation.controller);
		if (!pad || pad != s_operation.savedPad || pad->GetType() != Pad::ControllerType::DualShock2)
		{
			finishOperation("controller_changed");
			VMManager::SetPaused(true);
			return;
		}
		for (u32 i = 0; i < 16; ++i)
			pad->SetRawPressureButton(i, {(s_operation.buttons & (1u << i)) != 0, (s_operation.buttons & (1u << i)) ? u8{255} : u8{0}});
		const auto& a = s_operation.axes;
		pad->SetRawAnalogs({a[0], a[1]}, {a[2], a[3]});
	}

	void OnVMReset()
	{
		s_eeBreakOrigin = {};
		if (s_exception.state == "capturing") finalizeException(s_exception.sequence);
		if (s_exception.state == "armed") s_exception.state = "vm_changed";
		s_exceptionDeadline.store(0);
		++s_inspectionRevision;
		finishGuardedStep("vm_reset"); ++s_executionEpoch;
		finishOperation("vm_reset");
	}

	void ExecuteEEBreak(uint32_t taggedInstructionPC, uint32_t opcode)
	{
		const u32 instructionPC = taggedInstructionPC & ~3u;
		s_eeBreakOrigin = {};
		if (s_exception.state == "armed")
		{
			s_eeBreakOrigin.active = true; s_eeBreakOrigin.pc = instructionPC;
			s_eeBreakOrigin.opcode = opcode; s_eeBreakOrigin.branchDelay = (taggedInstructionPC & 1) != 0;
			if (!(instructionPC & 3) && instructionPC <= 0x02000000u - 4)
			{
				bool valid = false; const auto memoryOpcode = r5900Debug.read32(instructionPC, valid);
				s_eeBreakOrigin.opcodeMatchesMemory = valid && memoryOpcode == opcode;
			}
		}
		// Preserve upstream BREAK exactly, including its exception PC/BD behavior.
		R5900::Interpreter::OpcodeImpl::BREAK();
		s_eeBreakOrigin = {};
	}

	void OnEEException(uint32_t code, uint32_t pc, bool branchDelay, bool nested)
	{
		const EEBreakOrigin origin = s_eeBreakOrigin;
		s_eeBreakOrigin = {};
		bool capture = false;
		if (s_exception.state == "armed")
		{
			if (steadyMillis() >= s_exception.deadline) { s_exception.state = "expired"; s_exceptionDeadline.store(0); }
			else if (s_exception.epoch != s_executionEpoch || s_exception.elf != VMManager::GetCurrentELF() || s_exception.crc != VMManager::GetCurrentCRC())
			{ s_exception.state = "vm_changed"; s_exceptionDeadline.store(0); }
			else if (s_exception.mask & (1u << ((code >> 2) & 31)))
			{
				capture = true; s_exception.state = "capturing"; s_exceptionDeadline.store(0);
				s_exception.code = code; s_exception.exceptionPC = pc; s_exception.postPC = r5900Debug.getPC();
				s_exception.branchDelay = branchDelay; s_exception.nested = nested; s_exception.timestamp = timestampMillis();
				if (((code >> 2) & 31) == 9) s_exception.instruction = origin;
				for (int i = 0; i < 32; ++i) { s_exception.gpr[i] = r5900Debug.getRegister(0, i); s_exception.cp0[i] = r5900Debug.getRegister(1, i)._u32[0]; }
				recordEvent("ee_exception", "ee", pc, s_exception.id);
			}
		}
		if (!s_step.active && !capture) return;
		if (s_step.active) s_step.reason = "exception";
		VMManager::SetPaused(true);
		if (capture) { s_exception.revision = s_inspectionRevision; s_exceptionPending.store(s_exception.sequence); }
		// The normal CPU safe-exit hook defers exit during cpuEventTest.
		Cpu->ExitExecution();
	}

	bool PreserveStepWatchpoints()
	{
		return s_step.active;
	}

} // namespace DebugServer
