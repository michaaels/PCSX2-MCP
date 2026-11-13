// SPDX-License-Identifier: MIT
// Included after EndPresentRenderPass. Record the copy in the presentation
// submission; do not flush it before that submission waits for image acquisition.
auto mcp_ui_request = MCPRenderedUI::Take(m_window_info.window_handle);
MCPRenderedUI::Frame mcp_ui_frame;
std::unique_ptr<GSDownloadTexture> mcp_ui_download;
bool mcp_ui_bgra = false;
if (mcp_ui_request)
{
 mcp_ui_frame.capture_method = "vulkan_present_buffer_with_imgui";
 GSTextureVK* source = m_swap_chain->GetCurrentTexture();
 const VkFormat format = source->GetVkFormat();
 mcp_ui_bgra = format == VK_FORMAT_B8G8R8A8_UNORM || format == VK_FORMAT_B8G8R8A8_SRGB;
 const bool rgba = format == VK_FORMAT_R8G8B8A8_UNORM || format == VK_FORMAT_R8G8B8A8_SRGB;
 const int width = source->GetWidth(), height = source->GetHeight();
 if (!m_swap_chain->SupportsUICapture())
  mcp_ui_frame.error = "Vulkan UI capture requires transfer-source usage and an identity surface transform";
 else if (width <= 0 || height <= 0 || std::uint64_t(width) * height > 16777216 ||
          source->GetFormat() != GSTexture::Format::Color || (!mcp_ui_bgra && !rgba))
  mcp_ui_frame.error = "Vulkan UI capture requires bounded RGBA8/BGRA8 presentation";
 else
 {
  mcp_ui_download = CreateDownloadTexture(static_cast<u32>(width), static_cast<u32>(height), source->GetFormat());
  if (!mcp_ui_download) mcp_ui_frame.error = "Cannot allocate bounded Vulkan UI readback";
  else
  {
   mcp_ui_frame.width = width; mcp_ui_frame.height = height;
   const GSVector4i rectangle(0, 0, width, height);
   // The pinned implementation restores the source layout and records a host
   // read barrier. ReadTexels must wait until after the normal present submit.
   mcp_ui_download->CopyFromTexture(rectangle, source, rectangle, 0, false);
  }
 }
}
