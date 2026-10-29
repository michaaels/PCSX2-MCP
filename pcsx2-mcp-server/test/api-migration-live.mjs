// node test/api-migration-live.mjs <PCSX2> <standalone render fixture> <configured root> <new output>
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
import { PineClient } from '../dist/pine-client.js';

assert.equal(process.argv.length,6);
const [executable,fixture,configured,output]=process.argv.slice(2).map(p=>path.resolve(p));
await fs.mkdir(output);const root=path.join(output,'instance'),states=path.join(root,'sstates');
await fs.mkdir(path.join(root,'inis'),{recursive:true});
const digest=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json')));
assert.equal(manifest.kind,'standalone_mcp_render_fixture');
for(const [name,hash]of Object.entries(manifest.sha256)){assert.equal(path.basename(name),name);assert.equal(digest(await fs.readFile(path.join(fixture,name))),hash);}
async function freePort(){const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});
 const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
const port=await freePort(),pinePort=await freePort();assert.notEqual(port,pinePort);
let ini=await fs.readFile(path.join(configured,'inis/PCSX2.ini'),'utf8');
function setting(section,key,value){const marker=new RegExp(`^\\[${section}\\]\\r?\\n`,'m');
 ini=ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`,'gm'),'');
 ini=marker.test(ini)?ini.replace(marker,`[${section}]\n${key} = ${value}\n`):ini+`\n[${section}]\n${key} = ${value}\n`;}
setting('EmuCore','EnablePINE','true');setting('EmuCore','PINESlot',pinePort);setting('Folders','Savestates',states);
await fs.writeFile(path.join(root,'inis/PCSX2.ini'),ini);
const elf=path.join(fixture,'standalone.elf'),mcp=new Client({name:'reconnect-live',version:'1.0'});
const inspector=new DebugServerClient('127.0.0.1',port),pine=new PineClient('127.0.0.1',pinePort);
const result={kind:'native_api_migration',native_sha256:digest(await fs.readFile(executable)),
 elf_sha256:manifest.sha256['standalone.elf'],checks:[],observations:[],SMS_or_Jellyfin_involved:false,
 physical_validation:'not_performed',native_modified:true};
const passed=t=>{result.checks.push(t);console.log('PASS '+t);};
const deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok;});return{promise,resolve};};
let owned=false;
async function call(name,args={}){const r=await mcp.callTool({name,arguments:args},undefined,{timeout:60000});assert.ok(!r.isError,JSON.stringify(r.content));return JSON.parse(r.content[0].text);}
async function cursor(){let h=await inspector.readEvents(0,200);while(h.events.length===200)h=await inspector.readEvents(h.next_cursor,200);return h.next_cursor;}
async function ready(){
 for(let i=0;(await inspector.getCapabilities()).elf_crc==='0x00000000';i++){assert.ok(i<150);await delay(100);}
 await inspector.pause();await inspector.lookupSymbols({query:'standalone_tick',kind:'function',exact:true});
 await call('pcsx2_import_symbols');let tick;
 for(let i=0;i<100;i++){tick=(await inspector.lookupSymbols({query:'standalone_tick',kind:'function',exact:true})).symbols;
   if(tick.length===1)break;await delay(20);}
 assert.equal(tick.length,1);await inspector.setBreakpoint(tick[0].address);
 const after=await cursor();await inspector.resume();assert.equal((await inspector.waitEvent({after,type:'breakpoint',timeoutMs:15000})).timed_out,false);
 assert.equal((await inspector.getStatus()).pc,tick[0].address);await inspector.removeBreakpoint(tick[0].address);
 return inspector.getCapabilities();
}

try{
 await mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],
  env:{...process.env,PCSX2_DEBUG_PORT:String(port)},stderr:'pipe'}));
 result.launch=await call('pcsx2_launch',{executable,elf,data_directory:root});owned=true;await inspector.connect();
 const initial=await ready();result.initial=initial;
 assert.equal(path.normalize(initial.elf.replace(/^host\d*:/,'')),path.normalize(elf));
 const copyDir=path.join(output,'other');await fs.mkdir(copyDir);const copy=path.join(copyDir,'standalone.elf');
 await fs.copyFile(elf,copy);assert.equal(digest(await fs.readFile(copy)),manifest.sha256['standalone.elf']);
 const source=await fs.readFile(path.join(fixture,'standalone.c'),'utf8'),line=source.split(/\r?\n/).findIndex(v=>v.includes('MCP_TICK:'))+1;
 const before=await inspector.getStatus();
 const refused=await mcp.callTool({name:'pcsx2_breakpoint_source',arguments:{elf:copy,file:'standalone.c',line,expected_sha256:manifest.sha256['standalone.elf']}},undefined,{timeout:60000});
 assert.equal(refused.isError,true);assert.match(JSON.stringify(refused.content),/path\/CRC/);assert.deepEqual(await inspector.getStatus(),before);
 assert.deepEqual(await inspector.listBreakpoints('ee'),[]);result.path_refusal=refused;
 passed('HostFs identity retains the exact local ELF path and refuses another directory with the same basename, bytes and CRC');
 const counter=(await inspector.lookupSymbols({query:'standalone_counter',kind:'global',exact:true})).symbols;assert.equal(counter.length,1);
 const address=counter[0].address,end='0x'+(Number(address)+4).toString(16),saved=await inspector.readMemoryStrict(address,4);
 assert.equal(await inspector.writeMemory(address,'78563412'),4);assert.equal(await inspector.readMemoryStrict(address,4),'78563412');
 assert.equal(await inspector.writeMemory(address,saved),4);assert.equal(await inspector.readMemoryStrict(address,4),saved);
 passed('new native memory API writes and reads exact mapped bytes, then restores the fixture value');
 await assert.rejects(inspector.writeMemory('0x40000000','41'),/refused after 0 bytes/);
 assert.equal(await inspector.readMemoryStrict(address,4),saved);assert.deepEqual(await inspector.getStatus(),before);
 passed('unmapped native writes report zero completed bytes instead of false success');
 const edge='0x01ffffff';assert.equal(await inspector.isValidAddress(edge),true);assert.equal(await inspector.isValidAddress('0x02000000'),false);
 const edgeSaved=await inspector.readMemoryStrict(edge,1);
 try{
  await assert.rejects(inspector.writeMemory(edge,'4142'),/refused after 1 bytes/);
  assert.equal(await inspector.readMemoryStrict(edge,1),'41');
 }finally{assert.equal(await inspector.writeMemory(edge,edgeSaved),1);}
 assert.equal(await inspector.readMemoryStrict(edge,1),edgeSaved);
 passed('a boundary-crossing write reports its actual partial byte count and the fixture byte is restored');
 const tick=(await inspector.lookupSymbols({query:'standalone_tick',kind:'function',exact:true})).symbols;assert.equal(tick.length,1);
 async function logCursor(){let h=await inspector.readLogs(0,200);while(h.logs.length===200)h=await inspector.readLogs(h.next_cursor,200);return h.next_cursor;}
 async function stopAtTick(){
  await inspector.setBreakpoint(tick[0].address);const after=await cursor();await inspector.resume();
  assert.equal((await inspector.waitEvent({after,type:'breakpoint',timeoutMs:5000})).timed_out,false);
  assert.equal((await inspector.getStatus()).pc,tick[0].address);await inspector.removeBreakpoint(tick[0].address);
 }
 for(const action of ['break','log','both']){
  await stopAtTick();const registers=await inspector.readRegisters('ee',0),returnPC='0x'+(Number(BigInt('0x'+registers.GPR.regs[31].value)&0xffffffffn)).toString(16).padStart(8,'0');
  const counterBefore=Buffer.from(await inspector.readMemoryStrict(address,4),'hex').readUInt32LE();
  await inspector.setBreakpoint(returnPC,{description:'one fixture call only'});
  await inspector.setMemcheck(address,end,{action,type:'write',description:'migration '+action});
  const after=await cursor(),logsAfter=await logCursor();await inspector.resume();
  const event=await inspector.waitEvent({after,type:action==='log'?'breakpoint':'watchpoint',timeoutMs:5000});
  assert.equal(event.timed_out,false);assert.equal((await inspector.getStatus()).paused,true);
  const checks=await inspector.listMemchecks('ee');assert.equal(checks.length,1);assert.equal(checks[0].hits,1);
  const logs=await inspector.readLogs(logsAfter,200);
  if(action!=='break')assert.ok(logs.logs.some(v=>v.message.includes('Hit write breakpoint @')));
  if(action==='log'){
   assert.equal((await inspector.getStatus()).pc,returnPC);
   assert.equal(Buffer.from(await inspector.readMemoryStrict(address,4),'hex').readUInt32LE(),(counterBefore+1)>>>0);
  }
  result.observations.push({action,event,checks,logs,pc:(await inspector.getStatus()).pc});
  await inspector.removeMemcheck(address,end);await inspector.removeBreakpoint(returnPC);
  assert.deepEqual(await inspector.listMemchecks('ee'),[]);assert.deepEqual(await inspector.listBreakpoints('ee'),[]);
  passed('native '+action+' watchpoint records its actual hit count'+(action==='log'?' and continues to the separate return breakpoint':action==='both'?' and logs before pausing':' and pauses'));
 }
 result.passed=true;
}catch(error){result.passed=false;result.failure=String(error);throw error;}
finally{
 inspector.disconnect();pine.disconnect();try{if(owned){await call('pcsx2_stop');result.owned_emulator_stopped=true;}}
 finally{await mcp.close();await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2)+'\n');}
}
