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
#include "R3000A.h"
#include "Common.h"
#include "Sif.h"
#include "IopHw.h"
#include "ps2/pgif.h"
#include "SymbolGuardian.h"
#include "SymbolImporter.h"
#include "Host.h"
#include "MTGS.h"
#include "VMManager.h"
#include "Config.h"
#include "Achievements.h"
#include "Recording/InputRecording.h"
#include "Recording/InputRecordingControls.h"
#include "SIO/Pad/Pad.h"
#include "SIO/Pad/PadDualshock2.h"
#include "common/Image.h"
#include "common/Console.h"
#include "common/FileSystem.h"
#include "common/Path.h"
#include "GS/Renderers/Common/GSRenderer.h"
#include "GS/GSCapture.h"

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
#include <charconv>
#include <sys/stat.h>

// Forward declarations — these are PCSX2 globals
extern R5900DebugInterface r5900Debug;
extern R3000DebugInterface r3000Debug;
// PGIF control objects, read directly without invoking FIFO/MMIO handlers.
extern ringBuf_t rb_gp0, rb_gp1;
extern dma_t dma;

namespace DebugServer
{
	static std::atomic<bool> s_running{false};
	static int s_debugPort = 21512; // CPU thread: set only after a successful bind.
	static thread_local uint64_t s_requestSession = 0;
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
	struct InputMovie
	{
		std::string id, mode, state, reason, path, source, elf, elfSHA, movieSHA;
		uint64_t session = 0, epoch = 0, sequence = 0;
		u32 crc = 0, frame = 0, limit = 0;
		bool active = false, starting = false, ioError = false, pendingInput = false;
		std::array<FrameOperation, 2> pads;
	};
	static InputMovie s_movie;
	static std::atomic<int64_t> s_movieDeadline{0};
	static std::atomic<uint64_t> s_movieSequence{0};
	static void finishMovie(const char* reason);
	// CPU-thread state; only the watchdog deadline crosses threads.
	static uint64_t s_executionEpoch = 1, s_stepSequence = 0;
	static uint64_t s_inspectionRevision = 1;
	static uint64_t s_iopResetEpoch = 1;
	struct PgifWriteObservation
	{
		uint64_t sequence, session, epoch, resetEpoch, lifetimeEpoch;
		u32 address, value, bits, before, after, iopPC, iopCycles;
	};
	static std::deque<PgifWriteObservation> s_pgifWrites;
	static uint64_t s_pgifWriteSequence = 0;
	static u32 s_iopModuleRoot = 0;
	static uint64_t s_iopModuleDiscovery = 0, s_iopModuleSnapshot = 0;
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
	struct InstructionOrigin
	{
		bool active = false, branchDelay = false, opcodeMatchesMemory = false;
		u32 pc = 0, opcode = 0;
	};
	static InstructionOrigin s_eeOrigin, s_iopOrigin;
	struct ExceptionWatch
	{
		std::string id, state, elf, report;
		uint64_t sequence = 0, session = 0, epoch = 0, revision = 0;
		u32 crc = 0, mask = 0, code = 0, exceptionPC = 0, postPC = 0;
		bool branchDelay = false, nested = false, screenshot = true;
		bool iop = false;
		uint64_t iopEpoch = 0;
		u32 previousStatus = 0, hi = 0, lo = 0;
		int64_t deadline = 0, timestamp = 0;
		std::array<u128, 32> gpr{};
		std::array<u32, 32> cp0{};
		InstructionOrigin instruction;
	};
	static ExceptionWatch s_exception;
	static uint64_t s_exceptionSequence = 0;
	static std::atomic<uint64_t> s_exceptionPending{0};
	static std::atomic<uint64_t> s_exceptionWatchId{0};
	static std::atomic<int64_t> s_exceptionDeadline{0};
	struct ProgressSample
	{
		int64_t timestamp = 0, elapsed = 0;
		u32 pc = 0, cycles = 0, heartbeat = 0, gate = 0;
		bool valid = false, gateValid = false;
		std::string phase;
	};
	struct ProgressWatch
	{
		std::string id, state, elf, report;
		uint64_t sequence = 0, session = 0, epoch = 0, total = 0, unchangedIntervals = 0;
		u32 crc = 0, address = 0, mask = UINT32_MAX, gateAddress = 0, gateMask = UINT32_MAX, gateValue = 1;
		bool gated = false, screenshot = true, baseline = false;
		int64_t start = 0, deadline = 0, interval = 100, threshold = 1000, unchanged = 0;
		size_t limit = 64;
		std::deque<ProgressSample> samples;
	};
	static ProgressWatch s_progress;
	static uint64_t s_progressSequence = 0;
	static std::atomic<uint64_t> s_progressWatchId{0}, s_progressQueued{0};
	static std::atomic<int64_t> s_progressNext{0};
	static void sampleProgress();
	// Bounded CPU-thread observers. The watchdog only queues a callback; it never
	// dereferences guest memory or pauses the VM from its worker thread.
	struct ChangeSample
	{
		int64_t elapsed = 0, timestamp = 0;
		u32 raw = 0, pc = 0, cycles = 0;
	};
	struct ChangeWatch
	{
		std::string id, state, elf;
		uint64_t session = 0, epoch = 0, iopEpoch = 0, revision = 0, samples = 0, rebases = 0, samplingNs = 0;
		u32 crc = 0, address = 0, size = 4, mask = UINT32_MAX;
		bool iop = false, pause = false, baseline = false;
		int64_t start = 0, deadline = 0, next = 0, interval = 100;
		ChangeSample previous, current;
	};
	static std::deque<ChangeWatch> s_changes;
	struct LoadWatch
	{
		std::string id, state, path, sha, elf, bindingReason;
		uint64_t session = 0, epoch = 0, iopEpoch = 0, sequence = 0, coverage = 0, reads = 0;
		uint64_t registrationRevision = 0, lifetimeEpoch = 0;
		u32 crc = 0, size = 0, buffer = 0, fileInfo = 0, record = 0, loaderPC = 0;
		int fd = -1;
		int64_t deadline = 0, bufferTimestamp = 0, registrationTimestamp = 0;
		bool binding = false, fileClosed = false;
		std::array<u8, 64> prefix{};
		std::array<u32, 9> info{};
		std::vector<u8> bytes, covered;
	};
	static LoadWatch s_load;
	static uint64_t s_loadSequence = 0;
	static std::atomic<int64_t> s_loadDeadline{0};
	static std::atomic<uint64_t> s_loadId{0};
	// A conservative invalidation epoch, not a per-module load generation.
	struct LifetimeEvent { uint64_t epoch; int64_t timestamp; std::string kind; u32 address; };
	static uint64_t s_iopLifetimeEpoch = 0;
	static std::deque<LifetimeEvent> s_lifetime;
	static bool s_lifetimeTruncated = false;
	struct Registration
	{
		uint64_t sequence = 0, epoch = 0;
		std::array<u32, 6> metadata{};
		u32 moduleId = 0, nameAddress = 0, version = 0;
		bool sealed = false;
	};
	static std::unordered_map<u32, Registration> s_registrations;
	static uint64_t s_registrationSequence = 0;
	static std::string s_registrationNamespace;
	struct SIFResetPacket { u32 address = 0, next = 0, remaining = 0, copied = 0; std::array<u32, 26> words{}; };
	static SIFResetPacket s_sifReset;
	static bool loadActive() { return s_load.state == "armed" || s_load.state == "file_reading" || s_load.state == "file_complete" || s_load.state == "buffer_observed"; }
	static void invalidateLoad(const char* reason)
	{
		if (loadActive()) { s_load.state = reason; s_load.fd = -1; s_loadDeadline.store(0); }
		if (s_load.binding) { s_load.binding = false; s_load.bindingReason = reason; }
	}
	static std::atomic<int64_t> s_changeNext{0};
	static std::atomic<uint64_t> s_changeQueued{0};
	static int64_t steadyMillis();
	static bool activeChanges()
	{
		return std::any_of(s_changes.begin(), s_changes.end(), [](const auto& w) { return w.state == "armed" && w.deadline > steadyMillis(); });
	}
	static int64_t steadyMillis()
	{
		return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
	}

