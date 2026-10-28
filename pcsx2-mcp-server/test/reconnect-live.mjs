// node test/reconnect-live.mjs <PCSX2> <standalone render fixture> <configured root> <new output>
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
const result={kind:'standalone_reconnect_reset_restore',native_sha256:digest(await fs.readFile(executable)),
 elf_sha256:manifest.sha256['standalone.elf'],checks:[],observations:[],SMS_or_Jellyfin_involved:false,
 physical_validation:'not_performed',native_modified:false};
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
 for(let i=0;i<20;i++){
   await inspector.connect();const caps=await inspector.getCapabilities();
   assert.equal(caps.process_id,initial.process_id);assert.equal(caps.session,initial.session);assert.equal(caps.execution_epoch,initial.execution_epoch);
   assert.deepEqual(await inspector.getStatus(),paused);
 }
 passed('twenty actual socket replacements retain the same paused native process/session/ELF without old-close failures');

 const after=await cursor();const waiting=inspector.waitEvent({after,type:'vm_reset',timeoutMs:5000}).then(value=>({value}),error=>({error}));
 await delay(30);await inspector.connect();assert.ok((await waiting).error);
 const entered=deferred(),release=deferred();
 const stale=inspector.withExclusiveSession(async()=>{await inspector.getStatus();entered.resolve();await release.promise;await inspector.resume();})
   .then(value=>({value}),error=>({error}));
 await entered.promise;await inspector.connect();
 const newScope=await inspector.withExclusiveSession(async()=>{release.resolve();assert.ok((await stale).error);return inspector.getStatus();});
 assert.deepEqual(newScope,paused);assert.equal(inspector.isConnected(),true);
 passed('pending native event wait and stale exclusive resume reject across reconnect; the new owner stays paused');

 const beforeReset=await inspector.getCapabilities();await inspector.loadElf(elf);await inspector.resume();
 const reset=await ready();assert.ok(reset.execution_epoch>beforeReset.execution_epoch);assert.equal(reset.process_id,initial.process_id);
 await inspector.connect();const resetState=await inspector.getStatus();
 await assert.rejects(inspector.sifSnapshot(beforeReset),/identity changed/);
 await assert.rejects(inspector.step('ee',100,{...beforeReset,pc:paused.pc}),/identity changed/);
 assert.deepEqual(await inspector.getStatus(),resetState);assert.deepEqual(await inspector.listBreakpoints(),[]);
 result.observations.push({case:'elf_reset',before:beforeReset,after:reset});
 passed('real ELF reset advances native epoch; after reconnect old snapshot/step identities refuse without mutations');

 const symbols=(await inspector.lookupSymbols({query:'standalone_counter',kind:'global',exact:true})).symbols;assert.equal(symbols.length,1);
 const counter=symbols[0].address,savedHex=await inspector.readMemoryStrict(counter,4);const saveStatus=await inspector.getStatus();
 await pine.connect();await pine.saveState(4);let saved;
 for(let n=0;n<200;n++){
   const filename=(await fs.readdir(states).catch(()=>[])).find(name=>name.endsWith('.04.p2s'));
   if(filename){const b=await fs.readFile(path.join(states,filename));if(b.length>=22&&b.readUInt32LE(b.length-22)===0x06054b50){saved={path:path.join(states,filename),sha256:digest(b),bytes:b.length};break;}}
   await delay(50);
 }
 assert.ok(saved,'No finalized ZIP savestate');assert.deepEqual(await inspector.getStatus(),saveStatus);
 await inspector.advanceFrames(5);const laterHex=await inspector.readMemoryStrict(counter,4);assert.notEqual(laterHex,savedHex);
 result.savestate=saved;result.counter={address:counter,saved_hex:savedHex,before_restore_hex:laterHex};
 passed('actual PINE save finalizes a private ZIP while paused; five guest frames change the saved counter');

 const beforeRestore=await inspector.getCapabilities();const oldPc=(await inspector.getStatus()).pc;
 await pine.loadState(4);await inspector.connect();
 let restored;
 for(let n=0;n<200;n++){restored=await inspector.getCapabilities();if(restored.execution_epoch>beforeRestore.execution_epoch)break;assert.ok(n<199);await delay(50);}
 assert.equal((await inspector.getStatus()).paused,true);assert.equal(await inspector.readMemoryStrict(counter,4),savedHex);
 await assert.rejects(inspector.sifSnapshot(beforeRestore),/identity changed/);
 await assert.rejects(inspector.step('ee',100,{...beforeRestore,pc:oldPc}),/identity changed/);
 result.observations.push({case:'restore',before:beforeRestore,after:restored,counter_hex:await inspector.readMemoryStrict(counter,4)});
 assert.deepEqual(await inspector.listBreakpoints(),[]);assert.equal(inspector.isConnected(),true);
 const fresh=await call('pcsx2_sif_snapshot');assert.equal(fresh.execution_epoch,restored.execution_epoch);
 passed('real savestate restore recovers exact RAM, rejects pre-restore identities and allows fresh MCP inspection after reconnect');
 result.passed=true;
}catch(error){result.passed=false;result.failure=String(error);throw error;}
finally{
 inspector.disconnect();pine.disconnect();
 try{if(owned){await call('pcsx2_stop');result.owned_emulator_stopped=true;}}
 finally{await mcp.close();await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(result,null,2)+'\n');}
}
