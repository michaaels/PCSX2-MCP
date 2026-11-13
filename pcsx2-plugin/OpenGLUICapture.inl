// SPDX-License-Identifier: MIT
// Included after RenderImGui, before SwapBuffers, on the owning GS context.
if (auto request = MCPRenderedUI::Take(m_window_info.window_handle))
{
 MCPRenderedUI::Frame frame;
 frame.capture_method = "opengl_present_buffer_with_imgui";
 const GSVector2i size = GetWindowSize();
 GLint draw_fbo = 0;
 const GLenum previous_error = glGetError();
 glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw_fbo);
 if (previous_error != GL_NO_ERROR)
  frame.error = "OpenGL error pending before UI capture: " + std::to_string(previous_error);
 else if (size.x <= 0 || size.y <= 0 || std::uint64_t(size.x) * size.y > 16777216 || draw_fbo != 0)
  frame.error = "OpenGL UI capture requires a bounded default presentation framebuffer";
 else
 {
  GLint read_fbo = 0, read_buffer = 0, pack_buffer = 0;
  GLint double_buffered = 0, stereo = 0, samples = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read_fbo);
  glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &pack_buffer);
  glGetIntegerv(GL_DOUBLEBUFFER, &double_buffered);
  glGetIntegerv(GL_STEREO, &stereo);
  glGetIntegerv(GL_SAMPLES, &samples);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glGetIntegerv(GL_READ_BUFFER, &read_buffer);
  const GLenum attachment = double_buffered ? GL_BACK_LEFT : GL_FRONT_LEFT;
  GLint red = 0, green = 0, blue = 0, alpha = 0, component_type = 0;
  glGetFramebufferAttachmentParameteriv(GL_READ_FRAMEBUFFER, attachment, GL_FRAMEBUFFER_ATTACHMENT_RED_SIZE, &red);
  glGetFramebufferAttachmentParameteriv(GL_READ_FRAMEBUFFER, attachment, GL_FRAMEBUFFER_ATTACHMENT_GREEN_SIZE, &green);
  glGetFramebufferAttachmentParameteriv(GL_READ_FRAMEBUFFER, attachment, GL_FRAMEBUFFER_ATTACHMENT_BLUE_SIZE, &blue);
  glGetFramebufferAttachmentParameteriv(GL_READ_FRAMEBUFFER, attachment, GL_FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE, &alpha);
  glGetFramebufferAttachmentParameteriv(GL_READ_FRAMEBUFFER, attachment, GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE, &component_type);
  if (stereo || samples > 1 || red != 8 || green != 8 || blue != 8 || (alpha != 0 && alpha != 8) || component_type != GL_UNSIGNED_NORMALIZED)
   frame.error = "OpenGL UI capture requires non-stereo, single-sample normalized RGB8/RGBA8 presentation";
  else
  {
   frame.width = size.x; frame.height = size.y;
   frame.rgba.resize(std::size_t(size.x) * size.y);
   constexpr GLenum names[] = {GL_PACK_ALIGNMENT, GL_PACK_ROW_LENGTH, GL_PACK_SKIP_ROWS, GL_PACK_SKIP_PIXELS, GL_PACK_SWAP_BYTES};
   GLint pack[5];
   for (int i = 0; i < 5; ++i) glGetIntegerv(names[i], &pack[i]);
   glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
   glPixelStorei(GL_PACK_ALIGNMENT, 1);
   for (int i = 1; i < 5; ++i) glPixelStorei(names[i], 0);
   glReadBuffer(double_buffered ? GL_BACK : GL_FRONT);
   // Client-memory readback completes before return. No PBO or default-FBO
   // binding leaks into the renderer's subsequent cached GL state.
   glReadPixels(0, 0, size.x, size.y, GL_RGBA, GL_UNSIGNED_BYTE, frame.rgba.data());
   for (int i = 0; i < 5; ++i) glPixelStorei(names[i], pack[i]);
   glBindBuffer(GL_PIXEL_PACK_BUFFER, static_cast<GLuint>(pack_buffer));
   for (int y = 0; y < size.y / 2; ++y)
    for (int x = 0; x < size.x; ++x)
     std::swap(frame.rgba[std::size_t(y) * size.x + x], frame.rgba[std::size_t(size.y - 1 - y) * size.x + x]);
   for (auto& pixel : frame.rgba) pixel |= 0xff000000u;
  }
  // Read-buffer selection belongs to its FBO; restore the default selection
  // before rebinding the previously active read FBO. Draw state is untouched.
  glReadBuffer(static_cast<GLenum>(read_buffer));
  glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(read_fbo));
  const GLenum error = glGetError();
  if (error != GL_NO_ERROR) frame.error = "OpenGL UI readback failed: " + std::to_string(error);
 }
 if (request->live()) request->complete(std::move(frame));
}