	static int64_t timestampMillis()
	{
		return std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::system_clock::now().time_since_epoch()).count();
	}

	static void invalidateChanges(const char* reason, bool iopOnly);
	static void lifetimeBoundary(const char* kind, u32 address = 0)
	{
		const std::string_view boundary(kind);
		if (boundary != "debugger_mutation" && boundary != "cpu_reset" && boundary != "vm_reset" && boundary != "server_start")
		{
			invalidateChanges("lifetime_changed", true);
			if (s_exception.iop && s_exception.state == "armed") { s_exception.state = "lifetime_changed"; s_exceptionDeadline.store(0); }
		}
		if (std::string_view(kind) == "register_module_call" || std::string_view(kind) == "release_module_call") s_registrations.erase(address);
		else s_registrations.clear(); // Unknown load, reboot, restore or mutation revokes all retained identities.
		++s_iopLifetimeEpoch;
		s_lifetime.push_back({s_iopLifetimeEpoch, timestampMillis(), kind, address});
		if (s_lifetime.size() > 64) { s_lifetime.pop_front(); s_lifetimeTruncated = true; }
		if (s_load.state == "registered") invalidateLoad("lifetime_boundary");
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
		bool integerValid = false; // Strict consumers can reject truncation/overflow.
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
				int64_t exact = 0;
				const auto parsed = std::from_chars(ns.data(), ns.data() + ns.size(), exact, isHex ? 16 : 10);
				val.integerValid = parsed.ec == std::errc{} && parsed.ptr == ns.data() + ns.size() &&
					i < json.size() && (json[i] == ',' || json[i] == '}' || json[i] == ' ' || json[i] == '\t' || json[i] == '\r' || json[i] == '\n');
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
		const uint64_t requestSession = s_requestSession;
		// MTGS has a single producer: queue the capture from the CPU thread,
		// never from this TCP worker. Shared ownership also covers a late callback.
		Host::RunOnCPUThread([capture, requestedWidth, requestedHeight, requestSession]() {
			{
				std::lock_guard lock(capture->mutex);
				if (capture->cancelled)
					return;
				if (requestSession && (!s_running.load() || s_session.load() != requestSession))
				{ capture->done = true; capture->ready.notify_one(); return; }
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
		const uint64_t requestSession = s_requestSession;
		Host::RunOnCPUThread([work, requestSession, operation = std::move(operation)]() {
			int queued = 0;
			if (!work->state.compare_exchange_strong(queued, 1)) return;
			if (requestSession && (!s_running.load() || s_session.load() != requestSession))
			{ work->result.set_value(failure("DebugServer session ended before the operation started")); return; }
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

	struct DumpOperation
	{
		std::string id, base, path, elf, state, reason;
		uint64_t session = 0, epoch = 0, bytes = 0, maxBytes = 0;
		u32 crc = 0, frames = 0;
		bool active = false, framesComplete = false;
	};
	static DumpOperation s_dump;
	static std::mutex s_dumpMutex;
	static std::atomic<int64_t> s_dumpDeadline{0};
	static std::atomic<uint64_t> s_dumpSequence{0};
	static std::atomic<bool> s_dumpActive{false};

	void OnGSDumpOpened(const std::string& path, bool opened)
	{
		if (!s_dumpActive.load()) return;
		std::lock_guard lock(s_dumpMutex);
		if (!s_dump.active || s_dump.path != path || s_dump.state != "queued") return;
		s_dump.state = opened ? "recording" : "failed";
		if (!opened) { s_dump.reason = "open_failed"; s_dump.active = false; s_dumpActive.store(false); s_dumpDeadline.store(0); }
	}

	bool GSDumpWriteAllowed(const std::string& path, uint64_t bytes)
	{
		if (!s_dumpActive.load()) return true;
		std::lock_guard lock(s_dumpMutex);
		if (s_dump.path != path) return true;
		if (s_dump.state != "recording") return false;
		if (bytes > s_dump.maxBytes - s_dump.bytes)
		{
			s_dump.state = "cancelling"; s_dump.reason = "size_limit";
			s_dumpDeadline.store(steadyMillis()); return false;
		}
		s_dump.bytes += bytes; return true;
	}

	void OnGSDumpFramesComplete(const std::string& path)
	{
		if (!s_dumpActive.load()) return;
		std::lock_guard lock(s_dumpMutex);
		if (s_dump.active && s_dump.path == path) s_dump.framesComplete = true;
	}

	void OnGSDumpClosed(const std::string& path, bool complete)
	{
		if (!s_dumpActive.load()) return;
		std::lock_guard lock(s_dumpMutex);
		if (!s_dump.active || s_dump.path != path || s_dump.state == "cancelling") return;
		complete = complete && s_dump.framesComplete;
		s_dump.state = complete ? "closed" : "failed";
		s_dump.reason = complete ? "frames_recorded" : "incomplete_or_io_error";
		s_dump.active = false; s_dumpActive.store(false); s_dumpDeadline.store(0);
	}

	// CPU thread only. Ownership remains active until GS cleanup is confirmed.
	static void cancelDump(const std::string& reason)
	{
		std::string id, base;
		{
			std::lock_guard lock(s_dumpMutex);
			if (!s_dump.active) return;
			if (s_dump.reason.empty()) s_dump.reason = reason;
			s_dump.state = "cancelling"; id = s_dump.id; base = s_dump.base;
			s_dumpDeadline.store(0);
		}
		MTGS::RunOnGSThread([id, base]() {
			if (g_gs_renderer) g_gs_renderer->CancelMCPDump(base);
			std::lock_guard lock(s_dumpMutex);
			if (s_dump.id != id || !s_dump.active) return;
			s_dump.state = s_dump.reason == "cancelled" ? "cancelled" : s_dump.reason == "timeout" ? "expired" :
				(s_dump.reason == "vm_reset" || s_dump.reason == "vm_stopped") ? "invalidated" : "failed";
			s_dump.active = false; s_dumpActive.store(false);
		});
	}

	static std::string dumpStatus()
	{
		std::lock_guard lock(s_dumpMutex);
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("operation_id", s_dump.id);
		j.kv("state", s_dump.state); j.kv("active", s_dump.active); j.kv("reason", s_dump.reason);
		j.kv("session", s_dump.session); j.kv("execution_epoch", s_dump.epoch);
		j.kv("elf", s_dump.elf); j.key("elf_crc"); j.valHex32(s_dump.crc);
		j.kv("path", s_dump.path); j.kv("frames_requested", static_cast<uint64_t>(s_dump.frames));
		j.kv("bytes_submitted", s_dump.bytes); j.kv("max_bytes", s_dump.maxBytes);
		j.kv("format", "uncompressed_gs"); j.endObject(); return j.str();
	}

	static std::string dumpCommand(const std::unordered_map<std::string, JsonValue>& params, const std::string& cmd)
	{
		const std::string id = getStr(params, "operation_id");
		if (id.size() != 32 || id.find_first_not_of("0123456789abcdef") != std::string::npos) return failure("Invalid dump operation ID");
		if (cmd != "gs_dump_start")
		{
			{ std::lock_guard lock(s_dumpMutex); if (s_dump.id != id) return failure("Unknown GS dump operation"); }
			if (cmd == "gs_dump_cancel") cancelDump("cancelled");
			else if (s_dumpDeadline.load() && steadyMillis() >= s_dumpDeadline.load()) cancelDump("timeout");
			return dumpStatus();
		}
		const auto frames = getNum(params, "frames", 1), timeout = getNum(params, "timeout_ms", 15000), maxBytes = getNum(params, "max_bytes", 64 * 1024 * 1024);
		if (frames < 1 || frames > 300 || timeout < 100 || timeout > 30000 || maxBytes < 1024 * 1024 || maxBytes > 256 * 1024 * 1024)
			return failure("Dump requires 1-300 frames, 100-30000 ms and 1-256 MiB");
		if (!MTGS::IsOpen() || (VMManager::GetState() != VMState::Running && VMManager::GetState() != VMState::Paused)) return failure("No active graphics renderer");
		if (s_step.active || s_operation.active) return failure("An execution operation is active");
#ifdef _WIN32
		const uint64_t process = GetCurrentProcessId();
#else
		const uint64_t process = getpid();
#endif
		if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
			getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
			getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
			getStr(params, "expected_elf") != VMManager::GetCurrentELF() || getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
			return failure("GS dump VM identity changed");
		const std::string directory = Path::Combine(EmuFolders::DataRoot, "mcp-gs-dumps");
		const std::string base = Path::Combine(directory, id);
		{
			std::lock_guard lock(s_dumpMutex);
			if (s_dump.active) return failure("A GS dump is active or cleanup is pending");
			if (FileSystem::FileExists((base + ".gs").c_str())) return failure("Dump file already exists");
			if (!FileSystem::CreateDirectoryPath(directory.c_str(), false)) return failure("Cannot create GS dump output directory");
			s_dump = {}; s_dump.id = id; s_dump.base = base; s_dump.path = base + ".gs";
			s_dump.session = s_session.load(); s_dump.epoch = s_executionEpoch; s_dump.elf = VMManager::GetCurrentELF(); s_dump.crc = VMManager::GetCurrentCRC();
			s_dump.frames = static_cast<u32>(frames); s_dump.maxBytes = static_cast<uint64_t>(maxBytes); s_dump.active = true; s_dump.state = "queued";
			++s_dumpSequence; s_dumpActive.store(true); s_dumpDeadline.store(steadyMillis() + timeout);
		}
		MTGS::RunOnGSThread([id, base, frames]() {
			{ std::lock_guard lock(s_dumpMutex); if (s_dump.id != id || !s_dump.active || s_dump.state != "queued") return; }
			if (g_gs_renderer && !FileSystem::FileExists((base + ".gs").c_str()) && g_gs_renderer->QueueMCPDump(base, static_cast<u32>(frames))) return;
			std::lock_guard lock(s_dumpMutex);
			if (s_dump.id == id && s_dump.state == "queued")
			{ s_dump.state = "failed"; s_dump.reason = "renderer_busy_or_unavailable"; s_dump.active = false; s_dumpActive.store(false); s_dumpDeadline.store(0); }
		});
		return dumpStatus();
	}

	struct MediaOperation
	{
		std::string id, path, elf, state, reason;
		uint64_t session = 0, epoch = 0, frames = 0, maxFrames = 0, payload = 0, maxPayload = 0;
		u32 crc = 0, width = 0, height = 0;
		bool active = false, audio = true, error = false;
	};
	static MediaOperation s_media;
	static std::mutex s_mediaMutex;
	static std::atomic<bool> s_mediaActive{false};
	static std::atomic<int64_t> s_mediaDeadline{0};
	static std::atomic<uint64_t> s_mediaSequence{0};

	bool CaptureVideoFrameAllowed(const std::string& path)
	{
		if (!s_mediaActive.load()) return true;
		std::lock_guard lock(s_mediaMutex);
		if (s_media.path != path) return true;
		if (s_media.state != "recording" || s_media.frames >= s_media.maxFrames) return false;
		if (++s_media.frames == s_media.maxFrames)
		{ s_media.reason = "frame_limit"; s_media.state = "stopping"; s_mediaDeadline.store(steadyMillis()); }
		return true;
	}

	bool CapturePacketAllowed(const std::string& path, uint64_t bytes)
	{
		if (!s_mediaActive.load()) return true;
		std::lock_guard lock(s_mediaMutex);
		if (s_media.path != path) return true;
		if (s_media.error) return false;
		if (bytes > s_media.maxPayload - s_media.payload)
		{
			s_media.error = true; s_media.reason = "payload_limit"; s_media.state = "stopping";
			s_mediaDeadline.store(steadyMillis()); return false;
		}
		s_media.payload += bytes; return true;
	}

	void OnCaptureError(const std::string& path)
	{
		if (!s_mediaActive.load()) return;
		std::lock_guard lock(s_mediaMutex);
		if (!s_media.active || s_media.path != path) return;
		s_media.error = true;
		if (s_media.reason.empty()) s_media.reason = "encoder_error";
		s_mediaDeadline.store(steadyMillis());
	}

	void OnCaptureClosed(const std::string& path, bool complete)
	{
		if (!s_mediaActive.load()) return;
		std::lock_guard lock(s_mediaMutex);
		if (!s_media.active || s_media.path != path) return;
		if (s_media.reason == "vm_reset" || s_media.reason == "vm_stopped") s_media.state = "invalidated";
		else s_media.state = complete && !s_media.error && s_media.frames ? "closed" : "failed";
		if (s_media.reason.empty()) s_media.reason = complete ? "native_stopped" : "encoder_error";
		if (!s_media.frames && s_media.reason != "vm_reset" && s_media.reason != "vm_stopped") s_media.reason = "no_video_frames";
		s_media.active = false; s_mediaActive.store(false); s_mediaDeadline.store(0);
	}

	static void stopMedia(const std::string& reason)
	{
		std::string id, path;
		{
			std::lock_guard lock(s_mediaMutex);
			if (!s_media.active) return;
			if (s_media.reason.empty() || reason == "vm_reset" || reason == "vm_stopped") s_media.reason = reason;
			s_media.state = "stopping"; id = s_media.id; path = s_media.path; s_mediaDeadline.store(0);
		}
		MTGS::RunOnGSThread([id, path]() {
			// This API checks the filename under the encoder lock, never ends GUI work.
			GSCapture::EndMCPCapture(path);
			std::lock_guard lock(s_mediaMutex);
			if (s_media.id != id || !s_media.active) return;
			s_media.state = "failed"; s_media.reason = "capture_ownership_lost";
			s_media.active = false; s_mediaActive.store(false);
		});
	}

	static std::string mediaStatus()
	{
		std::lock_guard lock(s_mediaMutex);
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("operation_id", s_media.id);
		j.kv("state", s_media.state); j.kv("active", s_media.active); j.kv("reason", s_media.reason);
		j.kv("session", s_media.session); j.kv("execution_epoch", s_media.epoch); j.kv("elf", s_media.elf);
		j.key("elf_crc"); j.valHex32(s_media.crc); j.kv("path", s_media.path);
		j.kv("video", true); j.kv("audio", s_media.audio); j.kv("width", static_cast<uint64_t>(s_media.width)); j.kv("height", static_cast<uint64_t>(s_media.height));
		j.kv("video_frames", s_media.frames); j.kv("max_frames", s_media.maxFrames);
		j.kv("payload_bytes", s_media.payload); j.kv("max_payload_bytes", s_media.maxPayload);
		j.kv("container", "mp4"); j.endObject(); return j.str();
	}

	static std::string mediaCommand(const std::unordered_map<std::string, JsonValue>& params, const std::string& cmd)
	{
		const std::string id = getStr(params, "operation_id");
		if (id.size() != 32 || id.find_first_not_of("0123456789abcdef") != std::string::npos) return failure("Invalid media operation ID");
		if (cmd != "media_start")
		{
			{ std::lock_guard lock(s_mediaMutex); if (s_media.id != id) return failure("Unknown media operation"); }
			if (cmd == "media_stop") stopMedia("stopped");
			else if (s_mediaDeadline.load() && steadyMillis() >= s_mediaDeadline.load()) stopMedia("time_limit");
			return mediaStatus();
		}
		const auto frames = getNum(params, "frames", 120), timeout = getNum(params, "timeout_ms", 15000), maxPayload = getNum(params, "max_payload_bytes", 64 * 1024 * 1024);
		const auto width = getNum(params, "width", 640), height = getNum(params, "height", 480);
		const bool audio = getBool(params, "audio", true);
		if (frames < 1 || frames > 300 || timeout < 100 || timeout > 30000 || maxPayload < 1024 || maxPayload > 128 * 1024 * 1024 ||
			width < 64 || width > 1280 || height < 64 || height > 1024 || width % 8 || height % 8)
			return failure("Invalid capture frame/time/payload or resolution bounds");
		if (!MTGS::IsOpen() || (VMManager::GetState() != VMState::Running && VMManager::GetState() != VMState::Paused)) return failure("No active graphics renderer");
		if (s_step.active || s_operation.active) return failure("An execution operation is active");
#ifdef _WIN32
		const uint64_t process = GetCurrentProcessId();
#else
		const uint64_t process = getpid();
#endif
		if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
			getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
			getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
			getStr(params, "expected_elf") != VMManager::GetCurrentELF() || getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
			return failure("Media capture VM identity changed");
		const std::string directory = Path::Combine(EmuFolders::DataRoot, "mcp-media");
		const std::string path = Path::Combine(directory, id + ".mp4");
		{
			std::lock_guard lock(s_mediaMutex);
			if (s_media.active) return failure("A media capture is active or cleanup is pending");
			if (FileSystem::FileExists(path.c_str())) return failure("Capture file already exists");
			if (!FileSystem::CreateDirectoryPath(directory.c_str(), false)) return failure("Cannot create capture output directory");
			s_media = {}; s_media.id = id; s_media.path = path; s_media.elf = VMManager::GetCurrentELF(); s_media.crc = VMManager::GetCurrentCRC();
			s_media.session = s_session.load(); s_media.epoch = s_executionEpoch; s_media.maxFrames = frames; s_media.maxPayload = maxPayload;
			s_media.width = static_cast<u32>(width); s_media.height = static_cast<u32>(height); s_media.audio = audio; s_media.state = "queued"; s_media.active = true;
			++s_mediaSequence; s_mediaActive.store(true); s_mediaDeadline.store(steadyMillis() + timeout);
		}
		MTGS::RunOnGSThread([id, path, width, height, audio]() {
			{ std::lock_guard lock(s_mediaMutex); if (s_media.id != id || !s_media.active || s_media.state != "queued") return; }
			const bool started = g_gs_renderer && !GSCapture::IsCapturing() && !FileSystem::FileExists(path.c_str()) &&
				g_gs_renderer->BeginMCPCapture(path, GSVector2i(static_cast<int>(width), static_cast<int>(height)), audio);
			std::lock_guard lock(s_mediaMutex);
			if (s_media.id != id || !s_media.active) return;
			if (!started) { s_media.state = "failed"; s_media.reason = "encoder_start_failed_or_busy"; s_media.active = false; s_mediaActive.store(false); s_mediaDeadline.store(0); }
			else if (s_media.state == "queued") s_media.state = "recording";
		});
		return mediaStatus();
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
			if (activeChanges()) return failure("Memory change observers are active; finish or cancel them first");
			if (s_progress.state == "armed" && steadyMillis() >= s_progress.deadline)
			{ s_progress.state = "expired"; s_progressNext.store(0); }
			if (s_progress.state == "armed" || s_progress.state == "capturing") return failure("A progress watch is active; finish or cancel it first");
			const auto cpu = getStr(params, "cpu", "ee");
			if (cpu != "ee" && cpu != "iop") return failure("cpu must be ee or iop");
			const bool iop = cpu == "iop";
#ifdef _WIN32
			const uint64_t process = GetCurrentProcessId();
#else
			const uint64_t process = getpid();
#endif
			if (s_step.active || s_operation.active) return failure("An execution operation is active; finish or cancel it before arming");
			if (iop && (!CHECK_EEREC || psxCpu != &psxRec)) return failure("IOP exception watch requires EE and IOP recompilers");
			if (s_exception.state == "armed" && steadyMillis() >= s_exception.deadline) s_exception.state = "expired";
			if (s_exception.state == "armed" || s_exception.state == "capturing") return failure("An exception watch is already active");
			if (!VMManager::HasValidVM() || VMManager::GetCurrentELF().empty()) return failure("Boot an EE ELF before arming an exception watch");
			if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
				getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
				getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
				getStr(params, "expected_elf") != VMManager::GetCurrentELF() || getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
				return failure("Exception watch VM/ELF identity changed");
			if (iop && getNum(params, "expected_iop_reset_epoch", -1) != static_cast<int64_t>(s_iopResetEpoch))
				return failure("IOP reset epoch changed before arming");
			if (iop && getNum(params, "expected_iop_lifetime_epoch", -1) != static_cast<int64_t>(s_iopLifetimeEpoch)) return failure("IOP lifetime changed before arming");
			const auto mask = getNum(params, "exception_mask", 0), timeout = getNum(params, "timeout_ms", 30000);
			if (mask < 1 || mask > UINT32_MAX || timeout < 100 || timeout > 300000) return failure("Invalid exception mask or timeout (100-300000 ms)");
			s_exception = {}; s_exception.id = id; s_exception.sequence = ++s_exceptionSequence;
			s_exception.state = "armed"; s_exception.mask = static_cast<u32>(mask); s_exception.deadline = steadyMillis() + timeout;
			s_exception.session = s_session.load(); s_exception.epoch = s_executionEpoch;
			s_exception.iop = iop; s_exception.iopEpoch = s_iopResetEpoch;
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
		j.kv("cpu", s_exception.iop ? "iop" : "ee"); j.kv("iop_reset_epoch", s_exception.iopEpoch);
		j.kv("iop_reset_scope", "cpu_reset_only");
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
		if (g_InputRecording.isActive()) return failure("Stop input recording/replay before stepping");
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

	static std::string sifSnapshot(const std::unordered_map<std::string, JsonValue>& params)
	{
		if (!VMManager::HasValidVM() || VMManager::GetState() != VMState::Paused)
			return failure("Pause the active VM before reading SIF state");
#ifdef _WIN32
		const uint64_t process = GetCurrentProcessId();
#else
		const uint64_t process = getpid();
#endif
		if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
			getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
			getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
			getNum(params, "expected_iop_reset_epoch", -1) != static_cast<int64_t>(s_iopResetEpoch) ||
			getNum(params, "expected_iop_lifetime_epoch", -1) != static_cast<int64_t>(s_iopLifetimeEpoch) ||
			getStr(params, "expected_elf") != VMManager::GetCurrentELF() ||
			getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
			return failure("VM/ELF/IOP identity changed before SIF snapshot");
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("process_id", process);
		j.kv("session", s_session.load()); j.kv("execution_epoch", s_executionEpoch);
		j.kv("iop_reset_epoch", s_iopResetEpoch); j.kv("iop_lifetime_epoch", s_iopLifetimeEpoch);
		j.kv("elf", VMManager::GetCurrentELF()); j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC());
		j.kv("paused", true);
		auto hex = [&j](const char* key, u32 value) { j.key(key); j.valHex32(value); };
		j.key("sample"); j.startObject(); hex("ee_pc", cpuRegs.pc); hex("ee_cycles", cpuRegs.cycle);
		hex("iop_pc", psxRegs.pc); hex("iop_cycles", psxRegs.cycle); j.endObject();
		j.key("sbus"); j.startObject();
		hex("mscom", psHu32(SBUS_F200)); hex("smcom", psHu32(SBUS_F210));
		hex("msflg", psHu32(SBUS_F220)); hex("smflg", psHu32(SBUS_F230)); hex("f240", psHu32(SBUS_F240));
		hex("ee_intc_stat", psHu32(INTC_STAT)); hex("ee_intc_mask", psHu32(INTC_MASK));
		hex("ee_dmac_stat", dmacRegs.stat._u32);
		hex("iop_ireg", psxHu32(HW_IREG)); hex("iop_imask", psxHu32(HW_IMASK)); hex("iop_ictrl", psxHu32(HW_ICTRL)); j.endObject();
		j.key("channels"); j.startArray();
		const _sif* states[] = {&sif0, &sif1, &sif2};
		const DMACh* channels[] = {&sif0ch, &sif1ch, &sif2dma};
		const u32 iopBases[] = {0x1f801520, 0x1f801530, 0x1f8010a0};
		for (int i = 0; i < 3; ++i)
		{
			const auto& s = *states[i]; const auto& c = *channels[i]; const auto base = iopBases[i];
			j.startObject(); j.kv("sif", i); j.key("ee"); j.startObject();
			hex("chcr", c.chcr._u32); hex("madr", c.madr); hex("qwc", c.qwc); hex("tadr", c.tadr); j.endObject();
			j.key("iop_backing"); j.startObject(); hex("madr", psxHu32(base)); hex("bcr", psxHu32(base + 4));
			hex("chcr", psxHu32(base + 8)); hex("tadr", psxHu32(base + 12)); j.endObject();
			j.key("backend"); j.startObject(); j.kv("ee_busy", s.ee.busy); j.kv("ee_end", s.ee.end);
			j.kv("iop_busy", s.iop.busy); j.kv("iop_end", s.iop.end); j.kv("iop_counter", s.iop.counter);
			j.kv("fifo_words", s.fifo.size); j.kv("fifo_read_pos", s.fifo.readPos); j.kv("fifo_write_pos", s.fifo.writePos);
			j.endObject(); j.endObject();
		}
		j.endArray(); j.key("pgif"); j.startObject();
		hex("ctrl_backing", psHu32(PGIF_CTRL)); hex("stat_backing", psHu32(PGPU_STAT));
		auto fifo = [&j](const char* name, const ringBuf_t& f) { j.key(name); j.startObject(); j.kv("capacity", f.size);
			j.kv("words", f.count); j.kv("head", f.head); j.kv("tail", f.tail); j.endObject(); };
		fifo("data_fifo", rb_gp0); fifo("command_fifo", rb_gp1);
		j.kv("linked_list_active", dma.state.ll_active); j.kv("to_gpu_active", dma.state.to_gpu_active);
		j.kv("to_iop_active", dma.state.to_iop_active); j.endObject();
		j.key("writes"); j.startObject(); j.kv("capacity", 64); j.kv("observed", s_pgifWriteSequence);
		j.kv("dropped", s_pgifWriteSequence - s_pgifWrites.size()); j.key("entries"); j.startArray();
		for (const auto& e : s_pgifWrites)
		{
			j.startObject(); j.kv("sequence", e.sequence); j.kv("session", e.session); j.kv("execution_epoch", e.epoch);
			j.kv("iop_reset_epoch", e.resetEpoch); j.kv("iop_lifetime_epoch", e.lifetimeEpoch);
			hex("address", e.address); hex("value", e.value); j.kv("bits", e.bits);
			hex("word_before", e.before); hex("word_after", e.after); hex("raw_iop_pc", e.iopPC); hex("iop_cycles", e.iopCycles);
			j.endObject();
		}
		j.endArray(); j.endObject(); j.endObject(); return j.str();
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

	static bool movieOwned()
	{
		return g_InputRecording.isActive() && g_InputRecording.getData().getFilename() == s_movie.path;
	}

	static void finishMovie(const char* reason)
	{
		if (!s_movie.active) return;
		s_movie.reason = reason; s_movie.active = false; s_movieDeadline.store(0);
		// An unrelated GUI recording must survive even if ownership was lost.
		if (movieOwned())
		{
			// A manual interruption can occur between input polls. Keep its last
			// complete pad record in the file, but never call that completed playback.
			if (s_movie.mode == "record" && s_movie.pendingInput && !s_movie.ioError && g_InputRecording.getControls().isRecording())
				g_InputRecording.incFrameCounter();
			s_movie.pendingInput = false;
			s_movie.frame = g_InputRecording.getFrameCounter();
			// Reset while running must retain VMState::Running so upstream defers
			// the reset until the recompiler exits its current event handler.
			const std::string_view boundary(reason);
			if (boundary != "vm_reset" && boundary != "vm_stopped" && boundary != "savestate_load_attempt") VMManager::SetPaused(true);
			s_movie.state = g_InputRecording.stopOwnedMovie(s_movie.path) ? "closed" : "failed";
		}
		else { s_movie.state = "failed"; s_movie.reason = "ownership_lost"; }
		if (s_movie.mode == "replay") for (u8 i = 0; i < 2; ++i)
		{
			const auto& saved = s_movie.pads[i]; auto* pad = Pad::GetPad(i);
			if (!pad || pad != saved.savedPad || pad->GetType() != Pad::ControllerType::DualShock2) continue;
			for (u32 button = 0; button < 16; ++button)
				pad->SetRawPressureButton(button, {!(saved.savedButtons & (1u << s_buttonBits[button])), saved.savedPressures[button]});
			pad->SetRawAnalogs(saved.savedLeft, saved.savedRight);
		}
	}

	static std::string movieStatus()
	{
		if (s_movie.active && s_movieDeadline.load() && steadyMillis() >= s_movieDeadline.load()) finishMovie("time_limit");
		if (s_movie.active && !movieOwned()) finishMovie("ownership_lost");
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("operation_id", s_movie.id);
		j.kv("active", s_movie.active); j.kv("state", s_movie.state); j.kv("mode", s_movie.mode); j.kv("reason", s_movie.reason);
		j.kv("path", s_movie.path); j.kv("source", s_movie.source); j.kv("session", s_movie.session); j.kv("execution_epoch", s_movie.epoch);
		j.kv("elf", s_movie.elf); j.key("elf_crc"); j.valHex32(s_movie.crc); j.kv("elf_sha256", s_movie.elfSHA);
		j.kv("input_sha256", s_movie.movieSHA);
		j.kv("frames", s_movie.frame); j.kv("max_frames", s_movie.limit); j.kv("start", "power_on");
		j.kv("paused", VMManager::GetState() == VMState::Paused); j.endObject(); return j.str();
	}

	// v2.6.3 p2m2 v1: 561-byte strings/version, u32 frames, u32 undos,
	// one byte savestate flag, then two 18-byte pads per frame. Read-only source.
	static bool copyReplay(const std::string& source, const std::string& target, u32& frames)
	{
		const auto input = FileSystem::OpenManagedCFile(source.c_str(), "rb");
		if (!input) return false;
		std::vector<u8> bytes(570 + 36 * 600 + 1);
		const auto size = std::fread(bytes.data(), 1, bytes.size(), input.get());
		if (std::ferror(input.get()) || size < 570 || size == bytes.size() || bytes[0] != 1 || bytes[569] != 0 ||
			!std::memchr(bytes.data() + 1, 0, 50) || !std::memchr(bytes.data() + 51, 0, 255) || !std::memchr(bytes.data() + 306, 0, 255)) return false;
		frames = bytes[561] | (u32{bytes[562]} << 8) | (u32{bytes[563]} << 16) | (u32{bytes[564]} << 24);
		if (!frames || frames > 600 || size != 570 + 36 * frames) return false;
		const auto output = FileSystem::OpenManagedCFile(target.c_str(), "wbx");
		return output && std::fwrite(bytes.data(), 1, size, output.get()) == size && std::fflush(output.get()) == 0;
	}

	static std::string movieCommand(const std::unordered_map<std::string, JsonValue>& params, const std::string& cmd)
	{
		const auto id = getStr(params, "operation_id");
		if (id.size() != 32 || id.find_first_not_of("0123456789abcdef") != std::string::npos) return failure("Invalid input movie ID");
		if (cmd != "input_movie_start")
		{
			if (s_movie.id != id) return failure("Unknown or superseded input movie");
			if (cmd == "input_movie_stop") finishMovie("stopped");
			return movieStatus();
		}
		if (s_movie.active || g_InputRecording.isActive()) return failure("An input recording/replay is already active");
		if (s_step.active || s_operation.active) return failure("An execution operation is active");
		if (!VMManager::HasValidVM() || VMManager::GetState() != VMState::Paused || VMManager::GetCurrentELF().empty())
			return failure("Pause a booted ELF before starting an input movie");
		if (Achievements::IsHardcoreModeActive() || !EmuConfig.EnableRecordingTools)
			return failure("Enable recording tools and disable hardcore mode first");
#ifdef _WIN32
		const uint64_t process = GetCurrentProcessId();
#else
		const uint64_t process = getpid();
#endif
		if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
			getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
			getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
			getStr(params, "expected_elf") != VMManager::GetCurrentELF() || getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
			return failure("Input movie VM/ELF identity changed");
		const auto mode = getStr(params, "mode"), elfSHA = getStr(params, "elf_sha256"), movieSHA = getStr(params, "movie_sha256");
		const auto frames = getNum(params, "frames", 120), timeout = getNum(params, "timeout_ms", 15000);
		if ((mode != "record" && mode != "replay") || frames < 1 || frames > 600 || timeout < 100 || timeout > 30000 ||
			elfSHA.size() != 64 || elfSHA.find_first_not_of("0123456789abcdef") != std::string::npos)
			return failure("Invalid movie mode/hash or bounds (1-600 frames, 100-30000 ms)");
		if (mode == "replay" && (movieSHA.size() != 64 || movieSHA.find_first_not_of("0123456789abcdef") != std::string::npos))
			return failure("Replay requires its original movie SHA256");
		std::array<FrameOperation, 2> pads;
		for (u8 i = 0; i < 2; ++i)
		{
			auto* pad = Pad::GetPad(i);
			if (!pad || pad->GetType() != Pad::ControllerType::DualShock2) return failure("Both ports must be configured as DualShock2");
			pads[i].savedPad = pad; pads[i].savedButtons = pad->GetButtons();
			for (u32 button = 0; button < 16; ++button) pads[i].savedPressures[button] = pad->GetRawInput(button);
			pads[i].savedLeft = pad->GetRawLeftAnalog(); pads[i].savedRight = pad->GetRawRightAnalog();
		}
		const auto directory = Path::Combine(EmuFolders::DataRoot, "mcp-input");
		const auto path = Path::Combine(directory, id + ".p2m2"), source = getStr(params, "path");
		if (!FileSystem::CreateDirectoryPath(directory.c_str(), false) || FileSystem::FileExists(path.c_str())) return failure("Movie output is unavailable or already exists");
		u32 limit = static_cast<u32>(frames);
		if (mode == "replay" && (!Path::IsAbsolute(source) || source.size() > 4096 || !copyReplay(source, path, limit)))
			return failure("Expected a complete power-on p2m2 v1 with 1-600 frames; source was not opened for writing");
		g_InputRecording.processRecordQueue(); g_InputRecording.getControls().processControlQueue();
		s_movie = {}; s_movie.id = id; s_movie.mode = mode; s_movie.path = path; s_movie.source = mode == "replay" ? source : "";
		s_movie.elf = VMManager::GetCurrentELF(); s_movie.crc = VMManager::GetCurrentCRC(); s_movie.elfSHA = elfSHA;
		s_movie.movieSHA = mode == "replay" ? movieSHA : "";
		s_movie.session = s_session.load(); s_movie.limit = limit; s_movie.pads = pads;
		s_movie.active = s_movie.starting = true; s_movie.sequence = ++s_movieSequence;
		const bool started = mode == "record" ? g_InputRecording.create(path, false, "PCSX2 MCP") : g_InputRecording.play(path, true);
		s_movie.starting = false; s_movie.epoch = s_executionEpoch;
		if (!started) { s_movie.active = false; s_movie.state = "failed"; s_movie.reason = "start_failed"; }
		else { s_movie.state = "active"; s_movieDeadline.store(steadyMillis() + timeout); }
		return movieStatus();
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

	static void exceptionMemory(JsonBuilder& j, u32 address, u32 length, bool iop)
	{
		j.startObject(); j.key("address"); j.valHex32(address); j.kv("length", length);
		bool valid = static_cast<uint64_t>(address) + length <= (iop ? 0x00200000ULL : 0x02000000ULL);
		std::string hex;
		if (valid) for (u32 i = 0; i < length; ++i)
		{
			bool readable = false; const auto value = getCpu(iop ? "iop" : "ee")->read8(address + i, readable);
			if (!readable) { valid = false; break; }
			char encoded[3]; std::snprintf(encoded, sizeof(encoded), "%02x", value); hex += encoded;
		}
		j.kv("valid", valid); if (valid) j.kv("hex", hex); else j.kv("reason", "unavailable_or_excluded_RAM");
		j.endObject();
	}

	// Read the layout used by upstream BiosDebugData::getIOPModules, with bounded
	// valid reads and no live symbol database or guessed fixed BIOS list address.
	static std::string iopModuleSnapshot(u32 imageRecord = 0, uint64_t expectedRegistration = 0)
	{
		struct Module { u32 record, next, nameAddress, version, entry, gp, text, textSize, dataSize, bssSize, moduleId; std::string name; uint64_t generation = 0, registrationEpoch = 0; };
		std::vector<Module> modules;
		std::string reason;
		const u32 root = s_iopModuleRoot;
		u32 head = 0;
		auto word = [&](u32 address, u32& value) {
			if ((address & 3) || address > 0x00200000u - 4) return false;
			bool valid = false; value = r3000Debug.read32(address, valid); return valid;
		};
		if (!root) reason = "loadcore_list_not_located_since_reset";
		else if (!word(root, head)) reason = "list_root_unreadable_or_excluded";
		else
		{
			u32 current = head;
			while (current && reason.empty())
			{
				if (modules.size() >= 256) { reason = "module_limit_exceeded"; break; }
				if (std::any_of(modules.begin(), modules.end(), [&](const auto& m) { return m.record == current; }))
				{ reason = "module_list_cycle"; break; }
				Module m{}; m.record = current;
				if (current > 0x00200000u - 40 || !word(current, m.next) || !word(current + 4, m.nameAddress) ||
					!word(current + 8, m.version) || !word(current + 12, m.moduleId) || !word(current + 0x10, m.entry) || !word(current + 0x14, m.gp) ||
					!word(current + 0x18, m.text) || !word(current + 0x1c, m.textSize) ||
					!word(current + 0x20, m.dataSize) || !word(current + 0x24, m.bssSize))
				{ reason = "module_record_unreadable_or_excluded"; break; }
				m.version &= 0xffff;
				m.moduleId &= 0xffff;
				if (auto it = s_registrations.find(current); it != s_registrations.end())
				{
					auto& observed = it->second;
					const std::array<u32, 6> metadata{m.entry, m.gp, m.text, m.textSize, m.dataSize, m.bssSize};
					if (observed.metadata != metadata || observed.nameAddress != m.nameAddress || observed.version != m.version ||
						(observed.sealed && observed.moduleId != m.moduleId)) s_registrations.erase(it);
					else { observed.sealed = true; observed.moduleId = m.moduleId; m.generation = observed.sequence; m.registrationEpoch = observed.epoch; }
				}
				if (m.nameAddress)
				{
					bool terminated = false;
					for (u32 offset = 0; offset < 128; ++offset)
					{
						const uint64_t address = static_cast<uint64_t>(m.nameAddress) + offset;
						const u32 physical = static_cast<u32>(address) & 0x1fffffff;
						const bool ram = address < 0x00200000;
						const bool rom = address <= UINT32_MAX && physical >= 0x1fc00000 && physical < 0x20000000 &&
							(address < 0x20000000 || (address >= 0x9fc00000 && address < 0xa0000000) || (address >= 0xbfc00000 && address < 0xc0000000));
						if (!ram && !rom) { reason = "module_name_unreadable_or_excluded"; break; }
						bool valid = false; const auto c = r3000Debug.read8(static_cast<u32>(address), valid);
						if (!valid) { reason = "module_name_unreadable_or_excluded"; break; }
						if (!c) { terminated = true; break; }
						if (c < 32 || c > 126) { reason = "module_name_encoding_unsupported"; break; }
						m.name += static_cast<char>(c);
					}
					if (reason.empty() && !terminated) reason = "module_name_limit_exceeded";
				}
				modules.push_back(std::move(m)); current = modules.back().next;
			}
		}
		if (!reason.empty()) s_registrations.clear();
		else for (auto it = s_registrations.begin(); it != s_registrations.end(); )
		{
			if (std::none_of(modules.begin(), modules.end(), [&](const auto& m) { return m.record == it->first; })) it = s_registrations.erase(it);
			else ++it;
		}
		const Module* imageModule = nullptr;
		if (imageRecord)
		{
			if (!reason.empty()) return failure("IOP module image requires a complete observed table");
			for (const auto& m : modules) if (m.record == imageRecord) imageModule = &m;
			if (!imageModule) return failure("IOP module record is no longer observed");
			if (expectedRegistration && imageModule->generation != expectedRegistration) return failure("IOP observed registration generation changed or unavailable");
			const uint64_t size = static_cast<uint64_t>(imageModule->textSize) + imageModule->dataSize;
			if (!size || size > 256 * 1024 || (imageModule->text & 3) ||
				static_cast<uint64_t>(imageModule->text) + size + imageModule->bssSize > 0x00200000)
				return failure("IOP module image exceeds bounded canonical RAM");
		}
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("cpu", "iop");
		j.kv("snapshot_id", ++s_iopModuleSnapshot); j.kv("timestamp_ms", timestampMillis());
		j.kv("session", s_session.load()); j.kv("execution_epoch", s_executionEpoch); j.kv("iop_reset_epoch", s_iopResetEpoch);
		j.kv("iop_lifetime_epoch", s_iopLifetimeEpoch);
		j.kv("iop_reset_scope", "cpu_reset_only"); j.kv("revision", s_inspectionRevision);
		j.kv("elf", VMManager::GetCurrentELF()); j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC());
		j.kv("elf_role", "ee_boot_affinity_only"); j.kv("scope", "paused_runtime_observation_only");
		j.kv("source", "pcsx2_detected_loadcore_list"); j.kv("root_discovery_sequence", s_iopModuleDiscovery);
		j.key("list_address"); j.valHex32(root); j.key("head_address"); j.valHex32(head);
		j.kv("status", reason.empty() ? "observed" : "unavailable");
		j.key("reason"); if (reason.empty()) j.valJson("null"); else j.valStr(reason);
		j.key("modules"); j.startArray();
		if (reason.empty()) for (const auto& m : modules)
		{
			j.startObject(); j.key("record_address"); j.valHex32(m.record); j.key("next_address"); j.valHex32(m.next);
			j.key("name_address"); j.valHex32(m.nameAddress); j.key("name"); if (m.nameAddress) j.valStr(m.name); else j.valJson("null");
			j.kv("version", m.version); j.key("entry"); j.valHex32(m.entry); j.key("gp"); j.valHex32(m.gp);
			j.kv("module_id", m.moduleId); j.key("observed_generation");
			if (m.generation) { j.startObject(); j.kv("scope", "observed_loadcore_registration"); j.kv("namespace", s_registrationNamespace); j.kv("sequence", m.generation); j.kv("registration_epoch", m.registrationEpoch); j.kv("module_id", m.moduleId); j.endObject(); }
			else j.valJson("null");
			j.key("text_address"); j.valHex32(m.text); j.kv("text_size", m.textSize); j.kv("data_size", m.dataSize); j.kv("bss_size", m.bssSize);
			j.endObject();
		}
		j.endArray();
		if (imageModule)
		{
			j.key("image_record"); j.valHex32(imageRecord); j.key("sample_pc"); j.valHex32(r3000Debug.getPC());
			j.key("module_image"); exceptionMemory(j, imageModule->text, imageModule->textSize + imageModule->dataSize, true);
		}
		j.endObject(); return j.str();
	}

	static std::string guardedIopModules(const std::unordered_map<std::string, JsonValue>& params, bool image = false)
	{
		if (!VMManager::HasValidVM() || VMManager::GetState() != VMState::Paused || s_step.active || s_operation.active)
			return failure("IOP module snapshot requires a paused VM without active execution operation");
#ifdef _WIN32
		const uint64_t process = GetCurrentProcessId();
#else
		const uint64_t process = getpid();
#endif
		if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
			getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
			getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
			getNum(params, "expected_iop_reset_epoch", -1) != static_cast<int64_t>(s_iopResetEpoch) ||
			getStr(params, "expected_elf") != VMManager::GetCurrentELF() || getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
			return failure("IOP module snapshot VM/ELF/reset identity changed");
		if (getNum(params, "expected_iop_lifetime_epoch", -1) != static_cast<int64_t>(s_iopLifetimeEpoch))
			return failure("IOP module lifetime epoch changed");
		if (!image) return iopModuleSnapshot();
		const auto record = getNum(params, "module_record", -1);
		if (record <= 0 || record > 0x00200000 - 40 || (record & 3) ||
			getNum(params, "expected_revision", -1) != static_cast<int64_t>(s_inspectionRevision))
			return failure("IOP module image pause revision or record changed");
		const auto generation = getNum(params, "expected_registration_sequence", 0);
		if (generation < 0) return failure("Invalid observed registration generation");
		if (generation && getStr(params, "expected_registration_namespace") != s_registrationNamespace) return failure("IOP observed registration generation namespace changed");
		return iopModuleSnapshot(static_cast<u32>(record), static_cast<uint64_t>(generation));
	}

	static void finalizeException(uint64_t sequence)
	{
		if (s_exception.sequence != sequence || s_exception.state != "capturing") return;
		s_exceptionPending.store(0);
		DebugInterface* cpu = getCpu(s_exception.iop ? "iop" : "ee");
		bool matches = VMManager::GetState() == VMState::Paused && s_exception.session == s_session.load() &&
			s_exception.epoch == s_executionEpoch && s_exception.elf == VMManager::GetCurrentELF() &&
			s_exception.crc == VMManager::GetCurrentCRC() && s_exception.revision == s_inspectionRevision && s_exception.postPC == cpu->getPC() &&
			(!s_exception.iop || s_exception.iopEpoch == s_iopResetEpoch);
		for (int i = 0; matches && i < 32; ++i)
		{
			const auto current = cpu->getRegister(0, i);
			matches = std::memcmp(&s_exception.gpr[i], &current, sizeof(u128)) == 0;
			if (matches && s_exception.iop) matches = s_exception.cp0[i] == psxRegs.CP0.r[i];
		}
		if (matches && s_exception.iop) matches = s_exception.hi == psxRegs.GPR.n.hi && s_exception.lo == psxRegs.GPR.n.lo;
		JsonBuilder j; j.startObject(); j.kv("watch_id", s_exception.id); j.kv("cpu", s_exception.iop ? "iop" : "ee");
		j.kv("iop_reset_epoch", s_exception.iopEpoch);
		j.kv("iop_reset_scope", "cpu_reset_only");
		j.kv("elf_role", s_exception.iop ? "ee_boot_affinity_only" : "ee_executable");
		if (s_exception.iop) { j.key("module_identity"); j.valJson("null"); }
		j.kv("timestamp_ms", s_exception.timestamp); j.kv("session", s_exception.session); j.kv("execution_epoch", s_exception.epoch);
		j.kv("elf", s_exception.elf); j.key("elf_crc"); j.valHex32(s_exception.crc); j.kv("context_matches_stop", matches);
		j.kv("screenshot_requested", s_exception.screenshot);
		j.key("core"); j.startObject(); j.key("exception_pc"); j.valHex32(s_exception.exceptionPC);
		j.key("post_exception_pc"); j.valHex32(s_exception.postPC); j.key("raw_code"); j.valHex32(s_exception.code);
		j.kv("exception_code", (s_exception.code >> 2) & 31); j.kv("requested_branch_delay", s_exception.branchDelay);
		j.key("previous_exl"); if (s_exception.iop) j.valJson("null"); else j.valBool(s_exception.nested);
		if (s_exception.iop)
		{
			j.key("previous_status"); j.valHex32(s_exception.previousStatus);
			j.key("hi"); j.valHex32(s_exception.hi); j.key("lo"); j.valHex32(s_exception.lo);
		}
		for (const auto [name, reg] : {std::pair{"cause", 13}, {"epc", 14}, {"bad_vaddr", 8}, {"status", 12}})
		{ j.key(name); j.valHex32(s_exception.cp0[reg]); }
		j.kv("bad_vaddr_relevant", ((s_exception.code >> 2) & 31) >= 1 && ((s_exception.code >> 2) & 31) <= 5);
		j.key("instruction");
		if (s_exception.instruction.active)
		{
			const bool syscall = ((s_exception.code >> 2) & 31) == 8;
			j.startObject(); j.kv("source", s_exception.iop ?
				(syscall ? "iop_recompiler_syscall" : "iop_recompiler_break") :
				(syscall ? "ee_recompiler_syscall" : "ee_recompiler_break"));
			j.key("pc"); j.valHex32(s_exception.instruction.pc);
			j.key("opcode"); j.valHex32(s_exception.instruction.opcode);
			j.kv("branch_delay", s_exception.instruction.branchDelay);
			j.kv("opcode_matches_memory", s_exception.instruction.opcodeMatchesMemory); j.endObject();
		}
		else j.valJson("null");
		j.key("gpr"); j.startArray(); for (const auto& reg : s_exception.gpr) j.valHex128(reg); j.endArray();
		j.key("cp0"); j.startArray(); for (u32 reg : s_exception.cp0) j.valHex32(reg); j.endArray(); j.endObject();
		const std::string corePrefix = j.str();
		if (s_exception.iop && matches) { j.key("module_observation"); j.valJson(iopModuleSnapshot()); }
		j.key("memory"); j.startObject();
		if (matches)
		{
			j.key("code"); exceptionMemory(j, s_exception.exceptionPC >= 16 ? s_exception.exceptionPC - 16 : s_exception.exceptionPC, 64, s_exception.iop);
			j.key("stack"); exceptionMemory(j, s_exception.gpr[29]._u32[0], 256, s_exception.iop);
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
			params["cpu"].strVal = s_exception.iop ? "iop" : "ee";
			params["skip_screenshot"].type = JsonValue::BOOL; params["skip_screenshot"].boolVal = !s_exception.screenshot;
			j.valJson(captureContext(params));
		}
		else j.valJson(failure("Paused state changed before deferred capture; only exception core is retained"));
		j.endObject(); s_exception.report = j.str();
		if (s_exception.report.size() > 3 * 1024 * 1024)
			s_exception.report = corePrefix + ",\"memory\":{},\"context\":" + failure("Extended capture exceeded 3 MiB limit; exception core retained") + "}";
		s_exception.state = "captured";
	}

	static void progressCriterion(JsonBuilder& j)
	{
		j.startObject(); j.key("heartbeat_address"); j.valHex32(s_progress.address);
		j.key("heartbeat_mask"); j.valHex32(s_progress.mask);
		j.kv("sample_interval_ms", s_progress.interval); j.kv("stall_ms", s_progress.threshold);
		j.kv("max_sample_gap_ms", s_progress.interval * 4); j.kv("max_samples", static_cast<int>(s_progress.limit));
		j.key("active_address"); if (s_progress.gated) j.valHex32(s_progress.gateAddress); else j.valJson("null");
		j.key("active_mask"); j.valHex32(s_progress.gateMask); j.key("active_value"); j.valHex32(s_progress.gateValue);
		j.endObject();
	}

	static void captureProgress()
	{
		s_progress.state = "capturing"; s_progressNext.store(0);
		VMManager::SetPaused(true);
		const u32 pc = cpuRegs.pc, cycles = cpuRegs.cycle;
		const auto revision = s_inspectionRevision;
		recordEvent("progress_stall", "ee", pc, s_progress.id);
		JsonBuilder j; j.startObject(); j.kv("watch_id", s_progress.id); j.kv("cpu", "ee");
		j.kv("observation", "configured_heartbeat_stall"); j.kv("timestamp_ms", timestampMillis());
		j.kv("session", s_progress.session); j.kv("execution_epoch", s_progress.epoch);
		j.kv("elf", s_progress.elf); j.key("elf_crc"); j.valHex32(s_progress.crc);
		j.key("criterion"); progressCriterion(j); j.kv("unchanged_ms", s_progress.unchanged);
		j.kv("unchanged_intervals", s_progress.unchangedIntervals);
		j.key("stop_pc"); j.valHex32(pc); j.key("stop_cycles"); j.valHex32(cycles);
		j.kv("screenshot_requested", s_progress.screenshot); j.kv("total_samples", s_progress.total);
		j.kv("samples_dropped", s_progress.total - s_progress.samples.size());
		j.key("samples"); j.startArray();
		for (const auto& sample : s_progress.samples)
		{
			j.startObject(); j.kv("timestamp_ms", sample.timestamp); j.kv("elapsed_ms", sample.elapsed);
			j.key("pc"); j.valHex32(sample.pc); j.key("cycles"); j.valHex32(sample.cycles);
			j.key("heartbeat"); if (sample.valid) j.valHex32(sample.heartbeat); else j.valJson("null");
			j.key("active_value"); if (sample.gateValid) j.valHex32(sample.gate); else j.valJson("null");
			j.kv("phase", sample.phase); j.endObject();
		}
		j.endArray(); const auto prefix = j.str();
		const auto context = captureContext(parseJsonObject(std::string("{\"cpu\":\"ee\",\"width\":640,\"height\":480,\"skip_screenshot\":") +
			(s_progress.screenshot ? "false}" : "true}")));
		const bool matches = VMManager::GetState() == VMState::Paused && s_executionEpoch == s_progress.epoch &&
			s_inspectionRevision == revision && cpuRegs.pc == pc && cpuRegs.cycle == cycles &&
			VMManager::GetCurrentELF() == s_progress.elf && VMManager::GetCurrentCRC() == s_progress.crc;
		j.kv("context_matches_stop", matches); j.key("memory"); j.startObject();
		if (matches)
		{
			j.key("code"); exceptionMemory(j, pc >= 16 ? pc - 16 : 0, 64, false);
			j.key("stack"); exceptionMemory(j, cpuRegs.GPR.n.sp.UL[0], 256, false);
		}
		j.endObject(); uint64_t after;
		{ std::lock_guard lock(s_historyMutex); after = s_eventSequence > 32 ? s_eventSequence - 32 : 0; }
		const auto events = readHistory(true, after, 32);
		j.key("events"); j.valJson(events); j.key("context");
		j.valJson(matches ? context : failure("Paused state changed during progress capture")); j.endObject();
		s_progress.report = j.str();
		if (s_progress.report.size() > 3 * 1024 * 1024)
			s_progress.report = prefix + ",\"context_matches_stop\":false,\"memory\":{},\"events\":" + events +
				",\"context\":" + failure("Progress report exceeded 3 MiB") + "}";
		s_progress.state = "captured";
	}

	static void sampleProgress()
	{
		if (s_progress.state != "armed") return;
		const auto now = steadyMillis();
		if (now >= s_progress.deadline) { s_progress.state = "expired"; s_progressNext.store(0); return; }
		if (!VMManager::HasValidVM() || s_progress.epoch != s_executionEpoch ||
			s_progress.elf != VMManager::GetCurrentELF() || s_progress.crc != VMManager::GetCurrentCRC())
		{ s_progress.state = "vm_changed"; s_progressNext.store(0); return; }
		ProgressSample sample; sample.timestamp = timestampMillis(); sample.elapsed = now - s_progress.start;
		sample.pc = cpuRegs.pc; sample.cycles = cpuRegs.cycle;
		if (VMManager::GetState() != VMState::Running) sample.phase = "paused";
		else if (s_step.active || s_operation.active) sample.phase = "execution_operation";
		else
		{
			sample.heartbeat = r5900Debug.read32(s_progress.address, sample.valid) & s_progress.mask;
			if (s_progress.gated) sample.gate = r5900Debug.read32(s_progress.gateAddress, sample.gateValid) & s_progress.gateMask;
			if (!sample.valid || (s_progress.gated && !sample.gateValid)) sample.phase = "unreadable";
			else if (s_progress.gated && sample.gate != s_progress.gateValue) sample.phase = "expected_wait";
			else if (!s_progress.baseline) sample.phase = "baseline";
			else
			{
				const auto& previous = s_progress.samples.back();
				const auto gap = sample.elapsed - previous.elapsed;
				if (gap > s_progress.interval * 4) sample.phase = "sampling_gap";
				else if (sample.cycles == previous.cycles) sample.phase = "cycles_not_advanced";
				else if (sample.heartbeat != previous.heartbeat) sample.phase = "progress";
				else { sample.phase = "unchanged"; s_progress.unchanged += gap; ++s_progress.unchangedIntervals; }
			}
		}
		if (sample.phase != "unchanged") { s_progress.unchanged = 0; s_progress.unchangedIntervals = 0; }
		s_progress.baseline = sample.phase == "baseline" || sample.phase == "progress" || sample.phase == "unchanged";
		s_progress.samples.push_back(sample); ++s_progress.total;
		if (s_progress.samples.size() > s_progress.limit) s_progress.samples.pop_front();
		if (sample.phase == "unreadable") { s_progress.state = "memory_unavailable"; s_progressNext.store(0); }
		else if (s_progress.unchanged >= s_progress.threshold && s_progress.unchangedIntervals >= 3) captureProgress();
		else s_progressNext.store(now + s_progress.interval);
	}

	static std::string progressWatch(const std::unordered_map<std::string, JsonValue>& params, const std::string& cmd)
	{
		const auto id = getStr(params, "watch_id");
		if (id.size() != 32 || !std::all_of(id.begin(), id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }))
			return failure("Invalid progress watch ID");
		if (cmd == "progress_watch_start")
		{
			if (activeChanges()) return failure("Memory change observers are active; finish or cancel them first");
			if (s_progress.state == "armed" && steadyMillis() >= s_progress.deadline)
			{ s_progress.state = "expired"; s_progressNext.store(0); }
			if (s_exception.state == "armed" && steadyMillis() >= s_exception.deadline)
			{ s_exception.state = "expired"; s_exceptionDeadline.store(0); }
			if (s_progress.state == "armed" || s_progress.state == "capturing" || s_exception.state == "armed" || s_exception.state == "capturing" || s_step.active || s_operation.active)
				return failure("A watch or execution operation is already active");
#ifdef _WIN32
			const uint64_t process = GetCurrentProcessId();
#else
			const uint64_t process = getpid();
#endif
			if (!CHECK_EEREC || !VMManager::HasValidVM() || VMManager::GetCurrentELF().empty()) return failure("Progress watch requires a booted EE ELF and EE recompiler");
			if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) ||
				getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
				getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) ||
				getStr(params, "expected_elf") != VMManager::GetCurrentELF() || getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC())
				return failure("Progress watch VM/ELF identity changed");
			const auto address = getNum(params, "heartbeat_address", -1), mask = getNum(params, "heartbeat_mask", UINT32_MAX);
			const auto gate = getNum(params, "active_address", -1), gateMask = getNum(params, "active_mask", UINT32_MAX), gateValue = getNum(params, "active_value", 1);
			const auto interval = getNum(params, "sample_interval_ms", 100), threshold = getNum(params, "stall_ms", 1000);
			const auto timeout = getNum(params, "timeout_ms", 30000), limit = getNum(params, "max_samples", 64);
			auto canonical = [](int64_t value) { return value >= 0 && value <= 0x02000000 - 4 && !(value & 3); };
			if (!canonical(address) || (gate != -1 && !canonical(gate)) || mask < 1 || mask > UINT32_MAX ||
				gateMask < 1 || gateMask > UINT32_MAX || gateValue < 0 || gateValue > UINT32_MAX || (gateValue & ~gateMask) ||
				interval < 50 || interval > 1000 || threshold < interval * 3 || threshold > 60000 ||
				timeout < 100 || timeout > 300000 || limit < 8 || limit > 64) return failure("Invalid progress criterion or bounds");
			s_progress = {}; s_progress.id = id; s_progress.state = "armed"; s_progress.sequence = ++s_progressSequence;
			s_progress.session = s_session.load(); s_progress.epoch = s_executionEpoch;
			s_progress.elf = VMManager::GetCurrentELF(); s_progress.crc = VMManager::GetCurrentCRC();
			s_progress.address = static_cast<u32>(address); s_progress.mask = static_cast<u32>(mask);
			s_progress.gated = gate != -1; s_progress.gateAddress = static_cast<u32>(gate); s_progress.gateMask = static_cast<u32>(gateMask); s_progress.gateValue = static_cast<u32>(gateValue);
			s_progress.interval = interval; s_progress.threshold = threshold; s_progress.limit = static_cast<size_t>(limit);
			s_progress.start = steadyMillis(); s_progress.deadline = s_progress.start + timeout;
			s_progress.screenshot = getBool(params, "screenshot", true);
			s_progressWatchId.store(s_progress.sequence); s_progressNext.store(s_progress.start + interval);
		}
		else
		{
			if (s_progress.id != id) return failure("Unknown or superseded progress watch");
			if (s_progress.state == "armed" && (cmd == "progress_watch_cancel" || steadyMillis() >= s_progress.deadline))
			{ s_progress.state = cmd == "progress_watch_cancel" ? "cancelled" : "expired"; s_progressNext.store(0); }
		}
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("watch_id", id); j.kv("cpu", "ee");
		j.kv("state", s_progress.state); j.kv("active", s_progress.state == "armed" || s_progress.state == "capturing");
		j.kv("session", s_progress.session); j.kv("execution_epoch", s_progress.epoch);
		j.kv("elf", s_progress.elf); j.key("elf_crc"); j.valHex32(s_progress.crc);
		j.key("criterion"); progressCriterion(j); j.kv("unchanged_ms", s_progress.unchanged); j.kv("total_samples", s_progress.total);
		j.key("report"); j.valJson(s_progress.report.empty() ? "null" : s_progress.report); j.endObject(); return j.str();
	}

	static std::string lifetimeReport()
	{
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("session", s_session.load());
		j.kv("execution_epoch", s_executionEpoch); j.kv("iop_reset_epoch", s_iopResetEpoch);
		j.kv("iop_lifetime_epoch", s_iopLifetimeEpoch); j.kv("scope", "observed_boundaries_only");
		j.kv("elf", VMManager::GetCurrentELF()); j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC());
		j.key("list_address"); j.valHex32(s_iopModuleRoot);
		j.kv("history_truncated", s_lifetimeTruncated);
		j.key("events"); j.startArray();
		for (const auto& e : s_lifetime) { j.startObject(); j.kv("epoch", e.epoch); j.kv("timestamp_ms", e.timestamp); j.kv("kind", e.kind); j.key("address"); j.valHex32(e.address); j.endObject(); }
		j.endArray(); j.endObject(); return j.str();
	}

	static std::string loadWatchCommand(const std::unordered_map<std::string, JsonValue>& params, const std::string& cmd)
	{
		if (loadActive() && steadyMillis() >= s_load.deadline) invalidateLoad("expired");
		const auto id = getStr(params, "watch_id");
		auto hexString = [](const std::string& s, size_t length) { return s.size() == length && std::all_of(s.begin(), s.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }); };
		if (!hexString(id, 32)) return failure("Invalid IOP load watch ID");
		if (cmd == "iop_load_start")
		{
			if (loadActive()) return failure("An IOP load watch is already active");
#ifdef _WIN32
			const uint64_t process = GetCurrentProcessId();
#else
			const uint64_t process = getpid();
#endif
			if (!VMManager::HasValidVM() || VMManager::GetCurrentELF().empty() || s_step.active || s_operation.active)
				return failure("IOP load watch requires a booted ELF without an execution operation");
			if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) || getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
				getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) || getNum(params, "expected_iop_reset_epoch", -1) != static_cast<int64_t>(s_iopResetEpoch) ||
				getStr(params, "expected_elf") != VMManager::GetCurrentELF() || getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC()) return failure("IOP load watch identity changed");
			if (getNum(params, "expected_iop_lifetime_epoch", -1) != static_cast<int64_t>(s_iopLifetimeEpoch)) return failure("IOP load watch lifetime epoch changed");
			const auto path = getStr(params, "path"), sha = getStr(params, "sha256"), prefix = getStr(params, "prefix");
			const auto size = getNum(params, "size", -1), timeout = getNum(params, "timeout_ms", 30000);
			if (!Path::IsAbsolute(path) || path.size() > 4096 || std::any_of(path.begin(), path.end(), [](unsigned char c) { return c < 32; }) || !hexString(sha, 64) || !hexString(prefix, 128) ||
				size < 64 || size > 1024 * 1024 || timeout < 100 || timeout > 300000) return failure("Invalid IOP load artifact/bounds");
			s_load = {}; s_load.id = id; s_load.state = "armed"; s_load.path = Path::Canonicalize(path); s_load.sha = sha; s_load.size = static_cast<u32>(size);
			s_load.session = s_session.load(); s_load.epoch = s_executionEpoch; s_load.iopEpoch = s_iopResetEpoch; s_load.lifetimeEpoch = s_iopLifetimeEpoch;
			s_load.elf = VMManager::GetCurrentELF(); s_load.crc = VMManager::GetCurrentCRC(); s_load.sequence = ++s_loadSequence;
			for (size_t i = 0; i < 64; ++i) s_load.prefix[i] = static_cast<u8>(std::stoul(prefix.substr(i * 2, 2), nullptr, 16));
			s_load.deadline = steadyMillis() + timeout; s_loadId.store(s_load.sequence); s_loadDeadline.store(s_load.deadline);
		}
		else
		{
			if (id != s_load.id) return failure("Unknown or superseded IOP load watch");
			if (cmd == "iop_load_cancel" && loadActive()) invalidateLoad("cancelled");
		}
		JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("watch_id", s_load.id); j.kv("state", s_load.state); j.kv("active", loadActive());
		j.kv("session", s_load.session); j.kv("execution_epoch", s_load.epoch); j.kv("iop_reset_epoch", s_load.iopEpoch); j.kv("elf", s_load.elf); j.key("elf_crc"); j.valHex32(s_load.crc);
		j.kv("path", s_load.path); j.kv("expected_sha256", s_load.sha); j.kv("size", s_load.size); j.kv("covered_bytes", s_load.coverage); j.kv("read_count", s_load.reads);
		j.kv("file_closed", s_load.fileClosed);
		j.kv("iop_lifetime_epoch", s_load.lifetimeEpoch);
		j.kv("binding_available", s_load.binding && s_load.registrationRevision != 0 && s_load.registrationRevision == s_inspectionRevision && VMManager::GetState() == VMState::Paused);
		j.kv("binding_reason", s_load.bindingReason); j.kv("binding_revision", s_load.registrationRevision);
		j.key("buffer_address"); j.valHex32(s_load.buffer); j.key("file_info_address"); j.valHex32(s_load.fileInfo); j.key("module_record"); j.valHex32(s_load.record);
		j.key("loader_sample_pc"); j.valHex32(s_load.loaderPC); j.kv("buffer_timestamp_ms", s_load.bufferTimestamp); j.kv("registration_timestamp_ms", s_load.registrationTimestamp);
		j.key("file_info"); j.startArray(); for (u32 v : s_load.info) j.valHex32(v); j.endArray();
		j.key("source_bytes_base64"); if (s_load.state == "registered") j.valStr(encodeBase64(s_load.bytes)); else j.valJson("null");
		j.endObject(); return j.str();
	}

	static void scheduleChanges()
	{
		int64_t due = 0;
		for (const auto& w : s_changes) if (w.state == "armed")
		{
			const auto next = std::min(w.next, w.deadline);
			if (!due || next < due) due = next;
		}
		s_changeNext.store(due);
	}

	static void invalidateChanges(const char* reason, bool iopOnly = false)
	{
		for (auto& w : s_changes) if (w.state == "armed" && (!iopOnly || w.iop)) w.state = reason;
		scheduleChanges();
	}

	static void sampleChanges()
	{
		const auto now = steadyMillis();
		for (auto& w : s_changes)
		{
			if (w.state != "armed") continue;
			if (now >= w.deadline) { w.state = "expired"; continue; }
			if (!VMManager::HasValidVM() || w.epoch != s_executionEpoch || w.elf != VMManager::GetCurrentELF() || w.crc != VMManager::GetCurrentCRC())
			{ w.state = "vm_changed"; continue; }
			if (w.iop && w.iopEpoch != s_iopResetEpoch) { w.state = "cpu_reset"; continue; }
			if (now < w.next) continue;
			w.next = now + w.interval;
			if (VMManager::GetState() != VMState::Running || s_step.active || s_operation.active)
			{ w.baseline = false; continue; }
			const auto began = std::chrono::steady_clock::now();
			DebugInterface* cpu = w.iop ? static_cast<DebugInterface*>(&r3000Debug) : &r5900Debug;
			bool valid = false;
			ChangeSample current; current.elapsed = now - w.start; current.timestamp = timestampMillis();
			current.pc = cpu->getPC(); current.cycles = w.iop ? psxRegs.cycle : cpuRegs.cycle;
			current.raw = w.size == 1 ? cpu->read8(w.address, valid) : w.size == 2 ? cpu->read16(w.address, valid) : cpu->read32(w.address, valid);
			++w.samples;
			const auto gap = current.elapsed - w.current.elapsed;
			const bool comparable = w.baseline && w.revision == s_inspectionRevision && gap > 0 && gap <= w.interval * 4 && current.cycles != w.current.cycles;
			const bool changed = valid && comparable && (current.raw & w.mask) != (w.current.raw & w.mask);
			if (valid && !comparable) ++w.rebases;
			w.previous = w.current; w.current = current; w.revision = s_inspectionRevision; w.baseline = valid;
			w.samplingNs += std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - began).count();
			if (!valid) w.state = "memory_unavailable";
			else if (changed)
			{
				w.state = "changed"; // Freeze before pausing, which rebases other armed observers.
				recordEvent("memory_change", w.iop ? "iop" : "ee", current.pc, w.id);
				if (w.pause) VMManager::SetPaused(true);
			}
		}
		scheduleChanges();
	}

	static void changeState(JsonBuilder& j, const ChangeWatch& w)
	{
		j.startObject(); j.kv("ok", true); j.kv("watch_id", w.id); j.kv("state", w.state); j.kv("active", w.state == "armed");
		j.kv("cpu", w.iop ? "iop" : "ee"); j.kv("session", w.session); j.kv("execution_epoch", w.epoch); j.kv("iop_reset_epoch", w.iopEpoch);
		j.kv("elf", w.elf); j.key("elf_crc"); j.valHex32(w.crc);
		j.key("address"); j.valHex32(w.address); j.kv("size", w.size); j.key("mask"); j.valHex32(w.mask);
		j.kv("sample_interval_ms", w.interval); j.kv("timeout_ms", w.deadline - w.start); j.kv("pause_on_change", w.pause);
		j.kv("total_samples", w.samples); j.kv("baseline_count", w.rebases); j.kv("sampling_cpu_ns", w.samplingNs);
		j.kv("observation", "sampled_memory_change"); j.key("writer_pc"); j.valJson("null");
		j.key("change");
		if (w.state != "changed") j.valJson("null");
		else
		{
			j.startObject();
			for (const auto& entry : {std::pair<const char*, const ChangeSample*>("previous", &w.previous), {"current", &w.current}})
			{
				const auto& sample = *entry.second;
				j.key(entry.first); j.startObject(); j.kv("timestamp_ms", sample.timestamp); j.kv("elapsed_ms", sample.elapsed);
				j.key("sample_pc"); j.valHex32(sample.pc); j.key("cycles"); j.valHex32(sample.cycles);
				j.key("raw"); j.valHex32(sample.raw); j.key("masked"); j.valHex32(sample.raw & w.mask); j.endObject();
			}
			j.endObject();
		}
		j.endObject();
	}

	static std::string changeCommand(const std::unordered_map<std::string, JsonValue>& params, const std::string& cmd)
	{
		const auto now = steadyMillis();
		for (auto& w : s_changes) if (w.state == "armed" && now >= w.deadline) w.state = "expired";
		scheduleChanges();
		if (cmd == "memory_watch_list")
		{
			JsonBuilder j; j.startObject(); j.kv("ok", true); j.kv("capacity", 16); j.key("watches"); j.startArray();
			for (const auto& w : s_changes) changeState(j, w);
			j.endArray(); j.endObject(); return j.str();
		}
		const auto id = getStr(params, "watch_id");
		if (id.size() != 32 || !std::all_of(id.begin(), id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })) return failure("Invalid memory watch ID");
		auto found = std::find_if(s_changes.begin(), s_changes.end(), [&](const auto& w) { return w.id == id; });
		if (cmd == "memory_watch_start")
		{
			for (const char* key : {"address", "size", "mask", "sample_interval_ms", "timeout_ms", "expected_process_id", "expected_session", "expected_execution_epoch", "expected_elf_crc", "expected_iop_reset_epoch", "expected_iop_lifetime_epoch"})
			{
				const auto field = params.find(key);
				if (field == params.end()) continue;
				const auto& value = field->second;
				bool valid = value.type == JsonValue::NUMBER && value.integerValid;
				if (value.type == JsonValue::STRING)
				{
					const auto& text = value.strVal;
					const bool hex = text.size() > 2 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X');
					int64_t exact = 0; const char* begin = text.data() + (hex ? 2 : 0);
					const auto parsed = std::from_chars(begin, text.data() + text.size(), exact, hex ? 16 : 10);
					valid = parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size();
				}
				if (!valid) return failure("Memory watch fields must be exact integers");
			}
			const auto pause = params.find("pause_on_change"), cpuField = params.find("cpu");
			if ((pause != params.end() && pause->second.type != JsonValue::BOOL) || (cpuField != params.end() && cpuField->second.type != JsonValue::STRING))
				return failure("Invalid memory watch field type");
			if (found != s_changes.end()) return failure("Memory watch ID already exists");
			if (s_step.active || s_operation.active || (s_progress.state == "armed" && now < s_progress.deadline) || s_progress.state == "capturing" ||
				(s_exception.state == "armed" && now < s_exception.deadline) || s_exception.state == "capturing") return failure("A watch or execution operation is already active");
#ifdef _WIN32
			const uint64_t process = GetCurrentProcessId();
#else
			const uint64_t process = getpid();
#endif
			if (!VMManager::HasValidVM() || VMManager::GetCurrentELF().empty()) return failure("Memory watch requires a booted ELF");
			const auto cpu = getStr(params, "cpu", "ee"); const bool iop = cpu == "iop";
			if (cpu != "ee" && !iop) return failure("cpu must be ee or iop");
			if (getNum(params, "expected_process_id", -1) != static_cast<int64_t>(process) || getNum(params, "expected_session", -1) != static_cast<int64_t>(s_session.load()) ||
				getNum(params, "expected_execution_epoch", -1) != static_cast<int64_t>(s_executionEpoch) || getStr(params, "expected_elf") != VMManager::GetCurrentELF() ||
				getNum(params, "expected_elf_crc", -1) != VMManager::GetCurrentCRC() || (iop && getNum(params, "expected_iop_reset_epoch", -1) != static_cast<int64_t>(s_iopResetEpoch)))
				return failure("Memory watch VM/ELF identity changed");
			if (iop && getNum(params, "expected_iop_lifetime_epoch", -1) != static_cast<int64_t>(s_iopLifetimeEpoch)) return failure("IOP lifetime changed before arming");
			const auto address = getNum(params, "address", -1), size = getNum(params, "size", 4);
			if (size != 1 && size != 2 && size != 4) return failure("Memory watch size must be 1, 2 or 4");
			const auto maximum = size == 4 ? int64_t{UINT32_MAX} : (int64_t{1} << (size * 8)) - 1;
			const auto mask = getNum(params, "mask", maximum), interval = getNum(params, "sample_interval_ms", 100), timeout = getNum(params, "timeout_ms", 30000);
			if (address < 0 || address > (iop ? 0x200000 : 0x2000000) - size || address % size || mask < 1 || mask > maximum ||
				interval < 50 || interval > 1000 || timeout < 100 || timeout > 300000) return failure("Invalid memory watch RAM range, mask or timing bounds");
			if (s_changes.size() == 16)
			{
				auto terminal = std::find_if(s_changes.begin(), s_changes.end(), [](const auto& w) { return w.state != "armed"; });
				if (terminal == s_changes.end()) return failure("Memory watch capacity reached (16 active)");
				s_changes.erase(terminal);
			}
			ChangeWatch w; w.id = id; w.state = "armed"; w.iop = iop; w.session = s_session.load(); w.epoch = s_executionEpoch; w.iopEpoch = s_iopResetEpoch;
			w.elf = VMManager::GetCurrentELF(); w.crc = VMManager::GetCurrentCRC(); w.address = static_cast<u32>(address); w.size = static_cast<u32>(size); w.mask = static_cast<u32>(mask);
			w.interval = interval; w.start = now; w.deadline = now + timeout; w.next = now + interval; w.pause = getBool(params, "pause_on_change", false);
			s_changes.push_back(std::move(w)); found = std::prev(s_changes.end());
		}
		else
		{
			if (found == s_changes.end()) return failure("Unknown or evicted memory watch");
			if (cmd == "memory_watch_cancel" && found->state == "armed") found->state = "cancelled";
		}
		scheduleChanges(); JsonBuilder j; changeState(j, *found); return j.str();
	}

	static std::string handleCommand(const std::string& jsonLine)
	{
		auto params = parseJsonObject(jsonLine);
		std::string cmd = getStr(params, "cmd");
		if (cmd == "input_movie_start" || cmd == "input_movie_status" || cmd == "input_movie_stop") return movieCommand(params, cmd);
		if (cmd == "iop_lifetime") return lifetimeReport();
		if (cmd == "iop_load_start" || cmd == "iop_load_status" || cmd == "iop_load_cancel") return loadWatchCommand(params, cmd);
		if (cmd == "memory_watch_start" || cmd == "memory_watch_status" || cmd == "memory_watch_cancel" || cmd == "memory_watch_list") return changeCommand(params, cmd);
		if (cmd == "media_start" || cmd == "media_status" || cmd == "media_stop") return mediaCommand(params, cmd);
		if (cmd == "gs_dump_start" || cmd == "gs_dump_status" || cmd == "gs_dump_cancel") return dumpCommand(params, cmd);
		if (cmd == "iop_module_snapshot") return guardedIopModules(params);
		if (cmd == "iop_module_image") return guardedIopModules(params, true);
		if (cmd == "progress_watch_start" || cmd == "progress_watch_status" || cmd == "progress_watch_cancel") return progressWatch(params, cmd);
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
		if (cmd == "write_register" || cmd == "write_memory" || cmd == "set_pc")
		{
			if (s_movie.active) return failure("Stop the input movie before debugger mutations");
			invalidateLoad("debugger_mutation");
			lifetimeBoundary("debugger_mutation");
			++s_inspectionRevision;
			if (s_progress.state == "armed") { s_progress.baseline = false; s_progress.unchanged = 0; s_progress.unchangedIntervals = 0; }
		}
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
		if (cmd == "sif_snapshot") return sifSnapshot(params); // executeCommand already marshals this command.
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
				j.kv("debug_port", s_debugPort); j.kv("data_directory", EmuFolders::DataRoot);
				j.kv("execution_epoch", s_executionEpoch);
				j.kv("iop_reset_epoch", s_iopResetEpoch);
				j.kv("iop_lifetime_epoch", s_iopLifetimeEpoch);
				j.kv("iop_reset_scope", "cpu_reset_only");
				j.key("elf_crc"); j.valHex32(VMManager::GetCurrentCRC());
				j.key("features"); j.startArray();
				for (const char* feature : {"screenshot", "events", "console_logs", "capture_context", "load_elf", "frame_advance", "input_frames", "controller_state", "symbols", "source_breakpoints", "guarded_step", "variable_inspection", "ee_exception_watch", "ee_break_provenance", "iop_exception_watch", "ee_syscall_provenance", "iop_trap_provenance", "ee_progress_watch", "iop_module_snapshot", "gs_dump", "media_capture", "memory_change_watch", "iop_module_image", "iop_load_provenance", "iop_lifetime", "iop_module_generations", "input_movies", "sif_snapshot"}) j.valStr(feature);
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
			const auto allowed = onCPU([]() { return g_InputRecording.isActive() ? failure("Stop input recording/replay before stepping") : std::string{}; });
			if (!allowed.empty()) return allowed;
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
			const auto allowed = onCPU([]() { return g_InputRecording.isActive() ? failure("Stop input recording/replay before stepping") : std::string{}; });
			if (!allowed.empty()) return allowed;
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
				"status", "capabilities", "read_events", "read_logs", "capture_context", "load_elf", "sif_snapshot",
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
	static std::mutex s_clientMutex;
	static std::vector<socket_t> s_clients;

	static void shutdownSocket(socket_t socket)
	{
#ifdef _WIN32
		shutdown(socket, SD_BOTH);
#else
		shutdown(socket, SHUT_RDWR);
#endif
	}

	static void closeClient(socket_t socket)
	{
		std::lock_guard lock(s_clientMutex);
		s_clients.erase(std::remove(s_clients.begin(), s_clients.end(), socket), s_clients.end());
		CLOSE_SOCKET(socket);
	}

	static std::string executeCommand(const std::string& line)
	{
		if (!s_running.load() || s_session.load() != s_requestSession) return failure("DebugServer session ended");
		const auto params = parseJsonObject(line);
		const std::string cmd = getStr(params, "cmd");
		// Event long-polls must not prevent a different client from resuming.
		if (cmd == "read_events" || cmd == "read_logs") return handleCommand(line);
		std::lock_guard lock(s_commandMutex);
		if (!s_running.load() || s_session.load() != s_requestSession) return failure("DebugServer session ended");
		if (cmd == "screenshot" || cmd == "capture_context" || cmd == "capabilities" ||
			cmd == "load_elf" || cmd == "pause" || cmd == "resume" || cmd == "step" || cmd == "step_over")
			return handleCommand(line);
		// Register/memory/breakpoint operations share the CPU thread with snapshots.
		return onCPU([line]() { return handleCommand(line); });
	}

	static void clientHandler(socket_t clientSock, uint64_t session)
	{
		s_requestSession = session;
		std::string buffer;
		char recvBuf[4096];

		while (s_running.load() && s_session.load() == session)
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
						closeClient(clientSock);
						return;
					}
					sent += static_cast<size_t>(count);
				}
			}
		}

		closeClient(clientSock);
	}

	static socket_t createListener(int port)
	{
		const socket_t listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
		if (listener == SOCKET_INVALID)
		{
			fprintf(stderr, "[DebugServer] Failed to create socket\n");
			return SOCKET_INVALID;
		}

		int opt = 1;
#ifdef _WIN32
		const int reuse = SO_EXCLUSIVEADDRUSE;
#else
		const int reuse = SO_REUSEADDR;
#endif
		if (setsockopt(listener, SOL_SOCKET, reuse, (const char*)&opt, sizeof(opt)) != 0)
		{ CLOSE_SOCKET(listener); return SOCKET_INVALID; }

		struct sockaddr_in addr = {};
		addr.sin_family = AF_INET;
		addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // localhost only
		addr.sin_port = htons((u_short)port);

		if (bind(listener, (struct sockaddr*)&addr, sizeof(addr)) != 0)
		{
			fprintf(stderr, "[DebugServer] Failed to bind on port %d\n", port);
			CLOSE_SOCKET(listener);
			return SOCKET_INVALID;
		}

		if (listen(listener, 8) != 0)
		{
			fprintf(stderr, "[DebugServer] Failed to listen\n");
			CLOSE_SOCKET(listener);
			return SOCKET_INVALID;
		}

		fprintf(stderr, "[DebugServer] Listening on 127.0.0.1:%d\n", port);
		return listener;
	}

	static void serverLoop(socket_t listener, uint64_t session)
	{
		while (s_running.load() && s_session.load() == session)
		{
			// Use select with timeout to allow clean shutdown
			fd_set readSet;
			FD_ZERO(&readSet);
			FD_SET(listener, &readSet);

			struct timeval tv;
			tv.tv_sec = 0;
			tv.tv_usec = 100000;

			int selectResult = select((int)listener + 1, &readSet, nullptr, nullptr, &tv);
			if (selectResult <= 0) continue;

			socket_t clientSock = accept(listener, nullptr, nullptr);
			if (clientSock == SOCKET_INVALID) continue;
			std::lock_guard lock(s_clientMutex);
			if (!s_running.load() || s_session.load() != session || s_clients.size() >= 32)
			{ CLOSE_SOCKET(clientSock); continue; }
			s_clients.push_back(clientSock);
			std::thread(clientHandler, clientSock, session).detach();
		}
	}

	void Start(int port)
	{
		if (s_running.load()) return;
#ifdef _WIN32
		struct WinsockLifetime
		{
			bool ready;
			WinsockLifetime() { WSADATA data; ready = WSAStartup(MAKEWORD(2, 2), &data) == 0; }
			~WinsockLifetime() { if (ready) WSACleanup(); }
		};
		static WinsockLifetime winsock;
		if (!winsock.ready) return;
#endif
		// Per-process configuration: never silently attach to the default port
		// after a malformed override or a failed bind.
		if (const char* value = std::getenv("PCSX2_DEBUG_PORT"))
		{
			unsigned int parsed = 0;
			bool valid = *value != '\0';
			for (const char* p = value; valid && *p; ++p)
			{
				valid = *p >= '0' && *p <= '9';
				if (valid) { parsed = parsed * 10 + (*p - '0'); valid = parsed <= 65535; }
			}
			if (!valid || parsed == 0)
			{ fprintf(stderr, "[DebugServer] Invalid PCSX2_DEBUG_PORT (expected 1-65535)\n"); return; }
			port = static_cast<int>(parsed);
		}
		if (port < 1 || port > 65535) return;
		s_listenSocket = createListener(port);
		if (s_listenSocket == SOCKET_INVALID) return;
		s_debugPort = port;
		s_running.store(true);
		s_sourceGroups.clear();
		s_step = {}; s_stepDeadline.store(0); ++s_executionEpoch;
		s_movie = {}; s_movieDeadline.store(0);
		s_exception = {}; s_exceptionDeadline.store(0); s_exceptionPending.store(0);
		s_progress = {}; s_progressNext.store(0); s_progressQueued.store(0);
		s_changes.clear(); s_changeNext.store(0); s_changeQueued.store(0);
		s_load = {}; s_loadDeadline.store(0);
		s_sifReset = {}; s_lifetime.clear(); s_lifetimeTruncated = false; lifetimeBoundary("server_start");
		s_iopModuleRoot = 0;
		s_eeOrigin = {}; s_iopOrigin = {};
		++s_session;
		s_pgifWrites.clear(); s_pgifWriteSequence = 0;
		s_registrationNamespace = std::to_string(timestampMillis()) + ":" + std::to_string(s_session.load()) + ":" +
			std::to_string(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
		const uint64_t watchdogSession = s_session.load();
		std::thread([watchdogSession]() {
			uint64_t queuedOperation = 0, queuedException = 0, queuedExpiry = 0, queuedDump = 0, queuedMedia = 0, queuedLoad = 0, queuedMovie = 0;
			while (s_running.load() && s_session.load() == watchdogSession)
			{
				std::this_thread::sleep_for(std::chrono::milliseconds(10));
				const auto operationId = s_stepWatchId.load();
				const auto deadline = s_stepDeadline.load();
				const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
				const auto movieExpiry = s_movieDeadline.load(), movieSequence = static_cast<int64_t>(s_movieSequence.load());
				if (movieExpiry && now >= movieExpiry && queuedMovie != static_cast<uint64_t>(movieSequence))
				{
					queuedMovie = static_cast<uint64_t>(movieSequence);
					Host::RunOnCPUThread([watchdogSession, movieSequence]() {
						if (s_session.load() == watchdogSession && s_movie.sequence == static_cast<uint64_t>(movieSequence) && s_movie.active && steadyMillis() >= s_movieDeadline.load()) finishMovie("time_limit");
					});
				}
				const auto pending = s_exceptionPending.load();
				const auto expiry = s_exceptionDeadline.load();
				const auto watchSequence = s_exceptionWatchId.load();
				const auto progressDue = s_progressNext.load();
				const auto progressId = s_progressWatchId.load();
				const auto changeDue = s_changeNext.load();
				const auto loadExpiry = s_loadDeadline.load(), loadId = static_cast<int64_t>(s_loadId.load());
				if (loadExpiry && now >= loadExpiry && queuedLoad != static_cast<uint64_t>(loadId))
				{
					queuedLoad = static_cast<uint64_t>(loadId);
					Host::RunOnCPUThread([watchdogSession, loadId]() {
						if (s_session.load() == watchdogSession && s_load.sequence == static_cast<uint64_t>(loadId) && loadActive() && steadyMillis() >= s_load.deadline) invalidateLoad("expired");
					});
				}
				const auto dumpExpiry = s_dumpDeadline.load();
				const auto dumpSequence = s_dumpSequence.load();
				const auto mediaExpiry = s_mediaDeadline.load();
				const auto mediaSequence = s_mediaSequence.load();
				if (mediaExpiry && now >= mediaExpiry && queuedMedia != mediaSequence)
				{
					queuedMedia = mediaSequence;
					Host::RunOnCPUThread([watchdogSession, mediaSequence]() {
						if (s_session.load() == watchdogSession && s_mediaSequence.load() == mediaSequence) stopMedia("time_limit");
					});
				}
				if (dumpExpiry && now >= dumpExpiry && queuedDump != dumpSequence)
				{
					queuedDump = dumpSequence;
					Host::RunOnCPUThread([watchdogSession, dumpSequence]() {
						if (s_session.load() == watchdogSession && s_dumpSequence.load() == dumpSequence) cancelDump("timeout");
					});
				}
				uint64_t idle = 0;
				if (changeDue && now >= changeDue && s_changeQueued.compare_exchange_strong(idle, watchdogSession))
				{
					Host::RunOnCPUThread([watchdogSession]() {
						if (s_session.load() == watchdogSession) sampleChanges();
						uint64_t queued = watchdogSession; s_changeQueued.compare_exchange_strong(queued, 0);
					});
				}
				idle = 0;
				if (progressDue && now >= progressDue && s_progressQueued.compare_exchange_strong(idle, progressId))
				{
					Host::RunOnCPUThread([watchdogSession, progressId]() {
						if (s_session.load() == watchdogSession && s_progress.sequence == progressId) sampleProgress();
						uint64_t queued = progressId; s_progressQueued.compare_exchange_strong(queued, 0);
					});
				}
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
		s_serverThread = std::thread(serverLoop, s_listenSocket, s_session.load());
	}

	void Stop()
	{
		finishMovie("vm_stopped");
		invalidateLoad("vm_stopped");
		invalidateChanges("vm_stopped");
		stopMedia("vm_stopped");
		cancelDump("vm_stopped");
		if (s_progress.state == "armed") s_progress.state = "vm_stopped";
		s_progressNext.store(0);
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
			shutdownSocket(s_listenSocket);
			if (s_serverThread.joinable()) s_serverThread.join();
			CLOSE_SOCKET(s_listenSocket);
			s_listenSocket = SOCKET_INVALID;
		}
		// Handlers own close(); shutdown unblocks recv/send without descriptor
		// reuse races. CPU callbacks queued by an old session are rejected above.
		std::lock_guard lock(s_clientMutex);
		for (const socket_t socket : s_clients) shutdownSocket(socket);
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
		if (s_load.state == "registered" && s_load.binding)
		{
			if (!s_load.registrationRevision && state == static_cast<int>(VMState::Paused)) s_load.registrationRevision = s_inspectionRevision;
			else if (s_load.registrationRevision) invalidateLoad("pause_scope_ended");
		}
		if (s_progress.state == "armed") { s_progress.baseline = false; s_progress.unchanged = 0; s_progress.unchangedIntervals = 0; }
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

	bool AllowInputRecordingStart()
	{
		return !s_movie.active || s_movie.starting;
	}

	void OnInputRecordingIOError()
	{
		if (s_movie.active) s_movie.ioError = true;
	}

	bool HandleInputMoviePoll()
	{
		if (!s_movie.active) return false;
		g_InputRecording.processRecordQueue(); g_InputRecording.getControls().processControlQueue();
		if (!movieOwned()) { finishMovie("ownership_lost"); return true; }
		for (u8 i = 0; i < 2; ++i)
			if (Pad::GetPad(i) != s_movie.pads[i].savedPad || Pad::GetPad(i)->GetType() != Pad::ControllerType::DualShock2)
			{ finishMovie("controller_changed"); return true; }
		if (!EmuConfig.EnableRecordingTools ||
			(s_movie.mode == "record" ? !g_InputRecording.getControls().isRecording() : !g_InputRecording.getControls().isReplaying()))
		{ finishMovie("recording_mode_changed"); return true; }
		if (steadyMillis() >= s_movieDeadline.load()) { finishMovie("time_limit"); return true; }
		// Frame 0 is applied first. Only the *next* poll completes that input
		// interval, so even a one-frame replay executes before EOF restores pads.
		// Never enter the GUI fallback which changes replay into recording.
		if (s_movie.pendingInput)
		{
			s_movie.pendingInput = false; g_InputRecording.incFrameCounter();
			s_movie.frame = g_InputRecording.getFrameCounter();
			if (s_movie.frame >= s_movie.limit)
			{ finishMovie(s_movie.mode == "replay" ? "eof" : "frame_limit"); return true; }
		}
		g_InputRecording.handleControllerDataUpdate();
		if (s_movie.ioError) { finishMovie("io_error"); return true; }
		s_movie.pendingInput = true;
		return true;
	}

	void OnPgifDmaWrite(uint32_t address, uint32_t value, uint32_t bits, uint32_t before, uint32_t after)
	{
		if (!s_running.load() || !VMManager::HasValidVM()) return;
		if (s_pgifWrites.size() == 64) s_pgifWrites.pop_front();
		s_pgifWrites.push_back({++s_pgifWriteSequence, s_session.load(), s_executionEpoch, s_iopResetEpoch,
			s_iopLifetimeEpoch, address, value, bits, before, after, psxRegs.pc, psxRegs.cycle});
	}

	void OnVMReset()
	{
		s_pgifWrites.clear(); s_pgifWriteSequence = 0;
		if (!s_movie.starting) finishMovie("vm_reset");
		invalidateLoad("vm_changed");
		s_sifReset = {}; lifetimeBoundary("vm_reset");
		invalidateChanges("vm_changed");
		stopMedia("vm_reset");
		cancelDump("vm_reset");
		s_iopModuleRoot = 0;
		if (s_progress.state == "armed") s_progress.state = "vm_changed";
		s_progressNext.store(0);
		s_eeOrigin = {}; s_iopOrigin = {};
		if (s_exception.state == "capturing") finalizeException(s_exception.sequence);
		if (s_exception.state == "armed") s_exception.state = "vm_changed";
		s_exceptionDeadline.store(0);
		++s_inspectionRevision;
		finishGuardedStep("vm_reset"); ++s_executionEpoch;
		finishOperation("vm_reset");
	}

	static InstructionOrigin instructionOrigin(bool iop, u32 taggedInstructionPC, u32 opcode)
	{
		const u32 instructionPC = taggedInstructionPC & ~3u;
		InstructionOrigin origin{};
		if (s_exception.state == "armed" && s_exception.iop == iop)
		{
			origin.active = true; origin.pc = instructionPC;
			origin.opcode = opcode; origin.branchDelay = (taggedInstructionPC & 1) != 0;
			if (instructionPC <= (iop ? 0x00200000u : 0x02000000u) - 4)
			{
				bool valid = false;
				const auto memoryOpcode = iop ? r3000Debug.read32(instructionPC, valid) : r5900Debug.read32(instructionPC, valid);
				origin.opcodeMatchesMemory = valid && memoryOpcode == opcode;
			}
		}
		return origin;
	}

	static bool originMatches(const InstructionOrigin& origin, u32 code)
	{
		const u32 index = (code >> 2) & 31;
		return origin.active && (index == 8 || index == 9) &&
			(origin.opcode & 0xfc00003fu) == (index == 8 ? 12u : 13u);
	}

	void ExecuteEEBreak(uint32_t taggedInstructionPC, uint32_t opcode)
	{
		s_eeOrigin = instructionOrigin(false, taggedInstructionPC, opcode);
		// Preserve upstream BREAK exactly, including its exception PC/BD behavior.
		R5900::Interpreter::OpcodeImpl::BREAK();
		s_eeOrigin = {};
	}

	void ExecuteEESyscall(uint32_t taggedInstructionPC, uint32_t opcode)
	{
		s_eeOrigin = instructionOrigin(false, taggedInstructionPC, opcode);
		R5900::Interpreter::OpcodeImpl::SYSCALL();
		// Some HLE calls return without cpuException; never leak their origin.
		s_eeOrigin = {};
	}

	void ExecuteIOPException(uint32_t taggedInstructionPC, uint32_t rawBranchDelay)
	{
		const u32 opcode = psxRegs.code;
		s_iopOrigin = instructionOrigin(true, taggedInstructionPC, opcode);
		// Keep the upstream BD argument independent of the JIT delay-slot witness.
		psxException((opcode & 63) == 12 ? 0x20 : 0x24, rawBranchDelay);
		s_iopOrigin = {};
	}

	void OnEEException(uint32_t code, uint32_t pc, bool branchDelay, bool nested)
	{
		const InstructionOrigin origin = s_eeOrigin;
		s_eeOrigin = {};
		bool capture = false;
		if (s_exception.state == "armed" && !s_exception.iop)
		{
			if (steadyMillis() >= s_exception.deadline) { s_exception.state = "expired"; s_exceptionDeadline.store(0); }
			else if (s_exception.epoch != s_executionEpoch || s_exception.elf != VMManager::GetCurrentELF() || s_exception.crc != VMManager::GetCurrentCRC())
			{ s_exception.state = "vm_changed"; s_exceptionDeadline.store(0); }
			else if (s_exception.mask & (1u << ((code >> 2) & 31)))
			{
				capture = true; s_exception.state = "capturing"; s_exceptionDeadline.store(0);
				s_exception.code = code; s_exception.exceptionPC = pc; s_exception.postPC = r5900Debug.getPC();
				s_exception.branchDelay = branchDelay; s_exception.nested = nested; s_exception.timestamp = timestampMillis();
				if (originMatches(origin, code)) s_exception.instruction = origin;
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

	static bool checkLoadContext()
	{
		if (loadActive() && steadyMillis() >= s_load.deadline) invalidateLoad("expired");
		if (loadActive() && (s_load.epoch != s_executionEpoch || s_load.iopEpoch != s_iopResetEpoch || s_load.elf != VMManager::GetCurrentELF() || s_load.crc != VMManager::GetCurrentCRC())) invalidateLoad("vm_changed");
		return loadActive();
	}

	void OnIOPHostFileOpened(int fd, const std::string& path, bool readonly)
	{
		if (!checkLoadContext()) return;
		auto canonical = Path::Canonicalize(path), expected = s_load.path;
#ifdef _WIN32
		for (auto* text : {&canonical, &expected}) for (auto& c : *text) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
#endif
		if (canonical != expected) return;
		if (s_load.state != "armed") { invalidateLoad("ambiguous_file_open"); return; }
#ifdef _WIN32
		struct _stat64 stat{}; const bool regular = _fstat64(fd, &stat) == 0 && (stat.st_mode & _S_IFMT) == _S_IFREG;
#else
		struct stat stat{}; const bool regular = fstat(fd, &stat) == 0 && S_ISREG(stat.st_mode);
#endif
		if (!readonly || !regular || stat.st_size != s_load.size) { invalidateLoad("file_mode_or_size_mismatch"); return; }
		s_load.fd = fd; s_load.state = "file_reading"; s_load.bytes.resize(s_load.size); s_load.covered.resize(s_load.size);
	}

	bool IsObservedIOPFile(int fd) { return checkLoadContext() && fd == s_load.fd; }

	void OnIOPHostFileRead(int fd, int64_t offset, const void* data, uint32_t length)
	{
		if (!IsObservedIOPFile(fd)) return;
		if (offset < 0 || static_cast<uint64_t>(offset) + length > s_load.size) { invalidateLoad("file_extent_changed"); return; }
		const auto* bytes = static_cast<const u8*>(data); ++s_load.reads;
		for (u32 i = 0; i < length; ++i)
		{
			const auto at = static_cast<size_t>(offset) + i;
			if (s_load.covered[at] && s_load.bytes[at] != bytes[i]) { invalidateLoad("inconsistent_file_reads"); return; }
			if (!s_load.covered[at]) { s_load.covered[at] = 1; ++s_load.coverage; }
			s_load.bytes[at] = bytes[i];
		}
		if (s_load.coverage == s_load.size && s_load.state != "buffer_observed") s_load.state = "file_complete";
	}

	void OnIOPHostFileClosed(int fd)
	{
		if (!IsObservedIOPFile(fd)) return;
#ifdef _WIN32
		struct _stat64 stat{}; const bool regular = _fstat64(fd, &stat) == 0 && (stat.st_mode & _S_IFMT) == _S_IFREG;
#else
		struct stat stat{}; const bool regular = fstat(fd, &stat) == 0 && S_ISREG(stat.st_mode);
#endif
		if (!regular || stat.st_size != s_load.size) { invalidateLoad("file_extent_changed"); return; }
		s_load.fd = -1;
		if (s_load.coverage != s_load.size) invalidateLoad("incomplete_file_reads");
		else s_load.fileClosed = true;
	}

	void OnIOPLoadObject(uint32_t buffer, uint32_t fileInfo)
	{
		lifetimeBoundary("load_object_call", buffer);
		if (s_load.state == "registered") { invalidateLoad("later_load_attempt"); return; }
		if (!checkLoadContext() || s_load.state != "file_complete" || !s_load.fileClosed) return;
		if ((buffer & 3) || (fileInfo & 3) || static_cast<uint64_t>(buffer) + s_load.size > 0x00200000 || fileInfo > 0x00200000 - 36) return;
		for (size_t i = 0; i < 64; ++i) if (s_load.bytes[i] != s_load.prefix[i]) { invalidateLoad("source_header_changed"); return; }
		for (u32 i = 0; i < s_load.size; ++i)
		{
			bool valid = false; const u8 value = r3000Debug.read8(buffer + i, valid);
			if (!valid || value != s_load.bytes[i]) return; // A different loader call is not this file's provenance.
		}
		std::array<u32, 9> info{};
		for (u32 i = 0; i < 9; ++i) { bool valid = false; info[i] = r3000Debug.read32(fileInfo + i * 4, valid); if (!valid) return; }
		if (info[0] != 4 || info[3] < 48 || (info[3] & 3) || static_cast<uint64_t>(info[3]) + info[7] > 0x00200000 ||
			info[4] == 0 || static_cast<uint64_t>(info[4]) + info[5] + info[6] != info[7]) { invalidateLoad("unsupported_file_info_layout"); return; }
		s_load.buffer = buffer; s_load.fileInfo = fileInfo; s_load.info = info; s_load.loaderPC = psxRegs.pc;
		s_load.bufferTimestamp = timestampMillis(); s_load.state = "buffer_observed";
	}

	void OnIOPModuleRegister(uint32_t record)
	{
		lifetimeBoundary("register_module_call", record);
		Registration observed; observed.sequence = ++s_registrationSequence; observed.epoch = s_iopLifetimeEpoch;
		bool readable = record && !(record & 3) && record <= 0x00200000 - 40;
		if (readable) { bool valid = false; observed.nameAddress = r3000Debug.read32(record + 4, valid); readable = valid; }
		if (readable) { bool valid = false; observed.version = r3000Debug.read32(record + 8, valid) & 0xffff; readable = valid; }
		for (u32 i = 0; readable && i < observed.metadata.size(); ++i) { bool valid = false; observed.metadata[i] = r3000Debug.read32(record + 16 + i * 4, valid); readable = valid; }
		if (readable)
		{
			if (s_registrations.size() >= 256) s_registrations.clear();
			s_registrations[record] = observed;
		}
		if (!checkLoadContext() || s_load.state != "buffer_observed" || record != s_load.info[3] - 48) return;
		const std::array<u32, 6> expected{s_load.info[1] + s_load.info[3], s_load.info[2] + s_load.info[3], s_load.info[3], s_load.info[4], s_load.info[5], s_load.info[6]};
		for (u32 i = 0; i < expected.size(); ++i) { bool valid = false; const u32 value = r3000Debug.read32(record + 16 + i * 4, valid); if (!valid || value != expected[i]) { invalidateLoad("registration_metadata_mismatch"); return; } }
		s_load.record = record; s_load.state = "registered"; s_load.binding = true; s_load.registrationTimestamp = timestampMillis();
		s_load.lifetimeEpoch = s_iopLifetimeEpoch;
		s_loadDeadline.store(0); s_load.covered.clear(); s_load.fd = -1;
	}

	void OnIOPModuleRelease(uint32_t record)
	{
		invalidateLoad("module_release_call"); lifetimeBoundary("release_module_call", record);
	}

	void OnIOPModuleService(uint32_t ordinal)
	{
		if (ordinal == 4) { invalidateLoad("software_reset_requested"); s_iopModuleRoot = 0; s_sifReset = {}; }
		lifetimeBoundary(ordinal == 4 ? "module_reboot_call" : "module_service_call", ordinal);
	}

	void OnStateLoadAttempt()
	{
		s_pgifWrites.clear(); s_pgifWriteSequence = 0;
		finishMovie("savestate_load_attempt");
		finishGuardedStep("savestate_load_attempt"); finishOperation("savestate_load_attempt"); ++s_executionEpoch;
		++s_inspectionRevision; invalidateLoad("savestate_load_attempt");
		s_sifReset = {}; s_iopModuleRoot = 0; lifetimeBoundary("savestate_load_attempt");
		invalidateChanges("vm_changed");
		if (s_progress.state == "armed") s_progress.state = "vm_changed";
		s_progressNext.store(0);
		if (s_exception.state == "capturing") finalizeException(s_exception.sequence);
		if (s_exception.state == "armed") s_exception.state = "vm_changed";
		s_exceptionDeadline.store(0);
	}

	void OnSIF1Tag(uint32_t address, uint32_t words, bool interrupt)
	{
		s_sifReset = {};
		// Standard SifIopReset packet: 104 bytes, DMA rounded to 112, IRQ tag.
		// This is request evidence only; no claim that the IOP handler ran.
		if (s_running.load() && interrupt && words == 28 && !(address & 3) && address <= 0x00200000 - 112)
		{ s_sifReset.address = address; s_sifReset.next = address; s_sifReset.remaining = words; }
	}

	void OnSIF1Write(uint32_t address, uint32_t words)
	{
		if (!s_sifReset.remaining) return;
		if (address != s_sifReset.next || !words || words > s_sifReset.remaining) { s_sifReset = {}; return; }
		for (u32 i = 0; i < words && s_sifReset.copied < 26; ++i)
		{
			bool valid = false; const u32 value = r3000Debug.read32(address + i * 4, valid);
			if (!valid) { s_sifReset = {}; return; }
			s_sifReset.words[s_sifReset.copied++] = value;
		}
		s_sifReset.next += words * 4; s_sifReset.remaining -= words;
		if (s_sifReset.remaining) return;
		const auto packet = s_sifReset; s_sifReset = {};
		if (packet.copied != 26 || (packet.words[0] & 255) != 104 || packet.words[2] != 0x80000003 || packet.words[4] > 79) return;
		invalidateLoad("software_reset_requested"); s_iopModuleRoot = 0;
		lifetimeBoundary("sif_reset_packet", packet.address);
	}

	void OnIOPModuleListLocated(uint32_t address)
	{
		// RegisterLibraryEntries republishes the same locator for each library,
		// including the observed IRX's own exports before its first pause.
		if (s_iopModuleRoot != address) lifetimeBoundary("loadcore_locator_changed", address);
		s_iopModuleRoot = address; ++s_iopModuleDiscovery;
	}

	void OnIOPReset()
	{
		invalidateLoad("cpu_reset");
		s_sifReset = {}; lifetimeBoundary("cpu_reset");
		invalidateChanges("cpu_reset", true);
		s_iopModuleRoot = 0;
		s_iopOrigin = {};
		if (s_exception.iop && s_exception.state == "capturing") finalizeException(s_exception.sequence);
		if (s_exception.iop && s_exception.state == "armed")
		{ s_exception.state = "cpu_reset"; s_exceptionDeadline.store(0); }
		++s_iopResetEpoch;
		if (s_running.load()) recordEvent("iop_reset", "iop");
	}

	bool IOPExceptionCaptured()
	{
		return s_exception.iop && s_exceptionPending.load() != 0;
	}

	void OnIOPException(uint32_t code, uint32_t pc, bool branchDelay, uint32_t previousStatus)
	{
		const InstructionOrigin origin = s_iopOrigin;
		s_iopOrigin = {};
		if (s_exception.state != "armed" || !s_exception.iop) return;
		if (steadyMillis() >= s_exception.deadline)
		{ s_exception.state = "expired"; s_exceptionDeadline.store(0); return; }
		if (s_exception.iopEpoch != s_iopResetEpoch || s_exception.epoch != s_executionEpoch ||
			s_exception.elf != VMManager::GetCurrentELF() || s_exception.crc != VMManager::GetCurrentCRC())
		{ s_exception.state = "vm_changed"; s_exceptionDeadline.store(0); return; }
		if (!(s_exception.mask & (1u << ((code >> 2) & 31)))) return;
		s_exception.state = "capturing"; s_exceptionDeadline.store(0);
		s_exception.code = code; s_exception.exceptionPC = pc; s_exception.postPC = psxRegs.pc;
		s_exception.branchDelay = branchDelay; s_exception.previousStatus = previousStatus; s_exception.timestamp = timestampMillis();
		s_exception.hi = psxRegs.GPR.n.hi; s_exception.lo = psxRegs.GPR.n.lo;
		if (originMatches(origin, code)) s_exception.instruction = origin;
		for (int i = 0; i < 32; ++i)
		{ s_exception.gpr[i] = u128::From32(psxRegs.GPR.r[i]); s_exception.cp0[i] = psxRegs.CP0.r[i]; }
		recordEvent("iop_exception", "iop", pc, s_exception.id);
		if (s_step.active) s_step.reason = "exception";
		VMManager::SetPaused(true); s_exception.revision = s_inspectionRevision;
		s_exceptionPending.store(s_exception.sequence);
		// Safe EE exit ends the IOP timeslice. The IOP JIT also checks the pending
		// capture after BREAK/SYSCALL, returning before the handler can overwrite it.
		Cpu->ExitExecution();
	}

	bool PreserveStepWatchpoints()
	{
		return s_step.active;
	}

} // namespace DebugServer
