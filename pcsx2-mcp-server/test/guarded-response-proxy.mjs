// Test-only transparent byte relay with one bounded, explicit response hold.
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { createHash } from 'node:crypto';

export async function guardedResponseProxy(nativePort, maxHoldMs = 700) {
  assert.ok(Number.isInteger(maxHoldMs) && maxHoldMs >= 50 && maxHoldMs <= 700);
  const sockets = new Set(); let armed = false, held, resolveHeld, timer;
  const observed = new Promise(ok => { resolveHeld = ok; });
  const server = createServer(client => {
    if (sockets.size >= 4) { client.destroy(); return; }
    const remote = createConnection({ host: '127.0.0.1', port: nativePort }); sockets.add(client); sockets.add(remote);
    let incoming = Buffer.alloc(0), outgoing = Buffer.alloc(0); const requests = [];
    const close = () => { sockets.delete(client); sockets.delete(remote); client.destroy(); remote.destroy(); };
    client.on('error', close); remote.on('error', close); client.on('close', close); remote.on('close', close);
    client.on('data', bytes => {
      incoming = Buffer.concat([incoming, bytes]); if (incoming.length > 65536) { close(); return; }
      for (;;) { const at = incoming.indexOf(10); if (at < 0) break; const line = incoming.subarray(0, at + 1); incoming = incoming.subarray(at + 1);
        let request; try { request = JSON.parse(line); } catch { close(); return; }
        requests.push(request); if (requests.length > 8) { close(); return; } remote.write(line);
      }
    });
    remote.on('data', bytes => {
      outgoing = Buffer.concat([outgoing, bytes]); if (outgoing.length > 8 * 1024 * 1024) { close(); return; }
      for (;;) { const at = outgoing.indexOf(10); if (at < 0) break; const line = outgoing.subarray(0, at + 1); outgoing = outgoing.subarray(at + 1);
        const request = requests.shift(); if (!request) { close(); return; }
        if (armed && request.cmd === 'guarded_step') {
          armed = false; const response = JSON.parse(line); const started = performance.now();
          const evidence = { request, response, bytes: line.length, sha256: createHash('sha256').update(line).digest('hex'), max_hold_ms: maxHoldMs, released: false };
          const release = automatic => { if (evidence.released) return; clearTimeout(timer); evidence.released = true;
            evidence.automatic_release = automatic; evidence.actual_hold_ms = performance.now() - started; client.write(line); };
          held = { evidence, release: () => release(false) }; timer = setTimeout(() => release(true), maxHoldMs); resolveHeld(held);
        } else client.write(line);
      }
    });
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  return { port: server.address().port, arm() { assert.ok(!armed && !held); armed = true; },
    async waitHeld() { let timeout; try { return await Promise.race([observed, new Promise((_, no) => { timeout = setTimeout(() => no(new Error('No guarded-step response observed by proxy')), 15000); })]); } finally { clearTimeout(timeout); } },
    async close() { clearTimeout(timer); held?.release(); for (const socket of sockets) socket.destroy(); await new Promise(ok => server.close(ok)); }
  };
}
