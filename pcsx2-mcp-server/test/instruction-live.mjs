// node test/instruction-live.mjs <PCSX2> <built instruction fixture> <configured root> <new output>
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
assert.equal(manifest.kind,'standalone_instruction_fixture');
for(const [name,hash]of Object.entries(manifest.sha256)){assert.equal(path.basename(name),name);assert.equal(digest(await fs.readFile(path.join(fixture,name))),hash);}
const root=path.join(output,'instance');await fs.mkdir(path.join(root,'inis'),{recursive:true});
let ini=(await fs.readFile(path.join(configured,'inis/PCSX2.ini'),'utf8')).replace(/^HostFs\s*=.*\r?\n/gm,'');
ini=/^\[EmuCore\]\r?\n/m.test(ini)?ini.replace(/^\[EmuCore\]\r?\n/m,'[EmuCore]\nHostFs = true\n'):ini+'\n[EmuCore]\nHostFs = true\n';
await fs.writeFile(path.join(root,'inis/PCSX2.ini'),ini);
const server=createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
const port=server.address().port;await new Promise(ok=>server.close(ok));
const mcp=new Client({name:'instruction-control',version:'1.0'}), inspector=new DebugServerClient('127.0.0.1',port);
const report={kind:'standalone_instruction_validation',checks:[],observations:[],
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
 const elf=path.join(fixture,'instruction-control.elf'),ee=await fs.readFile(elf),irx=await fs.readFile(path.join(fixture,'instruction-control.debug.irx'));
 report.launch=await call('pcsx2_launch',{executable,elf,data_directory:root});owned=true;await inspector.connect();
 for(let i=0;(await inspector.getCapabilities()).elf_crc==='0x00000000';i++){assert.ok(i<100);await delay(100);}
 await inspector.pause();const ready=hex(symbol(ee,'instruction_ready'));await inspector.setBreakpoint(ready);
 let events=await inspector.readEvents(0,200);while(events.events.length===200)events=await inspector.readEvents(events.next_cursor,200);
 await inspector.loadElf(elf);await inspector.resume();assert.equal((await inspector.waitEvent({after:events.next_cursor,type:'breakpoint',timeoutMs:20000})).timed_out,false);
 assert.equal((await inspector.getStatus()).pc,ready);await inspector.removeBreakpoint(ready);
 const meta=words(Buffer.from(await inspector.readMemoryStrict(hex(symbol(ee,'instruction_meta')),64),'hex'));
 assert.equal(meta[0],0x53544545);assert.ok((meta[1]|0)>=0);assert.equal(meta[3],1);assert.ok(meta[2]>0&&meta[2]<=0x1fff00);
 const module=words(Buffer.from(await inspector.readMemoryStrict(hex(meta[2]),64,'iop'),'hex'));assert.equal(module[0],0x5354494f);
 const names=['fixture_normal','fixture_jal','fixture_return','fixture_callee','fixture_hang_call','fixture_spin'];
 const eeSymbols=Object.fromEntries(names.map(n=>[n,symbol(ee,n)])),iopSymbols=Object.fromEntries(names.map((n,i)=>[n,module[i+1]]));
 const base=module[1]-symbol(irx,names[0]);
 for(const n of names){assert.equal(iopSymbols[n],base+symbol(irx,n));
   const actual=Buffer.from(await inspector.readMemoryStrict(hex(iopSymbols[n]),4,'iop'),'hex');
   const expected=Buffer.from(bytesAt(irx,symbol(irx,n),4)),word=expected.readUInt32LE();
   // IRX R_MIPS_26 relocates module-local J/JAL operands; ordinary words stay exact.
   if((word>>>26)===2||(word>>>26)===3)expected.writeUInt32LE(((word&0xfc000000)|(((word&0x03ffffff)+(base>>>2))&0x03ffffff))>>>0);
   assert.deepEqual(actual,expected);}
 report.fixture={ee_sha256:digest(ee),irx_sha256:manifest.sha256['instruction-control.irx'],ee:eeSymbols,iop:iopSymbols,metadata:meta,module_report:module};
 passed('exact EE ELF and resident IOP runtime addresses/instruction bytes agree with retained debug IRX');

   for(const [cpu,symbols]of [['ee',eeSymbols],['iop',iopSymbols]]){
     if(cpu==='iop'){
       // Isolate instruction vectors from asynchronous kernel IRQ dispatch. A separate
       // IRQ-active attempt is retained as an interrupted operation, never as success.
       await inspector.setPC(hex(eeSymbols.fixture_spin),'ee');
       assert.equal(module[7],base+symbol(irx,'fixture_quiet'));
       assert.equal(module[8],base+symbol(irx,'fixture_quiet_ready'));
       assert.equal(module[9],base+symbol(irx,'fixture_status'));
       await inspector.setPC(hex(module[7]),'iop');await inspector.setBreakpoint(hex(module[8]),{cpu:'iop'});
       let h=await inspector.readEvents(0,200);while(h.events.length===200)h=await inspector.readEvents(h.next_cursor,200);
       await inspector.resume();assert.equal((await inspector.waitEvent({after:h.next_cursor,type:'breakpoint',timeoutMs:10000})).timed_out,false);
       assert.equal(await pc('iop'),hex(module[8]));await inspector.removeBreakpoint(hex(module[8]),'iop');
       report.iop_irq_isolation=words(Buffer.from(await inspector.readMemoryStrict(hex(module[9]),8,'iop'),'hex'));
       assert.equal(report.iop_irq_isolation[1],(report.iop_irq_isolation[0]&0xfffffffe)>>>0);
     }
     await inspector.setPC(hex(symbols.fixture_normal),cpu);const value=await t0(cpu);
     const result=await call('pcsx2_step',{cpu,count:2,timeout_ms:1000,show_registers:true});
     report.observations.push({case:cpu+'_two_instructions',result});
     assert.equal(result.cpu,cpu);assert.equal(result.steps.length,2);assert.equal(result.steps[1].new_pc,hex(symbols.fixture_normal+8));
     assert.equal(await t0(cpu),(value+3)>>>0);assert.equal(await pc(cpu),hex(symbols.fixture_normal+8));assert.deepEqual(await inspector.listBreakpoints(cpu),[]);
     passed(cpu+': two MCP instruction steps preserve exact PC/register effects and remove owned points');
     await inspector.setPC(hex(symbols.fixture_jal),cpu);const before=await t0(cpu);
     const over=await call('pcsx2_step_over',{cpu,timeout_ms:1000});assert.equal(over.steps[0].new_pc,hex(symbols.fixture_return));
     assert.equal(await t0(cpu),(before+4)>>>0);assert.deepEqual(await inspector.listBreakpoints(cpu),[]);
     passed(cpu+': MCP step-over executes a real JAL/callee/delay slot and stops at return');
     await inspector.setPC(hex(symbols.fixture_normal),cpu);const target=hex(symbols.fixture_normal+4);
     await inspector.setBreakpoint(target,{cpu,description:'foreign successor control'});const points=await inspector.listBreakpoints(cpu);
     const rejected=await raw('pcsx2_step',{cpu,timeout_ms:1000});assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected.content),/Existing breakpoint/);
     assert.deepEqual(await inspector.listBreakpoints(cpu),points);assert.equal(await pc(cpu),hex(symbols.fixture_normal));await inspector.removeBreakpoint(target,cpu);
     passed(cpu+': foreign successor is refused and preserved without executing');
     await inspector.setPC(hex(symbols.fixture_jal),cpu);const interrupt=hex(symbols.fixture_callee);
     await inspector.setBreakpoint(interrupt,{cpu,description:'foreign interrupt control'});const preserved=await inspector.listBreakpoints(cpu);
     const interrupted=await raw('pcsx2_step_over',{cpu,timeout_ms:1000});assert.equal(interrupted.isError,true);assert.match(JSON.stringify(interrupted.content),/interrupted/);
     assert.deepEqual(await inspector.listBreakpoints(cpu),preserved);assert.equal(await pc(cpu),interrupt);await inspector.removeBreakpoint(interrupt,cpu);
     passed(cpu+': earlier breakpoint interrupts step-over, owned target is removed and foreign point remains');
     await inspector.setPC(hex(symbols.fixture_hang_call),cpu);const start=performance.now();
     const timed=await raw('pcsx2_step_over',{cpu,timeout_ms:100});const elapsed=performance.now()-start;
     report.observations.push({case:cpu+'_timeout',result:timed,elapsed_ms:elapsed});
     assert.equal(timed.isError,true);assert.match(JSON.stringify(timed.content),/timed out/);assert.ok(elapsed>=80&&elapsed<5000);
     assert.equal(inspector.isConnected(),true);assert.equal((await inspector.getStatus()).paused,true);assert.deepEqual(await inspector.listBreakpoints(cpu),[]);
     await inspector.setPC(hex(symbols.fixture_normal),cpu);await call('pcsx2_step',{cpu,timeout_ms:1000});assert.equal(await pc(cpu),hex(symbols.fixture_normal+4));
     passed(cpu+': non-returning call hits native deadline, pauses, cleans its point and leaves connection usable');
     const caps=await inspector.getCapabilities(),stopped=await pc(cpu),beforeStatus=await inspector.getStatus();
     const stale={...caps,pc:stopped,...(cpu==='iop'?{iop_lifetime_epoch:caps.iop_lifetime_epoch+1}:{process_id:caps.process_id+1})};
     await assert.rejects(inspector.step(cpu,100,stale),/identity changed/);
     assert.equal(await pc(cpu),stopped);assert.deepEqual(await inspector.getStatus(),beforeStatus);assert.deepEqual(await inspector.listBreakpoints(cpu),[]);
     passed(cpu+': native stale process/IOP identity guard refuses before any instruction or breakpoint mutation');
   }
   await inspector.setPC(hex(iopSymbols.fixture_normal),'iop');
   const blocked=hex(iopSymbols.fixture_normal+8);await inspector.setBreakpoint(blocked,{cpu:'iop',description:'partial sequence control'});
   const partial=await raw('pcsx2_step',{cpu:'iop',count:3,timeout_ms:1000});assert.equal(partial.isError,true);
   const detail=JSON.parse(partial.content[0].text);assert.equal(detail.partial.steps.length,1);assert.equal(detail.partial.count_requested,3);
   assert.equal(await pc('iop'),hex(iopSymbols.fixture_normal+4));assert.equal((await inspector.listBreakpoints('iop')).length,1);
   await inspector.removeBreakpoint(blocked,'iop');report.observations.push({case:'partial_IOP_sequence',result:detail});
   passed('IOP sequence error retains exactly the completed instruction and preserves the later foreign breakpoint');
   report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);
 try{report.failure_state={status:await inspector.getStatus(),ee:await inspector.readRegisters('ee',0),iop:await inspector.readRegisters('iop',0),
  ee_points:await inspector.listBreakpoints('ee'),iop_points:await inspector.listBreakpoints('iop'),events:await inspector.readEvents(0,200)};}catch{}
 throw error;}
finally{
 inspector.disconnect();try{if(owned){await call('pcsx2_stop');report.owned_emulator_stopped=true;}}
 finally{await mcp.close();await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(report,null,2)+'\n');}
}
