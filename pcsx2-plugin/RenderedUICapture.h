// SPDX-License-Identifier: MIT
#pragma once
#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// One bounded, expiring readback request shared by Qt and the GS thread.
// Readbacks run after ImGui draws and before Present, never from desktop pixels.
namespace MCPRenderedUI
{
struct Frame { int width = 0, height = 0; std::vector<std::uint32_t> rgba; std::string error; };
struct Request
{
 void* window;
 std::atomic_bool cancelled{false};
 std::chrono::steady_clock::time_point expires = std::chrono::steady_clock::now() + std::chrono::seconds(4);
 std::function<void(Frame)> complete;
 bool live() const { return !cancelled && std::chrono::steady_clock::now() < expires; }
};
inline std::mutex mutex;
inline std::shared_ptr<Request> pending;
inline std::shared_ptr<Request> Queue(void* window, std::function<void(Frame)> complete)
{
 std::lock_guard lock(mutex);
 if (pending && pending->live()) return {};
 auto request = std::make_shared<Request>(); request->window = window; request->complete = std::move(complete);
 pending = request; return request;
}
inline std::shared_ptr<Request> Take(void* window)
{
 std::lock_guard lock(mutex);
 if (pending && !pending->live()) pending.reset();
 if (!pending || pending->window != window) return {};
 auto request = std::move(pending); return request;
}
}
