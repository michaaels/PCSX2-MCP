import assert from 'node:assert/strict';
import test from 'node:test';
import { DebugServerClient } from '../dist/debug-server-client.js';
import { parseStateLoadReceipt, performStateLoad, readStateLoadStatus } from '../dist/state-tools.js';
import { debugServer } from './fixtures.mjs';

const identity={process_id:42,session:1,execution_epoch:2,iop_reset_epoch:3,iop_lifetime_epoch:4,elf:'game.elf',elf_crc:'0x12345678'};
const reply=(id,slot,loaded=true)=>({ok:true,operation_id:id,slot,completed:true,loaded,paused:true,before:{...identity},
 after:{...identity,execution_epoch:3,iop_lifetime_epoch:5},error:loaded?'':'Corrupt test state'});
async function setup(t,override=()=>undefined){
 const state={caps:{...identity,ok:true,protocol_version:2,features:['guarded_state_load']},paused:true};
 const mock=await debugServer(t,async r=>{
   const result=await override(r,state);if(result!==undefined)return result;
   if(r.cmd==='capabilities')return state.caps;
   if(r.cmd==='status')return{ok:true,data:{alive:true,paused:state.paused,pc:'0x00100000',cycles:5}};
   if(r.cmd==='state_load')return reply(r.operation_id,r.slot);
   throw new Error('Unexpected '+r.cmd);
 });
 const client=new DebugServerClient('127.0.0.1',mock.port);await client.connect();t.after(()=>client.disconnect());return{client,mock,state};
}
test('guarded load reports actual native success and sends full starting identity exactly once',async t=>{
 const {client,mock}=await setup(t);const result=await performStateLoad(client,null,4);
 assert.equal(result.outcome,'loaded');assert.equal(result.loaded,true);assert.equal(result.completion_confirmed,true);
 const requests=mock.requests.filter(r=>r.cmd==='state_load');assert.equal(requests.length,1);
 assert.equal(requests[0].expected_iop_lifetime_epoch,4);assert.equal(requests[0].expected_process_id,42);assert.equal(requests[0].slot,4);
 assert.ok(mock.requests.every(r=>['capabilities','status','state_load'].includes(r.cmd)));
});
test('native load failure remains failed even with ok=true transport acknowledgement',async t=>{
 const {client}=await setup(t,r=>r.cmd==='state_load'?reply(r.operation_id,r.slot,false):undefined);
 const result=await performStateLoad(client,null,1);assert.equal(result.outcome,'failed');assert.equal(result.loaded,false);
 assert.equal(result.completion_confirmed,true);assert.match(result.receipt.error,/Corrupt/);
});
test('PINE fallback and old DebugServer report queued/unconfirmed rather than loaded',async t=>{
 let calls=0;const pine={isConnected:()=>true,loadState:async()=>{calls++;}};
 for(const mode of ['pine','old']){
   const {client,state}=await setup(t);state.caps.features=[];
   const result=await performStateLoad(mode==='old'?client:null,pine,2);
   assert.equal(result.outcome,'queued_unconfirmed');assert.equal(result.loaded,null);assert.equal(result.completion_confirmed,false);
 }
 assert.equal(calls,2);
});
test('pre-cancellation, running VM and invalid slots never dispatch a native or PINE load',async t=>{
 const {client,mock,state}=await setup(t);let loads=0;const pine={isConnected:()=>true,loadState:async()=>{loads++;}};
 const abort=new AbortController();abort.abort();assert.equal((await performStateLoad(client,pine,1,abort.signal)).outcome,'cancelled_before_dispatch');
 state.paused=false;assert.equal((await performStateLoad(client,pine,1)).outcome,'not_dispatched');
 for(const slot of [-1,10,1.5])await assert.rejects(performStateLoad(client,pine,slot));
 assert.equal(loads,0);assert.equal(mock.requests.filter(r=>r.cmd==='state_load').length,0);
});
test('cancellation after dispatch preserves the observed completed native mutation',async t=>{
 const abort=new AbortController();const {client}=await setup(t,r=>{if(r.cmd==='state_load'){abort.abort();return reply(r.operation_id,r.slot);}});
 const result=await performStateLoad(client,null,1,abort.signal);assert.equal(result.outcome,'loaded');assert.equal(result.cancellation_requested,true);
});
test('native precondition refusal differs from lost transport with unknown outcome and neither is retried',async t=>{
 for(const refused of [true,false]){
   const {client,mock}=await setup(t,r=>r.cmd==='state_load'?(refused?{ok:false,refused:true,error:'VM identity changed'}:null):undefined);
   const result=await performStateLoad(client,null,1);assert.equal(result.outcome,refused?'refused':'unknown');
   assert.equal(result.loaded,refused?false:null);assert.equal(mock.requests.filter(r=>r.cmd==='state_load').length,1);
 }
});
test('wrong operation/slot/before identity or inconsistent completion is never accepted as loaded',async t=>{
 for(const change of [r=>({...r,operation_id:'f'.repeat(32)}),r=>({...r,slot:9}),r=>({...r,before:{...r.before,session:8}}),
   r=>({...r,after:r.before}),r=>({...r,error:'unexpected'})]){
   const {client}=await setup(t,r=>r.cmd==='state_load'?change(reply(r.operation_id,r.slot)):undefined);
   const result=await performStateLoad(client,null,1);assert.equal(result.outcome,'unknown');assert.equal(result.loaded,null);
 }
 assert.throws(()=>parseStateLoadReceipt({...reply('a'.repeat(32),1),completed:false},'a'.repeat(32)));
});
test('receipt status is read-only, historical after epoch change, and unavailable never implies no load',async t=>{
 const id='a'.repeat(32);let reads=0;
 const {client,mock,state}=await setup(t,r=>{if(r.cmd==='state_load_status'){reads++;return reads===1?reply(id,1):{ok:false,error:'State-load receipt unavailable; outcome not inferred'};}});
 state.caps.execution_epoch=7;state.caps.iop_lifetime_epoch=8;
 const report=await readStateLoadStatus(client,id);assert.equal(report.historical,true);assert.equal(report.loaded,true);
 await assert.rejects(readStateLoadStatus(client,id),/unavailable/);assert.ok(!mock.requests.some(r=>r.cmd==='state_load'));
});
