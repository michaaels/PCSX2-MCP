// node test/irq-live.mjs <PCSX2> <built IRQ fixture> <configured root> <new output>
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

assert.equal(process.argv.length,6);
const [executable,input,configured,output]=process.argv.slice(2,6).map(p=>path.resolve(p));
await fs.mkdir(output);const fixture=path.join(output,'fixture');await fs.cp(input,fixture,{recursive:true});
const digest=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json')));
assert.equal(manifest.kind,'standalone_irq_fixture');
for(const [name,hash]of Object.entries(manifest.sha256)){assert.equal(path.basename(name),name);assert.equal(digest(await fs.readFile(path.join(fixture,name))),hash);}
const root=path.join(output,'instance');await fs.mkdir(path.join(root,'inis'),{recursive:true});
let ini=(await fs.readFile(path.join(configured,'inis/PCSX2.ini'),'utf8')).replace(/^HostFs\s*=.*\r?\n/gm,'');
ini=/^\[EmuCore\]\r?\n/m.test(ini)?ini.replace(/^\[EmuCore\]\r?\n/m,'[EmuCore]\nHostFs = true\n'):ini+'\n[EmuCore]\nHostFs = true\n';
await fs.writeFile(path.join(root,'inis/PCSX2.ini'),ini);
const server=createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
const port=server.address().port;await new Promise(ok=>server.close(ok));
const mcp=new Client({name:'irq-control',version:'1.0'}), inspector=new DebugServerClient('127.0.0.1',port);
const report={kind:'standalone_irq_validation',checks:[],observations:[],
 native_sha256:digest(await fs.readFile(executable)),controlled_fixture_pc_writes:true,
 SMS_or_Jellyfin_involved:false,physical_validation:'not_performed'};
const hex=n=>'0x'+(n>>>0).toString(16).padStart(8,'0');
function symbol(b,name){const sh=b.readUInt32LE(32),stride=b.readUInt16LE(46),count=b.readUInt16LE(48);
 for(let i=0;i<count;i++){const at=sh+i*stride;if(b.readUInt32LE(at+4)!==2)continue;
 const str=b.readUInt32LE(sh+b.readUInt32LE(at+24)*stride+16),off=b.readUInt32LE(at+16),end=off+b.readUInt32LE(at+20),step=b.readUInt32LE(at+36);assert.ok(step>=16);
 for(let p=off;p<end;p+=step){const n=str+b.readUInt32LE(p);if(b.subarray(n,b.indexOf(0,n)).toString()===name)return b.readUInt32LE(p+4);}}
 throw new Error('Missing fixture symbol '+name);}
function bytesAt(b,address,size){const ph=b.readUInt32LE(28),stride=b.readUInt16LE(42),count=b.readUInt16LE(44);
 for(let i=0;i<count;i++){const p=ph+i*stride;if(b.readUInt32LE(p)!==1)continue;
 const off=b.readUInt32LE(p+4),base=b.readUInt32LE(p+8),len=b.readUInt32LE(p+16);
 if(address>=base&&address+size<=base+len)return b.subarray(off+address-base,off+address-base+size);}throw new Error('Missing fixture bytes');}
