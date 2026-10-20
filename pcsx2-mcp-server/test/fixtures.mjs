import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';

function chunk(type, bytes) {
  const payload = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(12 + bytes.length);
  result.writeUInt32BE(bytes.length);
  payload.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

// Real RGBA PNGs, including an incompressible image larger than a TCP buffer.
export function screenshot(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) randomBytes(width * 4).copy(rows, y * (width * 4 + 1) + 1);
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return { ok: true, width, height, mime_type: 'image/png', data: png.toString('base64') };
}

export function history(key, entries = [], next = entries.at(-1)?.sequence ?? 0) {
  return { ok: true, session: 1, oldest_sequence: 1, dropped: false, next_cursor: next, [key]: entries };
}

export function contextResponse(image = screenshot()) {
  return {
    ok: true, timestamp_ms: 1, session: 1, cpu: 'ee', was_running: true, elf: 'test.elf', elf_crc: '0x12345678',
    status: { ok: true, data: { alive: true, paused: true, pc: '0x00100000', cycles: 10 } },
    read_registers: { ok: true, data: { pc: '0x00100000' } },
    get_backtrace: { ok: true, frames: [] }, recent_logs: history('logs'), screenshot: image,
  };
}

export async function debugServer(t, reply) {
  const requests = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(request);
        void respond(request).catch(error => socket.destroy(error));
      }
    });
    async function respond(request) {
      const response = await reply(request);
      if (response === null) { socket.end(); return; }
      const bytes = JSON.stringify(response) + '\n';
      for (let i = 0; i < bytes.length; i += 8191) {
        if (!socket.write(bytes.slice(i, i + 8191))) await once(socket, 'drain');
        // Force fragmented delivery rather than relying on packet boundaries.
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, requests };
}
