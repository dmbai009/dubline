const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), AdmZip = require('adm-zip');
const { io } = require('socket.io-client');
const { startServer, waitUntil } = require('../e2e/helpers');

describe('Scoped actor assignments and retake requests', () => {
  let server, serial = 0; const players = [];
  before(async () => { server = await startServer(); });
  after(async () => { players.forEach(player => player.socket.disconnect()); await server?.cleanup(); });
  const ack = (p, event, data = {}) => new Promise((resolve, reject) => p.socket.timeout(5000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  const state = async p => (await ack(p, 'editor_resync')).session;
  async function join(room, nick) {
    const clientId = crypto.randomUUID(), socket = io(`http://localhost:${server.port}`, { transports:['websocket'], autoConnect:false, auth:{clientId} });
    const p = { room,nick,clientId,socket }; players.push(p);
    await new Promise((resolve,reject) => { socket.once('connect_error',reject); socket.once('connect',()=>socket.emit('join_room',{room,nick,clientId})); socket.once('nick_state',result=>result.nick===nick?resolve():reject(Error('Nickname rejected'))); socket.connect(); });
    return p;
  }
  async function scene() {
    const p = await join(`dubbing-${++serial}`,'Host');
    const response = await fetch(`http://localhost:${server.port}/api/load-server-pack`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:p.room,clientId:p.clientId,filename:'test-scene.zip'})});
    assert.equal(response.status,200); return p;
  }
  function op(snapshot,payload) { return {...payload,sessionId:snapshot.activeSessionId,operationId:`actor-${++serial}`,operationEpoch:snapshot.editorProtocol.epoch,operationTime:snapshot.editorProtocol.serverTime}; }
  function assignment(snapshot,id,character) {
    const line=snapshot.lines.find(line=>line.id===id);
    return op(snapshot,{lineId:id,character,dubAssignment:true,revision:line.revision||0,audioUrl:line.audioUrl,takeCounter:line.takeCounter||0,
      expectedOwner:snapshot.characterClaims[line.character]||line.claimedBy||null,expectedTargetOwner:snapshot.characterClaims[character]||null});
  }
  async function claim(p,id=1) { const s=await state(p); assert.equal((await ack(p,'claim_line',{sessionId:s.activeSessionId,lineId:id,audioUrl:s.lines.find(line=>line.id===id).audioUrl})).ok,true); }
  async function upload(p,id=1) {
    await claim(p,id); const s=await state(p), reserve=await ack(p,'reserve_take',{lineId:id,sessionId:s.activeSessionId}); assert.equal(reserve.ok,true);
    const audio = new AdmZip(path.join(server.dirs.packs,'test-scene.zip')).readFile('001.wav');
    const form=new FormData(); for(const [key,value] of Object.entries({clientId:p.clientId,userName:p.nick,lineId:id,sessionId:s.activeSessionId,takeSequence:reserve.takeSequence,uploadId:`take-${++serial}`,audioStart:3})) form.append(key,value);
    form.append('audio',new Blob([audio],{type:'audio/wav'}),'take.wav');
    const response=await fetch(`http://localhost:${server.port}/api/upload-line-audio?room=${p.room}`,{method:'POST',body:form}); assert.equal(response.status,200,await response.clone().text()); return (await state(p)).lines.find(line=>line.id===id);
  }
  test('Dub assignments retain takes and reject foreign actors, claimed destinations, stale scene/revision and bulk editing',async()=>{
    const host=await scene(), actor=await join(host.room,'Actor'), stranger=await join(host.room,'Stranger'); await upload(actor);
    let s=await state(host), request=assignment(s,1,'Friend');
    assert.equal((await ack(stranger,'set_line_character',request)).reason,'owner');
    stranger.socket.emit('claim_character',{sessionId:s.activeSessionId,character:'Friend'}); await waitUntil(async()=>(await state(host)).characterClaims.Friend==='Stranger');
    s=await state(host); assert.equal((await ack(actor,'set_line_character',assignment(s,1,'Friend'))).reason,'owner');
    const before=s.lines[0], bytes=fs.readFileSync(path.join(server.dirs.uploads,path.basename(before.audioUrl)));
    const moved=await ack(host,'set_line_character',assignment(s,1,'Friend')); assert.equal(moved.ok,true);
    for(const key of ['id','caption','start','end','audioUrl','recordedBy','effect','pitch','volume','pan','audioStart']) assert.equal(moved.line[key],before[key],key);
    assert.deepEqual(fs.readFileSync(path.join(server.dirs.uploads,path.basename(before.audioUrl))),bytes);
    assert.equal((await ack(host,'set_line_character',{...assignment(s,1,'Hero'),revision:0})).reason,'conflict');
    assert.equal((await ack(host,'set_line_character',{...assignment(await state(host),1,'Hero'),sessionId:'old'})).reason,'session');
    s=await state(host); assert.equal((await ack(host,'set_lines_character',op(s,{lines:[{lineId:1,revision:moved.line.revision}],character:'Hero'}))).reason,'mode');
  });
  test('a reserved or actively recorded take blocks assignment, and an exact cancelled reservation releases it without changing audio',async()=>{
    const host=await scene(); await claim(host); let s=await state(host);
    const reservation=await ack(host,'reserve_take',{sessionId:s.activeSessionId,lineId:1});
    s=await state(host); assert.equal((await ack(host,'set_line_character',assignment(s,1,'Friend'))).reason,'pending');
    assert.equal((await ack(host,'reserve_take',{sessionId:s.activeSessionId,lineId:1,cancelSequence:reservation.takeSequence})).cancelled,true);
    s=await state(host); const request=assignment(s,1,'Friend'); assert.equal((await ack(host,'set_line_character',request)).ok,true);
    assert.equal((await ack(host,'set_line_character',request)).ok,true,'identical receipt is returned');
    assert.equal((await state(host)).lines[0].revision,1,'no duplicate move');
  });
  test('moderator rights are checked at mutation time and do not enable Dub bulk tools',async()=>{
    const host=await scene(), mod=await join(host.room,'Moderator'); await claim(host);
    assert.equal((await ack(host,'host_grant_moderator',{nick:mod.nick})).ok,true);
    const s=await state(host), id=s.moderators[0].id;
    assert.equal((await ack(mod,'set_line_character',assignment(s,1,'Friend'))).ok,true);
    assert.equal((await ack(host,'host_revoke_moderator',{id})).ok,true);
    assert.equal((await ack(mod,'set_line_character',assignment(await state(host),1,'Hero'))).reason,'owner');
  });
  test('comment revisions remain independent from mix, are addressed to the owner, idempotent and bound to the exact take',async()=>{
    const host=await scene(), actor=await join(host.room,'Actor'), other=await join(host.room,'Other'); const take=await upload(actor);
    let addressed=0, unrelated=0; actor.socket.on('retake_notice',()=>addressed++); other.socket.on('retake_notice',()=>unrelated++);
    const s=await state(host), request=op(s,{lineId:1,audioUrl:take.audioUrl,retakeRevision:take.retakeRevision||0,value:true,comment:'Больше эмоций <script>text only</script>'});
    assert.equal((await ack(host,'set_take_props',{sessionId:s.activeSessionId,lineId:1,audioUrl:take.audioUrl,takeMixRevision:take.takeMixRevision||0,volume:.7})).ok,true);
    const result=await ack(host,'set_needs_retake',request); assert.equal(result.ok,true); assert.equal(result.line.volume,.7);
    assert.equal((await ack(host,'set_needs_retake',request)).ok,true); await waitUntil(()=>addressed===1); assert.equal(unrelated,0);
    assert.equal((await ack(other,'set_needs_retake',{...request,operationId:`actor-${++serial}`})).reason,'owner');
    assert.equal((await ack(host,'set_needs_retake',op(await state(host),{...request,operationId:`actor-${++serial}`,comment:'changed'}))).reason,'conflict');
    const replacement=await upload(actor); assert.equal(replacement.needsRetake,false); assert.equal(replacement.retakeComment,'');
    assert.equal((await ack(host,'set_needs_retake',{...request,operationId:`actor-${++serial}`,retakeRevision:replacement.retakeRevision})).reason,'conflict');
    const next=await state(host); assert.equal((await ack(host,'set_needs_retake',op(next,{lineId:1,audioUrl:replacement.audioUrl,retakeRevision:replacement.retakeRevision,value:true,comment:'x'.repeat(1001)}))).reason,'invalid');
  });
  test('concurrent assignments and changed claims cannot apply an obsolete transfer, including while recording', async () => {
    const host=await scene(), mod=await join(host.room,'Moderator'); await claim(host);
    assert.equal((await ack(host,'host_grant_moderator',{nick:mod.nick})).ok,true);
    let s=await state(host);
    host.socket.emit('recording_status',{sessionId:s.activeSessionId,lineId:1,recording:true});
    assert.equal((await ack(host,'set_line_character',assignment(s,1,'Friend'))).reason,'pending');
    host.socket.emit('recording_status',{sessionId:s.activeSessionId,lineId:1,recording:false});
    s=await state(host); const requests=[assignment(s,1,'Friend'),assignment(s,1,'Friend')];
    const results=await Promise.all([ack(host,'set_line_character',requests[0]),ack(mod,'set_line_character',requests[1])]);
    assert.equal(results.filter(result=>result.ok).length,1); assert.equal(results.find(result=>!result.ok).reason,'conflict');
    s=await state(host); const stale=assignment(s,1,'Hero');
    mod.socket.emit('claim_character',{sessionId:s.activeSessionId,character:'Hero'});
    await waitUntil(async()=>(await state(host)).characterClaims.Hero==='Moderator');
    assert.equal((await ack(host,'set_line_character',stale)).reason,'conflict');
    assert.equal((await state(host)).lines[0].character,'Friend');
  });
  test('two moderators cannot overwrite a newer comment and clearing remarks leaves the saved audio unchanged', async () => {
    const host=await scene(), actor=await join(host.room,'Actor'), a=await join(host.room,'Mod A'), b=await join(host.room,'Mod B');
    for (const mod of [a,b]) assert.equal((await ack(host,'host_grant_moderator',{nick:mod.nick})).ok,true);
    const take=await upload(actor), bytes=fs.readFileSync(path.join(server.dirs.uploads,path.basename(take.audioUrl))), s=await state(host);
    const request=comment=>op(s,{lineId:1,audioUrl:take.audioUrl,retakeRevision:take.retakeRevision||0,value:true,comment});
    const results=await Promise.all([ack(a,'set_needs_retake',request('First')),ack(b,'set_needs_retake',request('Second'))]);
    assert.equal(results.filter(result=>result.ok).length,1); assert.equal(results.find(result=>!result.ok).reason,'conflict');
    let current=await state(host), line=current.lines[0];
    assert.equal((await ack(a,'set_needs_retake',op(current,{lineId:1,audioUrl:line.audioUrl,retakeRevision:line.retakeRevision,value:true,comment:''}))).ok,true);
    current=await state(host); line=current.lines[0]; assert.equal(line.needsRetake,true); assert.equal(line.retakeComment,'');
    assert.equal((await ack(actor,'set_needs_retake',op(current,{lineId:1,audioUrl:line.audioUrl,retakeRevision:line.retakeRevision,value:false,comment:''}))).reason,'owner');
    assert.equal((await ack(b,'set_needs_retake',op(current,{lineId:1,audioUrl:line.audioUrl,retakeRevision:line.retakeRevision,value:false,comment:''}))).ok,true);
    line=(await state(host)).lines[0]; assert.equal(line.needsRetake,false);
    assert.deepEqual(fs.readFileSync(path.join(server.dirs.uploads,path.basename(line.audioUrl))),bytes);
    const receipt=await ack(actor,'editor_operation_status',{event:'set_needs_retake',request:request('unseen')}); assert.equal(receipt.state,'unseen');
  });
});
