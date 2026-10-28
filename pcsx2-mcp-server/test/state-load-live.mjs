// node test/state-load-live.mjs <PCSX2> <standalone render fixture> <configured root> <new output>
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
import { performStateLoad } from '../dist/state-tools.js';

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
const result={kind:'guarded_state_load_validation',native_sha256:digest(await fs.readFile(executable)),
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
 const initial=await ready(),paused=await inspector.getStatus();result.initial=initial;
 const symbols=(await inspector.lookupSymbols({query:'standalone_counter',kind:'global',exact:true})).symbols;assert.equal(symbols.length,1);
 const counter=symbols[0].address,initialCounter=await inspector.readMemoryStrict(counter,4);
 async function raw(name,args={}){return mcp.callTool({name,arguments:args},undefined,{timeout:60000});}
 async function load(slot){const r=await raw('pcsx2_load_state',{slot});const data=JSON.parse(r.content[0].text);result.observations.push({case:'load_slot_'+slot,mcp:r});return{r,data};}
 const missing=await load(8);assert.equal(missing.r.isError,true);assert.equal(missing.data.outcome,'failed');assert.equal(missing.data.loaded,false);
 assert.equal(missing.data.completion_confirmed,true);assert.deepEqual(missing.data.receipt.before,missing.data.receipt.after);
 assert.deepEqual(await inspector.getStatus(),paused);assert.equal(await inspector.readMemoryStrict(counter,4),initialCounter);
 assert.equal((await call('pcsx2_load_state_status',{operation_id:missing.data.operation_id})).loaded,false);
 passed('empty slot produces an observed native failure, not Loaded; paused CPU/RAM and epoch remain unchanged');

 const abort=new AbortController();abort.abort();const beforeCancel=await inspector.getCapabilities();
 const cancelled=await performStateLoad(inspector,null,4,abort.signal);result.observations.push({case:'pre_cancel',result:cancelled});
 assert.equal(cancelled.outcome,'cancelled_before_dispatch');assert.equal(cancelled.request_dispatched,false);
 assert.deepEqual(await inspector.getCapabilities(),beforeCancel);assert.deepEqual(await inspector.getStatus(),paused);
 assert.equal((await inspector.stateLoadReceipt(missing.data.operation_id)).operation_id,missing.data.operation_id);
 passed('pre-cancelled load sends no mutation and does not overwrite the prior native receipt');

 const linked=await raw('pcsx2_connect',{mode:'pine',pine_port:pinePort});assert.ok(!linked.isError);await pine.connect();
 const savedReply=await call('pcsx2_save_state',{slot:4});assert.equal(savedReply.outcome,'queued_unconfirmed');assert.equal(savedReply.completion_confirmed,false);
 const savedCounter=await inspector.readMemoryStrict(counter,4);let saved;
 for(let n=0;n<200;n++){
   const filename=(await fs.readdir(states).catch(()=>[])).find(name=>name.endsWith('.04.p2s'));
   if(filename){const b=await fs.readFile(path.join(states,filename));if(b.length>=22&&b.readUInt32LE(b.length-22)===0x06054b50){saved={path:path.join(states,filename),sha256:digest(b),bytes:b.length};break;}}
   await delay(50);
 }
 assert.ok(saved);result.savestate=saved;await inspector.advanceFrames(4);
 assert.notEqual(await inspector.readMemoryStrict(counter,4),savedCounter);const beforeLoad=await inspector.getCapabilities();
 const success=await load(4);assert.ok(!success.r.isError);assert.equal(success.data.outcome,'loaded');assert.equal(success.data.loaded,true);
 assert.equal(success.data.completion_confirmed,true);assert.ok(success.data.receipt.after.execution_epoch>beforeLoad.execution_epoch);
 assert.equal(await inspector.readMemoryStrict(counter,4),savedCounter);await assert.rejects(inspector.sifSnapshot(beforeLoad),/identity changed/);
 result.counter={address:counter,saved_hex:savedCounter,restored_hex:await inspector.readMemoryStrict(counter,4)};
 passed('save acknowledgement stays unconfirmed; finalized ZIP restores exact RAM through the new guarded MCP native result');

 const corrupt=path.join(states,path.basename(saved.path).replace('.04.p2s','.05.p2s'));
 assert.equal(path.dirname(corrupt),states);await fs.writeFile(corrupt,'PCSX2 fixture: invalid ZIP\n',{flag:'wx'});
 let prior=await inspector.getCapabilities(),cpu=await inspector.getStatus(),ram=await inspector.readMemoryStrict(counter,4);
 const failed=await load(5);assert.equal(failed.r.isError,true);assert.equal(failed.data.outcome,'failed');assert.equal(failed.data.loaded,false);
 assert.ok(failed.data.receipt.error.length>0);assert.ok(failed.data.receipt.after.execution_epoch>prior.execution_epoch);
 await assert.rejects(inspector.sifSnapshot(prior),/identity changed/);assert.deepEqual(await inspector.getStatus(),cpu);assert.equal(await inspector.readMemoryStrict(counter,4),ram);
 passed('corrupt ZIP is a confirmed load failure, advances attempt epoch and invalidates stale inspection without false success');

 const emptyZip=path.join(states,path.basename(saved.path).replace('.04.p2s','.06.p2s'));assert.equal(path.dirname(emptyZip),states);
 await fs.writeFile(emptyZip,Buffer.from('504b0506000000000000000000000000000000000000','hex'),{flag:'wx'});
 prior=await inspector.getCapabilities();cpu=await inspector.getStatus();ram=await inspector.readMemoryStrict(counter,4);
 const empty=await load(6);assert.equal(empty.r.isError,true);assert.equal(empty.data.outcome,'failed');assert.ok(empty.data.receipt.error.length>0);
 assert.ok(empty.data.receipt.after.execution_epoch>prior.execution_epoch);assert.equal(await inspector.readMemoryStrict(counter,4),ram);
 assert.deepEqual(await inspector.getStatus(),cpu);
 result.invalid_fixtures=[{path:corrupt,sha256:digest(await fs.readFile(corrupt))},{path:emptyZip,sha256:digest(await fs.readFile(emptyZip))}];
 passed('a valid ZIP lacking savestate content also reports failure with an attempt boundary and unchanged tested RAM');

 const current=await inspector.getCapabilities();await inspector.resume();const running=await load(4);
 assert.equal(running.data.outcome,'not_dispatched');assert.equal((await inspector.getStatus()).paused,false);await inspector.pause();
 const stopped=await inspector.getStatus();const fresh=await inspector.getCapabilities();
 await assert.rejects(inspector.requestStateLoad('e'.repeat(32),4,{...fresh,execution_epoch:fresh.execution_epoch-1}),e=>{assert.equal(e.native_refused,true);return true;});
 assert.deepEqual(await inspector.getStatus(),stopped);assert.equal((await inspector.getCapabilities()).execution_epoch,current.execution_epoch);
 passed('running-VM and native stale-identity guards refuse a load without auto-pausing or executing it');

 await raw('pcsx2_connect',{mode:'debug',debug_port:1});const fallback=await load(8);
 assert.ok(!fallback.r.isError);assert.equal(fallback.data.backend,'pine');assert.equal(fallback.data.outcome,'queued_unconfirmed');
 assert.equal(fallback.data.loaded,null);assert.equal(fallback.data.completion_confirmed,false);
 await raw('pcsx2_connect',{mode:'debug',debug_port:port});
 passed('PINE-only load of an empty slot reports queued/unconfirmed and never claims restoration');

 await inspector.connect();const retained=await call('pcsx2_load_state_status',{operation_id:empty.data.operation_id});
 assert.equal(retained.loaded,false);assert.equal(retained.receipt.slot,6);assert.equal(retained.completion_confirmed,true);
 const lost=await raw('pcsx2_load_state_status',{operation_id:success.data.operation_id});assert.equal(lost.isError,true);
 assert.equal(JSON.parse(lost.content[0].text).outcome,'unavailable_or_unknown');
 const cap=await inspector.getCapabilities(),status=await inspector.getStatus();
 await assert.rejects(inspector.requestStateLoad(empty.data.operation_id,6,cap),/already used/);
 assert.deepEqual(await inspector.getStatus(),status);assert.deepEqual(await inspector.getCapabilities(),cap);
 result.retained_status=retained;
 passed('receipt survives reconnect, replaced receipts remain unknown and duplicate operation ID refuses another load');
 result.passed=true;
}catch(error){result.passed=false;result.failure=String(error);throw error;}
finally{
 inspector.disconnect();pine.disconnect();
 try{if(owned){await call('pcsx2_stop');result.owned_emulator_stopped=true;}}
 finally{await mcp.close();await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2)+'\n');}
}
