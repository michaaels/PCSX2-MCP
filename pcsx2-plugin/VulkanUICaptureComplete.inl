// SPDX-License-Identifier: MIT
// Included after SubmitCommandBuffer(swapchain) and MoveToNextCommandBuffer.
if (mcp_ui_request)
{
 if (mcp_ui_download)
 {
  if (m_last_submit_failed)
   mcp_ui_frame.error = "Vulkan UI presentation submission failed";
  else if (mcp_ui_request->live())
  {
   const GSVector4i rectangle(0, 0, mcp_ui_frame.width, mcp_ui_frame.height);
   mcp_ui_frame.rgba.resize(std::size_t(mcp_ui_frame.width) * mcp_ui_frame.height);
   // The copy belongs to the previous fence now. Flush waits for that fence,
   // rather than submitting a buffer without the image-available semaphore.
   if (!mcp_ui_download->ReadTexels(rectangle, mcp_ui_frame.rgba.data(), static_cast<u32>(mcp_ui_frame.width) * 4))
    mcp_ui_frame.error = "Cannot map Vulkan UI readback";
   else
   {
    for (auto& pixel : mcp_ui_frame.rgba)
     pixel = (mcp_ui_bgra ? (pixel & 0x0000ff00u) | ((pixel & 0x00ff0000u) >> 16) | ((pixel & 0xffu) << 16) : pixel) | 0xff000000u;
    mcp_ui_download->Unmap();
   }
  }
 }
 if (mcp_ui_request->live()) mcp_ui_request->complete(std::move(mcp_ui_frame));
}
