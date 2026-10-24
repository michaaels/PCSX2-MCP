// node test/standalone-live.mjs <PCSX2> <built standalone fixture> <configured data root> <new output>
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length,6);
const [executable,fixture,configured,output]=process.argv.slice(2).map(p=>path.resolve(p));
await fs.mkdir(output);const root=path.join(output,'instance');await fs.mkdir(path.join(root,'inis'),{recursive:true});
await fs.copyFile(path.join(configured,'inis/PCSX2.ini'),path.join(root,'inis/PCSX2.ini'));
const digest=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json')));
assert.equal(manifest.kind,'standalone_mcp_render_fixture');
for(const [name,hash]of Object.entries(manifest.sha256)){
  assert.equal(path.basename(name),name);assert.equal(digest(await fs.readFile(path.join(fixture,name))),hash,name);}
const elf=path.join(fixture,'standalone.elf'),elfHash=manifest.sha256['standalone.elf'];
const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});
const port=s.address().port;await new Promise(ok=>s.close(ok));
const mcp=new Client({name:'standalone-mcp',version:'1.0'}),inspector=new DebugServerClient('127.0.0.1',port);
const report={kind:'standalone_mcp_smoke',started_at:new Date().toISOString(),native_sha256:digest(await fs.readFile(executable)),
 elf_sha256:elfHash,checks:[],SMS_or_Jellyfin_involved:false,physical_validation:'not_performed',audio_acceptance:'not_tested'};
let owned=false;
const passed=name=>{report.checks.push(name);console.log('PASS '+name);};
async function raw(name,args={}){return mcp.callTool({name,arguments:args},undefined,{timeout:60000});}
async function call(name,args={}){const r=await raw(name,args);assert.ok(!r.isError,name+': '+JSON.stringify(r.content));return JSON.parse(r.content[0].text);}
async function capture(name){const r=await raw('pcsx2_screenshot',{width:640,height:480});assert.ok(!r.isError,JSON.stringify(r.content));
  const block=r.content.find(c=>c.type==='image');assert.equal(block.mimeType,'image/png');
  const b=Buffer.from(block.data,'base64');await fs.writeFile(path.join(output,name),b);return b;}
