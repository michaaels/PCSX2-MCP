// Bounded-step GUI replacement acceptance on an owned fixture instance.
// Supervised GUI test: node inflight-gui-live.mjs <PCSX2> <instruction fixture> <configured root> <new output>
// A human or the Windows computer-use tool edits Qt. This script uses only MCP/native protocol,
// never UI automation. An explicit actor attestation is required after native proof.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DebugServerClient } from '../dist/debug-server-client.js';

assert.equal(process.argv.length,6);
const [executable,input,configured,output]=process.argv.slice(2).map(value=>path.resolve(value));
await fs.mkdir(output);
const fixture=path.join(output,'fixture'),root=path.join(output,'instance');
await fs.cp(input,fixture,{recursive:true});await fs.mkdir(path.join(root,'inis'),{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(await fs.readFile(path.join(fixture,'manifest.json'),'utf8'));
assert.equal(manifest.kind,'standalone_instruction_fixture');
for(const [name,sha]of Object.entries(manifest.sha256)){
 assert.equal(path.basename(name),name);assert.equal(hash(await fs.readFile(path.join(fixture,name))),sha);
}
let ini=await fs.readFile(path.join(configured,'inis/PCSX2.ini'),'utf8');
function setting(section,key,value){
 ini=ini.replace(new RegExp(`^${key}\\s*=.*\\r?\\n`,'gm'),'');
 const marker=new RegExp(`^\\[${section}\\]\\r?\\n`,'m');
 ini=marker.test(ini)?ini.replace(marker,`[${section}]\n${key} = ${value}\n`):ini+`\n[${section}]\n${key} = ${value}\n`;
}
setting('EmuCore','HostFs','true');setting('UI','ShowAdvancedSettings','true');
setting('UI','AdvancedSettingsWarningShown','true');
await fs.writeFile(path.join(root,'inis/PCSX2.ini'),ini);
const listener=createServer();await new Promise((ok,no)=>{listener.once('error',no);listener.listen(0,'127.0.0.1',ok);});
const port=listener.address().port;await new Promise(ok=>listener.close(ok));
const inspector=new DebugServerClient('127.0.0.1',port),mcp=new Client({name:'supervised-gui-ownership',version:'1.0'});
const elf=path.join(fixture,'instruction-control.elf'),ee=await fs.readFile(elf);
const report={kind:'supervised_gui_breakpoint_ownership',created_at:new Date().toISOString(),
 native_sha256:hash(await fs.readFile(executable)),elf_sha256:hash(ee),debug_port:port,
 executable,elf,data_directory:root,checks:[],attempts:[],passed:null,
 GUI_action_confirmed:false,GUI_automated:false,SMS_or_Jellyfin_involved:false,physical_validation:'not_performed'};
const controlPath=path.join(output,'control.json'),sessionPath=path.join(output,'session.json');
await fs.writeFile(controlPath,JSON.stringify({sequence:0,action:'wait'}));
async function status(phase,extra={}){
 report.phase=phase;Object.assign(report,extra);
 await fs.writeFile(sessionPath,JSON.stringify(report,null,2)+'\n');console.log(phase);
}
function symbol(name){
 const offset=ee.readUInt32LE(32),stride=ee.readUInt16LE(46),count=ee.readUInt16LE(48);
 for(let i=0;i<count;i++){
  const header=offset+i*stride;if(ee.readUInt32LE(header+4)!==2)continue;
  const strings=ee.readUInt32LE(offset+ee.readUInt32LE(header+24)*stride+16);
  const start=ee.readUInt32LE(header+16),end=start+ee.readUInt32LE(header+20),size=ee.readUInt32LE(header+36);assert.ok(size>=16);
  for(let item=start;item<end;item+=size){const nameAt=strings+ee.readUInt32LE(item);
   if(ee.subarray(nameAt,ee.indexOf(0,nameAt)).toString()===name)return ee.readUInt32LE(item+4);}
 }
 throw new Error('Missing fixture symbol '+name);
}
const hex=value=>'0x'+value.toString(16).padStart(8,'0');
async function raw(name,args={}){return mcp.callTool({name,arguments:args},undefined,{timeout:20000});}
async function call(name,args={}){const reply=await raw(name,args);assert.ok(!reply.isError,JSON.stringify(reply));return JSON.parse(reply.content[0].text);}
async function cursor(){let h=await inspector.readEvents(0,200);while(h.events.length===200)h=await inspector.readEvents(h.next_cursor,200);return h.next_cursor;}
let child,log;
try{
 log=await fs.open(path.join(output,'native-stdout.log'),'wx');
 child=spawn(executable,['-portable','-debugger',elf],{cwd:path.dirname(executable),windowsHide:true,
  env:{...process.env,PCSX2_DEBUG_PORT:String(port),PCSX2_MCP_DATA_DIR:root},stdio:['ignore',log.fd,log.fd]});
 const started=new Promise((ok,no)=>{child.once('spawn',ok);child.once('error',no);});await started;report.pid=child.pid;
 await status('launching');
 let connected=false;
 for(let n=0;n<200;n++){
  if(child.exitCode!==null)throw new Error('Owned emulator exited before connection: '+child.exitCode);
  try{await inspector.connect();connected=true;break;}catch{await delay(100);}
 }
 assert.ok(connected,'Native DebugServer did not start');
 const caps=await inspector.getCapabilities();assert.equal(caps.process_id,child.pid);assert.equal(path.resolve(caps.data_directory),root);
 assert.ok(caps.features.includes('bounded_instruction_step'));assert.ok(caps.features.includes('guarded_state_load'));
 report.initial_identity=caps;
 await mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],
  env:{...process.env,PCSX2_DEBUG_PORT:String(port)},stderr:'pipe'}));
 const connectionReply=await raw('pcsx2_connect',{mode:'debug',debug_port:port});assert.ok(!connectionReply.isError);
 await inspector.pause();await delay(200);
 const ready=hex(symbol('instruction_ready'));await inspector.setBreakpoint(ready,{description:'GUI fixture ready'});
 const after=await cursor();await inspector.resume();
 assert.equal((await inspector.waitEvent({after,type:'breakpoint',timeoutMs:20000})).timed_out,false);
 assert.equal((await inspector.getStatus()).pc,ready);await inspector.removeBreakpoint(ready);
 const pc=hex(symbol('fixture_hang_call')),target=hex(symbol('fixture_hang_return'));
 assert.equal(Number(target),Number(pc)+8);report.step_pc=pc;report.target=target;report.gui_description='GUI-OWNED';
 await inspector.setPC(pc);assert.deepEqual(await inspector.listBreakpoints('ee'),[]);
 const control=await raw('pcsx2_step_over',{cpu:'ee',timeout_ms:100});
 assert.equal(control.isError,true);assert.match(JSON.stringify(control.content),/timed out/);
 assert.equal((await inspector.getStatus()).paused,true);assert.deepEqual(await inspector.listBreakpoints('ee'),[]);
 report.control=control;report.checks.push('Unmodified private step target times out, cleans up and leaves the owned VM paused');
 await inspector.setPC(pc);
 await status('awaiting_gui_setup');
 const deadline=Date.now()+20*60*1000;let sequence=0;
 while(Date.now()<deadline){
  if(child.exitCode!==null)throw new Error('Owned emulator closed during supervised test');
  let command;try{command=JSON.parse(await fs.readFile(controlPath,'utf8'));}catch{await delay(250);continue;}
  if(!Number.isInteger(command.sequence)||command.sequence<=sequence){await delay(250);continue;}
  sequence=command.sequence;
  if(command.action==='stop'){await status('stopped_by_operator');break;}
  if(command.action==='confirm'){
   assert.equal(report.phase,'awaiting_human_confirmation');
   const points=await inspector.listBreakpoints('ee');assert.ok(points.some(point=>point.address===target&&point.description==='GUI-OWNED'));
   assert.ok(command.actor==='human'||command.actor==='computer-use');
   report.GUI_action_confirmed=true;report.GUI_automated=command.actor==='computer-use';report.actor=command.actor;report.passed=true;
   report.checks.push('Actor confirmed the real Qt GUI action; native point remained available for review');
   await status('accepted');break;
  }
  if(command.action!=='start')continue;
  if(report.phase==='awaiting_human_confirmation')continue;
  const beforePoints=await inspector.listBreakpoints('ee');
  if(beforePoints.length){await status('awaiting_remove_early_point',{before_points:beforePoints});continue;}
  assert.equal((await inspector.getStatus()).paused,true);await inspector.setPC(pc);
  await status('countdown',{step_starts_at:Date.now()+Math.max(0,Math.min(60000,Number(command.delay_ms??15000)))});await delay(Math.max(0,Math.min(60000,Number(command.delay_ms??15000))));
  const attempt={started_at:new Date().toISOString(),before:await inspector.getCapabilities(),before_points:await inspector.listBreakpoints('ee')};
  if(attempt.before_points.length){await status('awaiting_remove_early_point',{before_points:attempt.before_points});continue;}
  await status('running_step');attempt.reply=await raw('pcsx2_step_over',{cpu:'ee',timeout_ms:5000});
  attempt.after=await inspector.getCapabilities();attempt.status=await inspector.getStatus();attempt.points=await inspector.listBreakpoints('ee');
  attempt.finished_at=new Date().toISOString();report.attempts.push(attempt);
  const ownershipError=attempt.reply.isError===true&&/changed ownership; preserved, cleanup unconfirmed/.test(JSON.stringify(attempt.reply.content));
  const point=attempt.points.find(point=>point.address===target&&point.description==='GUI-OWNED');
  if(ownershipError&&point){
   assert.equal(attempt.status.paused,true);assert.equal(attempt.before.execution_epoch,attempt.after.execution_epoch);
   assert.equal(attempt.before.process_id,attempt.after.process_id);assert.equal(attempt.before.session,attempt.after.session);
   report.checks.push('MCP refused successful cleanup and preserved the GUI-owned breakpoint in the same paused VM');
   await status('awaiting_human_confirmation');
  }else{
   await status('not_exercised',{note:'No qualifying GUI ownership change during the step; not accepted. Prepare again and send a higher sequence.'});
  }
 }
 if(report.passed!==true){process.exitCode=1;if(report.phase!=='stopped_by_operator')await status('expired_without_acceptance');}
}catch(error){report.passed=false;report.error=String(error);await status('failed');process.exitCode=1;}
finally{
 inspector.disconnect();await mcp.close().catch(()=>{});
 if(child&&child.exitCode===null){
  const stopped=new Promise(ok=>child.once('exit',ok));child.kill();await Promise.race([stopped,delay(5000)]);
 }
 report.owned_emulator_stopped=!!child&&(child.exitCode!==null||child.signalCode!==null);await log?.close();
 await fs.writeFile(path.join(output,'validation.json'),JSON.stringify(report,null,2)+'\n');
}
