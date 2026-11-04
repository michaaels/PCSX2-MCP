// SPDX-License-Identifier: MIT
// Included inside GSDevice11::EndPresent after RenderImGui, before Present.
if (auto request = MCPRenderedUI::Take(m_window_info.window_handle))
{
 MCPRenderedUI::Frame frame;
 wil::com_ptr_nothrow<ID3D11Texture2D> source, staging;
 D3D11_TEXTURE2D_DESC desc{};
 if (FAILED(m_swap_chain->GetBuffer(0, IID_PPV_ARGS(source.put())))) frame.error = "Cannot access D3D11 presentation buffer";
 else
 {
  source->GetDesc(&desc);
  const bool bgra = desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM || desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
  const bool rgba = desc.Format == DXGI_FORMAT_R8G8B8A8_UNORM || desc.Format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
  if (!desc.Width || !desc.Height || std::uint64_t(desc.Width) * desc.Height > 16777216 || desc.SampleDesc.Count != 1 || (!bgra && !rgba)) frame.error = "D3D11 UI capture requires bounded, single-sample RGBA8/BGRA8 presentation";
  else
  {
   desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ; desc.MiscFlags = 0;
   if (FAILED(m_dev->CreateTexture2D(&desc, nullptr, staging.put()))) frame.error = "Cannot allocate bounded D3D11 UI readback";
   else
   {
    m_ctx->CopyResource(staging.get(), source.get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(m_ctx->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped))) frame.error = "Cannot map D3D11 UI readback";
    else
    {
     frame.width = desc.Width; frame.height = desc.Height; frame.rgba.resize(std::size_t(desc.Width) * desc.Height);
     for (UINT y = 0; y < desc.Height; ++y)
     {
      const auto* row = reinterpret_cast<const std::uint32_t*>(static_cast<const std::uint8_t*>(mapped.pData) + std::size_t(y) * mapped.RowPitch);
      for (UINT x = 0; x < desc.Width; ++x)
      {
       const auto pixel = row[x];
       frame.rgba[std::size_t(y) * desc.Width + x] = (bgra ? (pixel & 0x0000ff00u) | ((pixel & 0x00ff0000u) >> 16) | ((pixel & 0xffu) << 16) : pixel) | 0xff000000u;
      }
     }
     m_ctx->Unmap(staging.get(), 0);
    }
   }
  }
 }
 if (request->live()) request->complete(std::move(frame));
}
