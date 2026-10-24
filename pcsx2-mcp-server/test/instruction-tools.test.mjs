import assert from 'node:assert/strict';
import test from 'node:test';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { runInstructionSteps, instructionOptions } from '../dist/instruction-tools.js';
import { debugServer } from './fixtures.mjs';

const hex=n=>'0x'+n.toString(16).padStart(8,'0');
const identity={process_id:42,session:1,execution_epoch:2,iop_reset_epoch:3,iop_lifetime_epoch:4,elf:'game.elf',elf_crc:'0x12345678'};
async function setup(t,override=()=>undefined){
 let pc=0x100000,paused=true;
 const state={identity:{...identity},features:['bounded_instruction_step']};
 const mock=await debugServer(t,async r=>{
   const custom=await override(r,state);if(custom!==undefined)return custom;
   if(r.cmd==='capabilities')return{...state.identity,ok:true,protocol_version:2,features:state.features};
   if(r.cmd==='status')return{ok:true,data:{alive:true,paused:state.running?false:paused,pc:hex(pc),cycles:5}};
   if(r.cmd==='read_registers')return{ok:true,data:{pc:hex(pc),GPR:{regs:[{name:'t0',value:'1',display:'0x1'}]}}};
   if(r.cmd==='step'||r.cmd==='step_over'){
     const old=pc;pc+=r.cmd==='step'?4:8;
     return{...state.identity,ok:true,cpu:r.cpu,old_pc:hex(old),new_pc:hex(pc),disasm:'nop',opcode:hex(0),paused:true,cleanup_confirmed:true};
   }
   throw new Error('Unexpected command '+r.cmd);
 });
 const client=new DebugServerClient('127.0.0.1',mock.port);await client.connect();t.after(()=>client.disconnect());
 return{client,mock,state};
}
test('EE/IOP steps send native PC/epoch guards, bounded timeouts and preserve structured register results',async t=>{
 for(const cpu of ['ee','iop']){
   const {client,mock}=await setup(t);
   const result=await runInstructionSteps(client,{cpu,count:2,timeout_ms:1000,show_registers:true});
   assert.equal(result.completed,true);assert.equal(result.cpu,cpu);assert.equal(result.steps.length,2);assert.equal(result.registers.pc,'0x00100008');
   const requests=mock.requests.filter(r=>r.cmd==='step');assert.equal(requests.length,2);
   for(const [i,r]of requests.entries()){
     assert.equal(r.cpu,cpu);assert.equal(r.expected_pc,hex(0x100000+4*i));assert.equal(r.expected_process_id,42);
     assert.equal(r.expected_iop_lifetime_epoch,4);assert.ok(r.timeout_ms>=10&&r.timeout_ms<=1000);
   }
   assert.ok(mock.requests.every(r=>['capabilities','status','read_registers','step'].includes(r.cmd)));
 }
 const {client,mock}=await setup(t);
 assert.equal((await runInstructionSteps(client,{timeout_ms:10})).steps.length,1);
 assert.equal(mock.requests.find(r=>r.cmd==='step').timeout_ms,10);
});
test('count and deadline reject fractional/out-of-bounds input before native calls; step-over cannot loop',async t=>{
 const {client,mock}=await setup(t);
 for(const bad of [{count:1.5},{count:0},{count:101},{timeout_ms:9},{timeout_ms:5001},{timeout_ms:10.5},{cpu:'vu0'}])
   await assert.rejects(runInstructionSteps(client,bad));
 await assert.rejects(runInstructionSteps(client,{count:2},true),/exactly one/);
 await assert.rejects(client.step('ee',5001));assert.equal(mock.requests.length,0);
 assert.deepEqual(instructionOptions.parse({}),{cpu:'ee',count:1,timeout_ms:1000,show_registers:false});
});
test('feature/running/cancelled preconditions refuse without execution or pause/resume commands',async t=>{
 for(const reason of ['feature','running','cancelled']){
   const {client,mock,state}=await setup(t);if(reason==='feature')state.features=[];if(reason==='running')state.running=true;
   const abort=new AbortController();if(reason==='cancelled')abort.abort(new Error('cancelled'));
   await assert.rejects(runInstructionSteps(client,{},false,abort.signal));
   assert.ok(!mock.requests.some(r=>['step','step_over','pause','resume'].includes(r.cmd)));
 }
});
test('native timeout/refusal keeps partial successful steps and prevents the rest of the sequence',async t=>{
 let count=0;const {client,mock}=await setup(t,r=>{if(r.cmd==='step'&&++count===2)return{ok:false,error:'Instruction step timed out; VM paused and owned breakpoint removed'};});
 await assert.rejects(runInstructionSteps(client,{count:3}),e=>{assert.match(e.message,/timed out/);assert.equal(e.partial.steps.length,1);return true;});
 assert.equal(mock.requests.filter(r=>r.cmd==='step').length,2);
 assert.equal((await client.getStatus()).paused,true);
});
test('mismatched CPU, identity, PC and unconfirmed cleanup discard the step response without another instruction',async t=>{
 for(const patch of [{cpu:'iop'},{session:99},{old_pc:hex(3)},{cleanup_confirmed:false}]){
   const {client,mock}=await setup(t,r=>r.cmd==='step'?{...identity,ok:true,cpu:'ee',old_pc:hex(0x100000),new_pc:hex(0x100004),
     disasm:'nop',opcode:hex(0),paused:true,cleanup_confirmed:true,...patch}:undefined);
   await assert.rejects(runInstructionSteps(client,{count:2}),e=>{assert.equal(e.partial.steps.length,0);return true;});
   assert.equal(mock.requests.filter(r=>r.cmd==='step').length,1);
 }
});
test('IOP epoch changes stop an IOP sequence while unrelated IOP boundaries do not invalidate EE steps',async t=>{
 for(const cpu of ['ee','iop']){
   let steps=0;const {client,mock}=await setup(t,(r,s)=>{if(r.cmd==='step'&&++steps===1)s.identity.iop_lifetime_epoch++;});
   if(cpu==='iop')await assert.rejects(runInstructionSteps(client,{cpu,count:2}),/IOP identity/);
   else assert.equal((await runInstructionSteps(client,{cpu,count:2})).steps.length,2);
   assert.equal(mock.requests.filter(r=>r.cmd==='step').length,cpu==='iop'?1:2);
 }
});
test('cancellation after a native result retains the executed step and does not issue a second command',async t=>{
 const abort=new AbortController();const {client,mock}=await setup(t,r=>{if(r.cmd==='step')abort.abort(new Error('cancelled after native result'));});
 await assert.rejects(runInstructionSteps(client,{count:3},false,abort.signal),e=>{assert.equal(e.partial.steps.length,1);return true;});
 assert.equal(mock.requests.filter(r=>r.cmd==='step').length,1);
});
test('one total sequence budget is consumed across steps, not renewed for every instruction',async t=>{
 const {client,mock}=await setup(t,async r=>{if(r.cmd==='step')await new Promise(ok=>setTimeout(ok,35));});
 await assert.rejects(runInstructionSteps(client,{count:3,timeout_ms:30}),e=>{assert.match(e.message,/budget exhausted/);assert.equal(e.partial.steps.length,1);return true;});
 assert.equal(mock.requests.filter(r=>r.cmd==='step').length,1);
});
