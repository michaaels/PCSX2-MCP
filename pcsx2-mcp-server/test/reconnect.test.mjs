import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DebugServerClient } from '../dist/debug-server-client.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return{promise,resolve,reject};};
const settle=p=>p.then(value=>({value}),error=>({error}));
const status=id=>({ok:true,data:{alive:true,paused:true,pc:'0x'+id.toString(16).padStart(8,'0'),cycles:id}});
async function wire(t,handler){
 const peers=[],requests=[];
 const server=createServer(socket=>{
   const peer={socket,id:peers.length+1,closed:deferred()};peers.push(peer);let buffer='';
   socket.on('error',()=>{});socket.on('close',()=>peer.closed.resolve());
   socket.on('data',data=>{buffer+=data;let end;
     while((end=buffer.indexOf('\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
       requests.push({id:peer.id,request});Promise.resolve(handler({...peer,request,send:value=>socket.write(JSON.stringify(value)+'\n')})).catch(e=>socket.destroy(e));}
   });
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 const client=new DebugServerClient('127.0.0.1',server.address().port);
 t.after(async()=>{client.disconnect();for(const p of peers)p.socket.destroy();await new Promise(ok=>server.close(ok));});
 await client.connect();return{client,peers,requests};
}

test('reconnect rejects pending and queued old commands instead of replaying them on the new socket',{timeout:2000},async t=>{
 const first=deferred();const {client,peers,requests}=await wire(t,r=>{if(r.id===1){first.resolve();return;}r.send(status(r.id));});
 const old=settle(client.getStatus());await first.promise;const queued=settle(client.resume());
 await client.connect();peers[0].socket.end(JSON.stringify(status(1))+'\n');
 assert.ok((await old).error);assert.ok((await queued).error);
 assert.equal((await client.getStatus()).cycles,2);
 assert.ok(!requests.some(r=>r.id===2&&r.request.cmd==='resume'));
});
test('partial old JSON is discarded before a new connection receives its first reply',{timeout:2000},async t=>{
 const sent=deferred();const {client,peers}=await wire(t,r=>{if(r.id===1){r.socket.write('{"ok":true,"data":');sent.resolve();return;}r.send(status(2));});
 const pending=settle(client.getStatus());await sent.promise;await delay(5);await client.connect();peers[0].socket.destroy();
 assert.ok((await pending).error);assert.equal((await client.getStatus()).cycles,2);
});
test('close from a superseded socket cannot reject a new pending response',{timeout:2000},async t=>{
 let old;
 const {client,peers}=await wire(t,async r=>{old.destroy();await delay(10);r.send(status(r.id));});
 old=peers[0].socket;await client.connect();assert.equal((await client.getStatus()).cycles,2);assert.equal(client.isConnected(),true);
});
test('rapid replacement retires every preceding peer and preserves the active connection',{timeout:3000},async t=>{
 const {client,peers}=await wire(t,r=>r.send(status(r.id)));
 for(let i=1;i<=12;i++){await client.connect();assert.equal((await client.getStatus()).cycles,i+1);}
 await Promise.all(peers.slice(0,-1).map(p=>p.closed.promise));assert.equal(client.isConnected(),true);
});
test('disconnect rejects an in-flight command immediately without waiting for its transport timeout',{timeout:2000},async t=>{
 const arrived=deferred();const {client}=await wire(t,()=>arrived.resolve());
 const pending=settle(client.getStatus());await arrived.promise;client.disconnect();assert.ok((await pending).error);assert.equal(client.isConnected(),false);
 await client.connect();client.disconnect();
});
test('an old exclusive continuation cannot send mutations or release a newer exclusive owner',{timeout:2000},async t=>{
 const entered=deferred(),releaseOld=deferred(),newEntered=deferred(),releaseNew=deferred();
 const {client,requests}=await wire(t,r=>r.send(r.request.cmd==='status'?status(r.id):{ok:true}));
 const stale=settle(client.withExclusiveSession(async()=>{entered.resolve();await releaseOld.promise;await client.resume();}));
 await entered.promise;await client.connect();
 const current=client.withExclusiveSession(async()=>{newEntered.resolve();await releaseNew.promise;return client.getStatus();});
 await newEntered.promise;releaseOld.resolve();assert.ok((await stale).error);
 await assert.rejects(client.resume(),/owns|active/);releaseNew.resolve();assert.equal((await current).cycles,2);
 assert.ok(!requests.some(r=>r.request.cmd==='resume'));
});
test('an exclusive callback waiting behind a retired queue never starts on a replacement socket',{timeout:2000},async t=>{
 const arrived=deferred();const {client,peers}=await wire(t,r=>{if(r.id===1){arrived.resolve();return;}r.send(status(r.id));});
 const pending=settle(client.getStatus());await arrived.promise;let started=false;
 const exclusive=settle(client.withExclusiveSession(async()=>{started=true;await client.resume();}));
 await client.connect();peers[0].socket.destroy();assert.ok((await pending).error);assert.ok((await exclusive).error);
 assert.equal(started,false);assert.equal((await client.getStatus()).cycles,2);
});
test('an event wait is bound to one connection generation and cannot continue polling a replacement',{timeout:2000},async t=>{
 const arrived=deferred();const {client,peers,requests}=await wire(t,r=>{if(r.id===1){arrived.resolve();r.send({ok:true,session:1,oldest_sequence:1,dropped:false,next_cursor:1,events:[]});}
   else r.send(status(r.id));});
 const waiting=settle(client.waitEvent({type:'paused',timeoutMs:500}));await arrived.promise;await client.connect();peers[0].socket.destroy();
 assert.ok((await waiting).error);assert.equal((await client.getStatus()).cycles,2);
 assert.ok(!requests.some(r=>r.id===2&&r.request.cmd==='read_events'));
});
test('malformed JSON closes its generation, omits payload from the error and permits a clean reconnect',{timeout:2000},async t=>{
 const {client}=await wire(t,r=>{if(r.id===1)r.socket.write('PRIVATE_INVALID_PAYLOAD\n');else r.send(status(r.id));});
 await assert.rejects(client.getStatus(),e=>{assert.match(e.message,/Invalid JSON/);assert.ok(!e.message.includes('PRIVATE_INVALID_PAYLOAD'));return true;});
 assert.equal(client.isConnected(),false);await client.connect();assert.equal((await client.getStatus()).cycles,2);
});
test('unsolicited trailing response cannot be consumed as the next command reply',{timeout:2000},async t=>{
 const {client}=await wire(t,r=>r.socket.write(JSON.stringify(status(r.id))+'\n'+JSON.stringify({ok:true})+'\n'));
 await client.getStatus().catch(()=>{});await delay(5);assert.equal(client.isConnected(),false);
 await assert.rejects(client.resume(),/connected|connection/i);
});
test('stale scoped cleanup cannot disconnect or replace the current connection',{timeout:2000},async t=>{
 const entered=deferred(),release=deferred();const {client,peers}=await wire(t,r=>r.send(status(r.id)));
 const stale=settle(client.withExclusiveSession(async()=>{entered.resolve();await release.promise;
   assert.throws(()=>client.disconnect(),/connection changed/);await assert.rejects(client.connect(),/connection changed/);
 }));
 await entered.promise;await client.connect();release.resolve();assert.ok((await stale).error);
 assert.equal((await client.getStatus()).cycles,2);assert.equal(peers.length,2);
});
test('superseded connection attempts settle their promise and do not poison the successful attempt',{timeout:2000},async t=>{
 const {client}=await wire(t,r=>r.send(status(r.id)));
 const first=settle(client.connect()),second=client.connect();
 assert.ok((await first).error);await second;assert.equal(client.isConnected(),true);assert.ok((await client.getStatus()).cycles>=2);
});
test('an old exclusive result is refused even when its callback returns without another native request',{timeout:2000},async t=>{
 const entered=deferred(),release=deferred();const {client}=await wire(t,r=>r.send(status(r.id)));
 const old=settle(client.withExclusiveSession(async()=>{const snapshot=await client.getStatus();entered.resolve();await release.promise;return snapshot;}));
 await entered.promise;await client.connect();release.resolve();assert.match((await old).error.message,/connection changed/);
 assert.equal((await client.getStatus()).cycles,2);
});
test('late frame cleanup neither cancels a new native operation nor releases its ownership',{timeout:3000},async t=>{
 const oldPending=deferred(),newPending=deferred(),releaseOldError=deferred(),releaseNew=deferred();
 const operation=(id,active)=>({ok:true,session:1,operation_id:id,active,start_frame:0,target_frame:3,current_frame:active?0:3,
   frames_advanced:active?0:3,reason:active?'':'completed',paused:!active});
 const {client,requests}=await wire(t,async r=>{
   if(r.request.cmd==='frame_advance')r.send(operation(r.id,true));
   else if(r.request.cmd==='automation_status'){
     if(r.id===1){oldPending.resolve();return;}newPending.resolve();await releaseNew.promise;r.send(operation(r.id,false));
   }else throw new Error('Unexpected '+r.request.cmd);
 });
 const original=client.getAutomation.bind(client);client.getAutomation=async(...args)=>{
   try{return await original(...args);}catch(error){await releaseOldError.promise;throw error;}
 };
 const old=settle(client.advanceFrames(3));await oldPending.promise;await client.connect();
 const current=client.advanceFrames(3);await newPending.promise;releaseOldError.resolve();assert.ok((await old).error);
 await assert.rejects(client.advanceFrames(3),/already pending/);
 releaseNew.resolve();assert.equal((await current).completed,true);
 assert.ok(!requests.some(r=>r.id===2&&r.request.cmd==='automation_cancel'));
});
test('oversized responses retire only their own connection and permit clean subsequent replies',{timeout:3000},async t=>{
 const {client}=await wire(t,r=>{if(r.id===1)r.socket.write(' '.repeat(9*1024*1024+1));else r.send(status(r.id));});
 await assert.rejects(client.getStatus(),/9 MiB/);assert.equal(client.isConnected(),false);
 await client.connect();assert.equal((await client.getStatus()).cycles,2);
});
test('a real transport deadline retires its socket before reconnect and cannot consume a late old response',{timeout:15000},async t=>{
 const {client,peers}=await wire(t,r=>{if(r.id!==1)r.send(status(r.id));});
 await assert.rejects(client.getStatus(),/Command timeout: status/);assert.equal(client.isConnected(),false);
 await client.connect();peers[0].socket.write(JSON.stringify(status(999))+'\n');
 assert.equal((await client.getStatus()).cycles,2);assert.equal(client.isConnected(),true);
});
