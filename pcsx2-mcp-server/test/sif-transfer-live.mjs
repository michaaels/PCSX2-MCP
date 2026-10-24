// Standalone MCP probe: no SMS, Jellyfin, network services or media input.
// node test/sif-transfer-live.mjs <PCSX2> <built fixture> <configured data root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length, 6);
const [executable, input, configured, output] = process.argv.slice(2).map(p => path.resolve(p));
await fs.mkdir(output);
const fixture = path.join(output, 'fixture'); await fs.cp(input, fixture, {recursive:true});
const digest = b => createHash('sha256').update(b).digest('hex');
const manifestBytes = await fs.readFile(path.join(fixture,'manifest.json')), manifest=JSON.parse(manifestBytes);
assert.equal(manifest.kind,'isolated_sif2_transfer_fixture');
for (const [name, hash] of Object.entries(manifest.sha256)) {
  assert.equal(path.basename(name),name); assert.equal(digest(await fs.readFile(path.join(fixture,name))),hash,name);
}
const result={kind:'standalone_sif2_mcp_validation',started_at:new Date().toISOString(),
  native_sha256:digest(await fs.readFile(executable)),manifest_sha256:digest(manifestBytes),
  checks:[],cases:[],guest_code_register_data_writes:false,
  transfer_semantics:'not_accepted',SMS_or_Jellyfin_involved:false,physical_validation:'not_performed'};
const passed=name=>{result.checks.push(name);console.log('PASS '+name);};
const hex=n=>'0x'+n.toString(16).padStart(8,'0');
function symbol(b,name) {
  const sh=b.readUInt32LE(32), stride=b.readUInt16LE(46), count=b.readUInt16LE(48);
  assert.equal(b.subarray(0,7).toString('hex'),'7f454c46010101');
  for(let i=0;i<count;i++) {
    const at=sh+i*stride;if(b.readUInt32LE(at+4)!==2)continue;
    const str=b.readUInt32LE(sh+b.readUInt32LE(at+24)*stride+16);
    const off=b.readUInt32LE(at+16),end=off+b.readUInt32LE(at+20),step=b.readUInt32LE(at+36);assert.ok(step>=16);
    for(let p=off;p<end;p+=step){const n=str+b.readUInt32LE(p);
      if(b.subarray(n,b.indexOf(0,n)).toString()===name)return b.readUInt32LE(p+4);}
  }
  throw new Error('Missing fixture symbol '+name);
}
async function port(){const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});
  const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
