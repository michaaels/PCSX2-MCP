// node test/sif-live.mjs <PCSX2> <rendering-ELF> <configured-data-root> <new-output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { sifIdentity } from '../dist/sif-state.js';

assert.equal(process.argv.length, 6);
const [executable, elf, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output); const root = path.join(output, 'instance'); await fs.mkdir(path.join(root, 'inis'), { recursive: true });
await fs.copyFile(path.join(configured, 'inis/PCSX2.ini'), path.join(root, 'inis/PCSX2.ini'));
const reservation = createServer(); await new Promise((resolve,reject) => { reservation.once('error',reject); reservation.listen(0,'127.0.0.1',resolve); });
const port=reservation.address().port; await new Promise(resolve=>reservation.close(resolve));
const mcp = new Client({name:'sif-live',version:'1.0'}), inspector = new DebugServerClient('127.0.0.1', port);
const result = { checks: [], scope: 'paused_SIF_snapshot_protocol_and_guard_checks' }; let owned=false;
const passed=name=>{result.checks.push(name);console.log('PASS '+name);};
async function call(name, args={}) {
  const reply=await mcp.callTool({name,arguments:args});
  assert.ok(!reply.isError,JSON.stringify(reply.content));return JSON.parse(reply.content[0].text);
}
try {
  await mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],
    env:{...process.env,PCSX2_DEBUG_PORT:String(port)},stderr:'pipe'}));
  await call('pcsx2_launch',{executable,elf,data_directory:root});owned=true;await inspector.connect();
  for(let i=0;(await inspector.getCapabilities()).elf_crc==='0x00000000';i++){assert.ok(i<100);await delay(100);}
  await inspector.pause(); const before=await inspector.getStatus();
  const response=await mcp.callTool({name:'pcsx2_sif_snapshot',arguments:{}});result.first_response=response;
  assert.ok(!response.isError,JSON.stringify(response.content));const first=JSON.parse(response.content[0].text);result.snapshot=first;
  assert.equal(first.paused,true);assert.equal(first.channels.length,3);
  assert.deepEqual(await inspector.getStatus(),before);
  passed('new native feature returns actual paused DMA/SBUS/PGIF state through MCP without moving CPU');
  assert.deepEqual(await call('pcsx2_sif_snapshot'),first);
  passed('repeated paused snapshot preserves all registers, FIFO counters and history');
  const caps=sifIdentity.parse(await inspector.getCapabilities());
  await assert.rejects(inspector.sifSnapshot({...caps,execution_epoch:caps.execution_epoch+1}),/identity changed/);
  await assert.rejects(inspector.sifSnapshot({...caps,iop_lifetime_epoch:caps.iop_lifetime_epoch+1}),/identity changed/);
  passed('native rejects stale execution and IOP lifetime epochs before sampling');
  await inspector.resume();const running=await mcp.callTool({name:'pcsx2_sif_snapshot',arguments:{}});assert.equal(running.isError,true);
  assert.equal((await inspector.getStatus()).paused,false);
  passed('running-VM snapshot is refused and does not pause execution');
  await inspector.pause();await inspector.loadElf(elf);
  await assert.rejects(inspector.sifSnapshot(caps),/identity changed/);
  // load_elf preserves the prior paused state; boot must run to establish the new CRC.
  await inspector.resume();
  for(let i=0;(await inspector.getCapabilities()).elf_crc==='0x00000000';i++){assert.ok(i<100);await delay(100);}
  await inspector.pause();const reset=await call('pcsx2_sif_snapshot');
  assert.ok(reset.execution_epoch>first.execution_epoch);
  assert.ok(reset.writes.entries.every(e=>e.execution_epoch===reset.execution_epoch));result.after_reset=reset;
  passed('ELF reset changes identity and observations do not revive entries from the prior VM epoch');
  result.passed=true;
} catch (error) {
  result.passed=false;result.failure=String(error);throw error;
} finally {
  inspector.disconnect();if(owned){await call('pcsx2_stop');result.owned_emulator_stopped=true;}
  await mcp.close();await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2));
}