try{
  await mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],
    env:{...process.env,PCSX2_DEBUG_PORT:String(port)},stderr:'pipe'}));
  report.launch=await call('pcsx2_launch',{executable,elf,data_directory:root});owned=true;await inspector.connect();
  assert.equal(report.launch.sha256??report.launch.elf_sha256,elfHash);
  for(let i=0;(await inspector.getCapabilities()).elf_crc==='0x00000000';i++){assert.ok(i<100);await delay(100);}
  report.identity=await inspector.getCapabilities();
  assert.equal(report.identity.process_id,report.launch.process_id??report.launch.pid);
  passed('MCP launches a separate owned Windows process with the exact standalone ELF hash and native identity');
  await inspector.pause();report.import_symbols=await call('pcsx2_import_symbols');
  let counter,magic;
  for(let i=0;i<40;i++){
    counter=(await inspector.lookupSymbols({query:'standalone_counter',kind:'global',exact:true})).symbols;
    magic=(await inspector.lookupSymbols({query:'standalone_magic',kind:'global',exact:true})).symbols;
    if(counter.length===1&&magic.length===1)break;await delay(50);
  }
  report.symbols=await inspector.lookupSymbols({query:'standalone',limit:40});
  assert.equal(counter.length,1);assert.equal(magic.length,1);
  const line=(await fs.readFile(path.join(fixture,'standalone.c'),'utf8')).split(/\r?\n/).findIndex(l=>l.includes('/* MCP_TICK:'))+1;
  const group=await call('pcsx2_breakpoint_source',{elf,file:'standalone.c',line,expected_sha256:elfHash});report.source_group=group;
  let events=await inspector.readEvents(0,200);while(events.events.length===200)events=await inspector.readEvents(events.next_cursor,200);
  await inspector.resume();report.breakpoint_event=await inspector.waitEvent({after:events.next_cursor,type:'breakpoint',timeoutMs:20000});
  assert.equal(report.breakpoint_event.timed_out,false);const at=await inspector.getStatus();
  assert.equal(at.paused,true);assert.ok(group.addresses.includes(at.pc));
  report.source=await call('pcsx2_source_pc');assert.equal(report.source.sha256,elfHash);
  passed('symbol import and owned file/line breakpoint stop actual homebrew execution; current PC source is hash-pinned');
  const before=await inspector.getStatus();
  assert.equal(Buffer.from(await inspector.readMemoryStrict(magic[0].address,4),'hex').readUInt32LE(),0x4d435032);
  report.registers=await inspector.readRegisters();report.disassembly=await inspector.disassemble(before.pc,4);
  assert.equal(report.disassembly.length,4);report.backtrace=await inspector.getBacktrace();
  report.variables=await call('pcsx2_variables',{elf,expected_sha256:elfHash});
  const increment=report.variables.variables.find(v=>v.name==='increment');
  assert.equal(increment.status,'available');assert.equal(increment.value,'1');
  assert.deepEqual(await inspector.getStatus(),before);
  passed('strict memory, EE registers/disassembly/backtrace and DWARF argument agree with unchanged paused CPU state');
  await assert.rejects(inspector.readMemoryStrict('0x40000000',1),/unmapped/);
  const refused=await raw('pcsx2_breakpoint_source',{elf,file:'standalone.c',line,expected_sha256:'0'.repeat(64)});
  assert.equal(refused.isError,true);assert.deepEqual(await inspector.getStatus(),before);
  passed('unmapped memory and wrong ELF hash refuse without continuing the VM');
  await call('pcsx2_remove_source_breakpoints',{group_id:group.group_id});
  const successor='0x'+(Number(before.pc)+4).toString(16).padStart(8,'0');
  await inspector.setBreakpoint(successor,{description:'standalone foreign-target control'});
  const foreign=await inspector.listBreakpoints();
  await assert.rejects(inspector.step(),/Existing breakpoint/);
  assert.deepEqual(await inspector.listBreakpoints(),foreign);assert.deepEqual(await inspector.getStatus(),before);
  await inspector.removeBreakpoint(successor);
  await inspector.step();const stepped=await inspector.getStatus();
  assert.equal(stepped.paused,true);assert.equal(Number(stepped.pc),Number(before.pc)+4);report.stepped=stepped;
  report.breakpoints_after_step=await inspector.listBreakpoints();
  assert.equal(report.breakpoints_after_step.length,0,'Legacy step must remove its private temporary breakpoint');
  await inspector.stepOver();assert.equal(Number((await inspector.getStatus()).pc),Number(stepped.pc)+4);
  assert.deepEqual(await inspector.listBreakpoints(),[]);
  const main=(await inspector.lookupSymbols({query:'main',kind:'function',exact:true})).symbols[0];
  const tick=(await inspector.lookupSymbols({query:'standalone_tick',kind:'function',exact:true})).symbols[0];
  const body=await inspector.disassemble(main.address,Math.min(100,Math.floor(main.size/4)));
  const callsite=body.find(i=>(Number(i.opcode)>>>26)===3&&((Number(i.opcode)&0x03ffffff)*4)===Number(tick.address));
  assert.ok(callsite,'Fixture main must contain a physical JAL to standalone_tick');
  await inspector.setBreakpoint(callsite.address);
  let history=await inspector.readEvents(0,200);while(history.events.length===200)history=await inspector.readEvents(history.next_cursor,200);
  await inspector.resume();assert.equal((await inspector.waitEvent({after:history.next_cursor,type:'breakpoint',timeoutMs:10000})).timed_out,false);
  assert.equal((await inspector.getStatus()).pc,callsite.address);await inspector.removeBreakpoint(callsite.address);
  await inspector.stepOver();assert.equal(Number((await inspector.getStatus()).pc),Number(callsite.address)+8);
  assert.deepEqual(await inspector.listBreakpoints(),[]);
  passed('step and step-over, including a physical call, clean their own points and preserve a foreign target breakpoint on refusal');
  // Explicit VSync advancement publishes GS output after the source breakpoint.
  const advanced=await call('pcsx2_frame_advance',{frames:3});report.frame_advance=advanced;
  assert.equal(advanced.completed,true);assert.equal(advanced.frames_advanced,3);
  const paused=await inspector.getStatus(),a=await capture('paused.png'),b=await capture('paused-repeat.png');
  assert.deepEqual(b,a);const png=PNG.sync.read(a);assert.ok(png.width>0&&png.height>0);
  const pixels=new Set();for(let i=0;i<png.data.length;i+=4)pixels.add(png.data.subarray(i,i+4).toString('hex'));
  assert.ok(pixels.size>1,'The rendered text must not be a uniform image');
  assert.deepEqual(await inspector.getStatus(),paused);report.screenshot={path:path.join(output,'paused.png'),sha256:digest(a),width:png.width,height:png.height,colors:pixels.size};
  passed('three guest VSync steps end paused; real rendered text returns identical nonuniform PNG screenshots');
  const recording=await call('pcsx2_capture_start',{frames:6,audio:false,width:320,height:240});
  assert.equal((await inspector.getStatus()).paused,true);
  await call('pcsx2_frame_advance',{frames:8});
  report.capture=await call('pcsx2_capture_status',{operation_id:recording.operation_id,wait_ms:10000});
  assert.equal(report.capture.state,'closed');assert.equal(report.capture.video_frames,6);assert.equal(report.capture.artifact.verified,true);
  assert.equal(report.capture.artifact.streams.length,1);
  assert.equal(digest(await fs.readFile(report.capture.path)),report.capture.artifact.sha256);
  assert.equal((await inspector.getStatus()).paused,true);
  passed('owned six-frame video capture closes, hashes and verifies through ffprobe without automatic resume');
  report.sif=await call('pcsx2_sif_snapshot');assert.deepEqual(await call('pcsx2_sif_snapshot'),report.sif);
  await inspector.resume();
  await assert.rejects(inspector.step(),/requires a paused VM/);
  assert.deepEqual(await inspector.listBreakpoints(),[]);
  assert.equal((await raw('pcsx2_sif_snapshot')).isError,true);
  assert.equal((await inspector.getStatus()).paused,false);await inspector.pause();
  passed('SIF reads are stable; legacy step and SIF sampling refuse a running VM without pausing or adding breakpoints');
  report.passed=true;
}catch(error){report.passed=false;report.failure=String(error);throw error;}
finally{
  inspector.disconnect();
  try{if(owned){await call('pcsx2_stop');report.owned_emulator_stopped=true;}}
  finally{await mcp.close();await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(report,null,2)+'\n');}
}
