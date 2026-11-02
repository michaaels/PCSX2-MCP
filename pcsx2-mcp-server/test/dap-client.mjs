// Test-only real stdio client, shared with native/editor acceptance orchestration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeDap } from '../dist/dap-wire.js';

export class DapClient {
  seq = 0; events = []; transcript = []; pending = new Map(); buffer = Buffer.alloc(0); stderr = '';
  constructor() {
    this.child = spawn(process.execPath, [fileURLToPath(new URL('../dist/dap.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', b => { if (this.stderr.length < 1048576) this.stderr += b.toString('utf8'); });
    this.child.stdin.on('error', error => { if (error.code !== 'EPIPE') this.error = String(error); });
    this.child.stdout.on('data', b => {
      try {
        this.buffer = Buffer.concat([this.buffer, b]);
        for (;;) {
          const end = this.buffer.indexOf('\r\n\r\n'); if (end < 0) break;
          const match = /^Content-Length: ([0-9]+)$/.exec(this.buffer.subarray(0, end).toString('ascii'));
          assert.ok(match); const length = Number(match[1]); assert.ok(length <= 1048576);
          if (this.buffer.length < end + 4 + length) break;
          const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
          this.buffer = this.buffer.subarray(end + 4 + length); this.transcript.push(message);
          assert.ok(this.transcript.length <= 2048, 'Transcript budget exceeded');
          if (message.type === 'event') this.events.push(message);
          if (message.type === 'response') { const item = this.pending.get(message.request_seq); assert.ok(item, 'Unmatched DAP response');
            this.pending.delete(message.request_seq); clearTimeout(item.timer); item.resolve(message); }
        }
      } catch (error) { this.error = String(error); this.child.kill(); }
    });
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => {
      this.exit = { code, signal }; for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('DAP exited: ' + this.stderr)); }
      this.pending.clear(); resolve(this.exit);
    }));
    this.child.on('error', e => { this.error = String(e); });
  }
  raw(command, args = {}) {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error('DAP request timeout: ' + command)); }, 30000);
      this.pending.set(seq, { resolve, reject, timer });
      this.child.stdin.write(encodeDap({ seq, type: 'request', command, arguments: args }));
    });
  }
  async call(command, args = {}) { const reply = await this.raw(command, args); assert.ok(reply.success, command + ': ' + reply.message); return reply.body; }
  async waitStopped(after) {
    for (let n = 0; n < 1500; n++) {
      const event = this.events.slice(after).find(e => e.event === 'stopped'); if (event) return event;
      assert.ok(!this.exit, 'DAP exited before stop'); await delay(20);
    }
    throw new Error('No DAP stopped event');
  }
  async close() {
    if (!this.exit) { this.child.stdin.end(); await Promise.race([this.exited, delay(5000)]); }
    if (!this.exit) { this.child.kill(); await this.exited; throw new Error('DAP required forced termination'); }
    assert.equal(this.exit.code, 0, this.stderr); assert.ok(!this.error, this.error);
  }
}
