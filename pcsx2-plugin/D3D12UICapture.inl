// SPDX-License-Identifier: MIT
// Included inside GSDevice12::EndPresent after RenderImGui, before rotating
// the swapchain index or transitioning the current buffer for presentation.
if (auto request = MCPRenderedUI::Take(m_window_info.window_handle))
{
 MCPRenderedUI::Frame frame;
 frame.capture_method = "d3d12_present_buffer_with_imgui";
 GSTexture12* source = m_swap_chain_buffers[m_current_swap_chain_buffer].get();
 const D3D12_RESOURCE_DESC desc = source->GetResource()->GetDesc();
 const bool bgra = desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM || desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
 const bool rgba = desc.Format == DXGI_FORMAT_R8G8B8A8_UNORM || desc.Format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
 if (!desc.Width || !desc.Height || std::uint64_t(desc.Width) * desc.Height > 16777216 ||
     desc.SampleDesc.Count != 1 || source->GetFormat() != GSTexture::Format::Color || (!bgra && !rgba))
  frame.error = "D3D12 UI capture requires bounded, single-sample RGBA8/BGRA8 presentation";
 else
 {
  auto download = CreateDownloadTexture(static_cast<u32>(desc.Width), desc.Height, source->GetFormat());
  if (!download) frame.error = "Cannot allocate bounded D3D12 UI readback";
  else
  {
   const GSVector4i rectangle(0, 0, static_cast<int>(desc.Width), static_cast<int>(desc.Height));
   frame.width = static_cast<int>(desc.Width); frame.height = static_cast<int>(desc.Height);
   frame.rgba.resize(std::size_t(frame.width) * frame.height);
   // The pinned download implementation ends the render pass, copies with
   // resource-state restoration and waits for its own submission fence. Keep
   // this on the GS thread; Qt only waits for the asynchronous frame callback.
   download->CopyFromTexture(rectangle, source, rectangle, 0, false);
   if (!download->ReadTexels(rectangle, frame.rgba.data(), static_cast<u32>(frame.width) * 4))
    frame.error = "Cannot map D3D12 UI readback";
   else
   {
    for (auto& pixel : frame.rgba)
     pixel = (bgra ? (pixel & 0x0000ff00u) | ((pixel & 0x00ff0000u) >> 16) | ((pixel & 0xffu) << 16) : pixel) | 0xff000000u;
    download->Unmap();
   }
  }
 }
 if (request->live()) request->complete(std::move(frame));
}