const words=b=>Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));
const expected=[0x53494632,0x12345678,0xabcdef01,0x87654321,0x0badf00d,0x55aa55aa,0xa55aa55a,0xdeadbeef];
try {
  for (const [mode,name] of ['half-dma','full-dma','full-pio','half-pio'].entries()) {
    const debugPort=await port(), root=path.join(output,name,'instance');
    await fs.mkdir(path.join(root,'inis'),{recursive:true});
    let ini=(await fs.readFile(path.join(configured,'inis/PCSX2.ini'),'utf8')).replace(/^HostFs\s*=.*\r?\n/gm,'');
    ini=/^\[EmuCore\]\r?\n/m.test(ini)?ini.replace(/^\[EmuCore\]\r?\n/m,'[EmuCore]\nHostFs = true\n'):ini+'\n[EmuCore]\nHostFs = true\n';
    await fs.writeFile(path.join(root,'inis/PCSX2.ini'),ini);
    const mcp=new Client({name:'standalone-sif2',version:'1.0'}),inspector=new DebugServerClient('127.0.0.1',debugPort);
    const elf=path.join(fixture,name+'.elf'), b=await fs.readFile(elf);
    const eeAddress=symbol(b,'fixture_ee'), ready=symbol(b,'fixture_ready'),done=symbol(b,'fixture_done');
    const evidence={name,mode,elf_sha256:digest(b),owned_emulator_stopped:false};result.cases.push(evidence);
    let owned=false;
    async function call(tool,args={}) {const r=await mcp.callTool({name:tool,arguments:args});
      assert.ok(!r.isError,JSON.stringify(r.content));return JSON.parse(r.content[0].text);}
    async function cursor(){let r=await inspector.readEvents(0,200);while(r.events.length===200)r=await inspector.readEvents(r.next_cursor,200);return r.next_cursor;}
    async function wait(after,pc){const r=await inspector.waitEvent({after,type:'breakpoint',timeoutMs:20000});
      assert.equal(r.timed_out,false,JSON.stringify(r));assert.equal(r.dropped,false);
      const s=await inspector.getStatus();assert.equal(s.paused,true);assert.equal(Number(s.pc),pc);return r;}
    async function sample(){const before=await inspector.getStatus(),identity=await inspector.getCapabilities();
      const ee=words(Buffer.from(await inspector.readMemoryStrict(hex(eeAddress),64),'hex'));
      assert.equal(ee[0],0x53494645);assert.ok(ee[3]>0 && ee[3]<=0x1fff00);assert.ok((ee[2]|0)>=0);
      const raw=await inspector.readMemoryStrict(hex(ee[3]),256,'iop');
      const iop=words(Buffer.from(raw,'hex'));assert.equal(iop[0],0x53494649);assert.equal(iop[1],mode);
      assert.equal(iop[2],1);assert.equal(iop[10],0);assert.equal(iop[11],0);
      const sif=await call('pcsx2_sif_snapshot');assert.deepEqual(await call('pcsx2_sif_snapshot'),sif);
      assert.deepEqual(await inspector.getStatus(),before);
      return {identity,status:before,ee,iop,iop_raw_hex:raw,sif};}
    try {
      await mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],
        env:{...process.env,PCSX2_DEBUG_PORT:String(debugPort)},stderr:'pipe'}));
      evidence.launch=await call('pcsx2_launch',{executable,elf,data_directory:root});owned=true;await inspector.connect();
      for(let i=0;(await inspector.getCapabilities()).elf_crc==='0x00000000';i++){assert.ok(i<100);await delay(100);}
      await inspector.pause();await inspector.setBreakpoint(hex(ready));
      const after=await cursor();await inspector.loadElf(elf);await inspector.resume();
      evidence.ready_event=await wait(after,ready);evidence.before=await sample();
      assert.equal(evidence.before.ee[4],1);assert.deepEqual(evidence.before.iop.slice(16,24),Array(8).fill(0xcafecafe));
      await inspector.removeBreakpoint(hex(ready));await inspector.setBreakpoint(hex(done));
      const next=await cursor();await inspector.resume();
      evidence.done_event=await wait(next,done);evidence.after=await sample();
      await inspector.removeBreakpoint(hex(done));assert.equal(evidence.after.ee[4],2);
      assert.equal(evidence.before.identity.process_id,evidence.after.identity.process_id);
      assert.equal(evidence.before.identity.execution_epoch,evidence.after.identity.execution_epoch);
      // This is an observed upstream baseline, not a specification for correct SIF2 behavior.
      assert.equal(evidence.before.iop[3],mode===0||mode===3?8:0x10008);
      if(mode<2){assert.deepEqual(evidence.after.iop.slice(16,24),Array(8).fill(0xcafecafe));
        assert.equal(evidence.after.ee[5],0x101);assert.equal(evidence.after.ee[6],2);assert.equal(evidence.after.iop[5],0);}
      else {assert.deepEqual(evidence.after.iop.slice(16,24),expected);
        assert.equal(evidence.after.iop[5],mode===2?1:0);
        assert.equal(evidence.after.sif.pgif.to_iop_active,mode===3);}
      passed(name+': native state, strict EE/IOP reads and actual DMA dispatch agree with the retained baseline; repeated MCP reads preserve state');
    } finally {
      inspector.disconnect();
      try {if(owned){await call('pcsx2_stop');evidence.owned_emulator_stopped=true;}}
      finally {await mcp.close();}
    }
  }
  assert.equal(new Set(result.cases.map(c=>c.before.identity.process_id)).size,4);
  passed('four isolated owned processes preserve separate identities, source/fixture hashes and cleanup without external services');
  result.passed=true;
} catch(error){result.passed=false;result.failure=String(error);throw error;}
finally {await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2)+'\n');}
