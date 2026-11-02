#!/usr/bin/env node
import { DapFramer, encodeDap } from './dap-wire.js';
import { Pcsx2DapSession } from './dap-session.js';

let chain = Promise.resolve(), queued = 0, closing = false, busy = false, failed = false, retired = false;
const session = new Pcsx2DapSession(message => {
  if (!process.stdout.write(encodeDap(message))) process.stdin.pause();
});
process.stdout.on('drain', () => { if (!closing) process.stdin.resume(); });
function enqueue(operation: () => Promise<void>) {
  if (closing) return;
  if (++queued > 64) { fatal(new Error('DAP queue exceeds 64 requests')); return; }
  chain = chain.then(async () => { busy = true; try { if (!failed && !retired) await operation(); } finally { busy = false; queued--; } }).catch(fatal);
}
function fatal(error: unknown) {
  if (closing) return;
  closing = true; failed = true; process.stderr.write(String(error) + '\n'); process.exitCode = 1; process.stdin.destroy();
  clearInterval(timer); void chain.finally(() => session.dispose());
}
const framer = new DapFramer(request => enqueue(async () => {
  if (await session.request(request)) {
    // A successful disconnect already completed native cleanup. Flush its reply
    // and terminated event, then retire without relying on an editor process kill.
    retired = true; closing = true; clearInterval(timer);
    process.stdin.destroy(); process.stdout.end();
  }
}));
process.stdin.on('data', chunk => { if (!closing) try { framer.feed(Buffer.from(chunk)); } catch (error) { fatal(error); } });
process.stdin.on('end', () => {
  if (closing) return;
  closing = true; clearInterval(timer);
  try { framer.end(); } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
  void chain.then(() => session.dispose()).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
});
const timer = setInterval(() => { if (!closing && !busy && !queued) enqueue(() => session.poll()); }, 250);
timer.unref();
process.stdout.on('error', fatal);