const words=b=>Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));
const passed=t=>{report.checks.push(t);console.log('PASS '+t);};
async function raw(name,args={}){return mcp.callTool({name,arguments:args},undefined,{timeout:60000});}
async function call(name,args={}){const r=await raw(name,args);assert.ok(!r.isError,name+': '+JSON.stringify(r.content));return JSON.parse(r.content[0].text);}
async function pc(cpu){return (await inspector.readRegisters(cpu,0)).pc;}
async function t0(cpu){return Number(BigInt('0x'+(await inspector.readRegisters(cpu,0)).GPR.regs[8].value)&0xffffffffn);}
let owned=false;
try{
 await mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],
   env:{...process.env,PCSX2_DEBUG_PORT:String(port)},stderr:'pipe'}));
 const elf=path.join(fixture,'irq-control.elf'),ee=await fs.readFile(elf),irx=await fs.readFile(path.join(fixture,'irq-control.debug.irx'));
 report.launch=await call('pcsx2_launch',{executable,elf,data_directory:root});owned=true;await inspector.connect();
 for(let i=0;(await inspector.getCapabilities()).elf_crc==='0x00000000';i++){assert.ok(i<100);await delay(100);}
 await inspector.pause();const ready=hex(symbol(ee,'instruction_ready'));await inspector.setBreakpoint(ready);
 let events=await inspector.readEvents(0,200);while(events.events.length===200)events=await inspector.readEvents(events.next_cursor,200);
 await inspector.loadElf(elf);await inspector.resume();assert.equal((await inspector.waitEvent({after:events.next_cursor,type:'breakpoint',timeoutMs:20000})).timed_out,false);
 assert.equal((await inspector.getStatus()).pc,ready);await inspector.removeBreakpoint(ready);
 const meta=words(Buffer.from(await inspector.readMemoryStrict(hex(symbol(ee,'instruction_meta')),64),'hex'));
 assert.equal(meta[0],0x53544545);assert.ok((meta[1]|0)>=0);assert.equal(meta[3],1);assert.ok(meta[2]>0&&meta[2]<=0x1fff00);
 const module=words(Buffer.from(await inspector.readMemoryStrict(hex(meta[2]),64,'iop'),'hex'));assert.equal(module[0],0x49525149);

 const names=['fixture_normal','fixture_jal','fixture_return','fixture_callee','fixture_hang_call','fixture_spin'];
 const symbols=Object.fromEntries(names.map((n,i)=>[n,module[i+1]]));
 const base=module[1]-symbol(irx,names[0]);
 for(const name of [...names,'irq_worker','irq_ready']){
   const address=base+symbol(irx,name),actual=Buffer.from(await inspector.readMemoryStrict(hex(address),4,'iop'),'hex');
   const expected=Buffer.from(bytesAt(irx,symbol(irx,name),4)),word=expected.readUInt32LE();
   if((word>>>26)===2||(word>>>26)===3)expected.writeUInt32LE(((word&0xfc000000)|(((word&0x03ffffff)+(base>>>2))&0x03ffffff))>>>0);
   assert.deepEqual(actual,expected);
 }
 assert.equal(module[11],0);assert.ok((module[9]|0)>0);assert.equal(module[14],0);
 assert.equal(module[7],base+symbol(irx,'irq_worker'));assert.equal(module[8],base+symbol(irx,'irq_ready'));
 report.fixture={ee_sha256:digest(ee),irx_sha256:manifest.sha256['irq-control.irx'],metadata:meta,module_report:module,symbols};
 passed('resident IRX bytes/relocated symbols, own thread and Vblank registration match the pinned fixture');
 async function state(){return words(Buffer.from(await inspector.readMemoryStrict(hex(meta[2]),64,'iop'),'hex'));}
 const before=await state();await inspector.advanceFrames(4);const active=await state();
 assert.ok(active[10]>before[10]);assert.equal(active[13]&1,1);assert.equal(active[12]&1,0);
 report.irq_activity={before,after:active};
 passed('actual Vblank callback count grows; worker has current IE enabled and callback records interrupt context');
 const checkpoint=hex(module[8]);await inspector.setBreakpoint(checkpoint,{cpu:'iop',description:'fixture IRQ worker checkpoint'});
 let history=await inspector.readEvents(0,200);while(history.events.length===200)history=await inspector.readEvents(history.next_cursor,200);
 await inspector.resume();assert.equal((await inspector.waitEvent({after:history.next_cursor,type:'breakpoint',timeoutMs:10000})).timed_out,false);
 assert.equal(await pc('iop'),checkpoint);await inspector.removeBreakpoint(checkpoint,'iop');
 report.checkpoint={registers:await inspector.readRegisters('iop'),state:await state()};
 passed('breakpoint stops the fixture-owned IOP thread with IRQ enabled without redirecting a kernel thread');
 for(let n=0;n<5;n++){
   await inspector.setPC(hex(symbols.fixture_normal),'iop');const value=await t0('iop');
   const result=await call('pcsx2_step',{cpu:'iop',count:2,timeout_ms:1000,show_registers:true});
   report.observations.push({case:'irq_enabled_two_steps_'+n,result});
   assert.equal(result.steps.length,2);assert.equal(await pc('iop'),hex(symbols.fixture_normal+8));
   assert.equal(await t0('iop'),(value+3)>>>0);assert.deepEqual(await inspector.listBreakpoints('iop'),[]);
 }
 passed('five IRQ-enabled two-instruction sequences preserve exact PC/register effects and clean owned points');
 await inspector.setPC(hex(symbols.fixture_jal),'iop');const value=await t0('iop');
 const over=await call('pcsx2_step_over',{cpu:'iop',timeout_ms:1000});report.observations.push({case:'irq_enabled_call',result:over});
 assert.equal(await pc('iop'),hex(symbols.fixture_return));assert.equal(await t0('iop'),(value+4)>>>0);
 assert.deepEqual(await inspector.listBreakpoints('iop'),[]);
 passed('IRQ-enabled JAL/callee step-over reaches the physical return with the exact register effect');
 await inspector.setPC(hex(symbols.fixture_hang_call),'iop');const initial=await state(),start=performance.now();
 const timed=await raw('pcsx2_step_over',{cpu:'iop',timeout_ms:250});const elapsed=performance.now()-start,after=await state();
 report.observations.push({case:'irq_active_timeout',result:timed,elapsed_ms:elapsed,initial,after});
 assert.equal(timed.isError,true);assert.match(JSON.stringify(timed.content),/timed out/);assert.ok(elapsed>=200&&elapsed<5000);
 assert.ok(after[10]>initial[10]);assert.equal((await inspector.getStatus()).paused,true);assert.deepEqual(await inspector.listBreakpoints('iop'),[]);
 await inspector.setPC(hex(symbols.fixture_normal),'iop');await call('pcsx2_step',{cpu:'iop',timeout_ms:1000});
 assert.equal(await pc('iop'),hex(symbols.fixture_normal+4));
 passed('native timeout spans real Vblank interrupts, pauses, cleans its target and recovers subsequent stepping');
 const end=await state();assert.equal(end[13]&1,1);report.final={state:end,registers:await inspector.readRegisters('iop')};
 report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);
 try{report.failure_state={status:await inspector.getStatus(),ee:await inspector.readRegisters('ee',0),iop:await inspector.readRegisters('iop',0),
  ee_points:await inspector.listBreakpoints('ee'),iop_points:await inspector.listBreakpoints('iop'),events:await inspector.readEvents(0,200)};}catch{}
 throw error;}
finally{
 inspector.disconnect();try{if(owned){await call('pcsx2_stop');report.owned_emulator_stopped=true;}}
 finally{await mcp.close();await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(report,null,2)+'\n');}
}
