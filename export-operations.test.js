const {test}=require('node:test'),assert=require('node:assert/strict');const {create}=require('./public/export-operations');
test('abort interrupts an unresolved operation and disposes resources without awaiting it',async()=>{const abort=new AbortController(),scope=create(abort.signal);let disposed=0;scope.own(()=>{disposed++;return new Promise(()=>{});});const waiting=scope.run('audio-decode',()=>new Promise(()=>{}));abort.abort();await assert.rejects(waiting,{name:'AbortError'});assert.equal(disposed,1);scope.close();assert.equal(disposed,1);});
test('late decoded samples are closed and cannot resume a cancelled export',async()=>{const abort=new AbortController(),scope=create(abort.signal);let finish,closed=0;const waiting=scope.run('video-decode',()=>new Promise(resolve=>finish=resolve),null,{late:sample=>sample.close()});await Promise.resolve();abort.abort();await assert.rejects(waiting);finish({close(){closed++;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);scope.close();});
test('timeout records bounded numeric diagnostics and releases resources',async()=>{const events=[],scope=create(new AbortController().signal,{timeoutMs:15,warn:view=>events.push(view)});let disposed=0;scope.own(()=>disposed++);await assert.rejects(scope.run('container-finalize',()=>new Promise(()=>{}),{timestamp:152,token:'secret',path:'private'}),{code:'export-timeout'});assert.equal(disposed,1);assert.ok(events.length);assert.doesNotMatch(JSON.stringify(events),/secret|private/);assert.equal(events[0].pending[0].timestamp,152);scope.close();});
test('cancel does not wait for a blocked iterator return',async()=>{const abort=new AbortController(),scope=create(abort.signal);const cursor=scope.iterate({[Symbol.asyncIterator](){return this;},next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{})},'video-packet-read');const waiting=cursor.next();abort.abort();await assert.rejects(waiting,{name:'AbortError'});scope.close();});

test('range requests retain both reader cancellation and whole export cancellation',async()=>{
 const {fetchSource}=require('./public/export-operations'),job=new AbortController(),requests=[];
 const send=fetchSource(job.signal,async(url,options)=>{requests.push(options);return {ok:true};});
 const first=new AbortController(),second=new AbortController();
 await send('/media',{signal:first.signal,headers:{Range:'bytes=0-'}});
 first.abort();assert.equal(requests[0].signal.aborted,true);assert.equal(job.signal.aborted,false);
 await send('/media',{signal:second.signal});assert.equal(requests[1].signal.aborted,false);
 job.abort();assert.equal(requests[1].signal.aborted,true);assert.equal(requests[0].headers.Range,'bytes=0-');
});

test('older browsers combine abort signals through the response body and remove relay listeners',async()=>{
 const {fetchSource}=require('./public/export-operations'),{getEventListeners}=require('node:events'),native=AbortSignal.any;
 AbortSignal.any=undefined;
 try{
  const job=new AbortController(),reader=new AbortController();let signal;
  const send=fetchSource(job.signal,async(url,options)=>{signal=options.signal;return {ok:true};});
  await send('/media',{signal:reader.signal});assert.equal(signal.aborted,false);assert.equal(getEventListeners(job.signal,'abort').length,1);
  reader.abort();assert.equal(signal.aborted,true);assert.equal(job.signal.aborted,false);assert.equal(getEventListeners(job.signal,'abort').length,0);
  await send('/media',{signal:new AbortController().signal});job.abort();assert.equal(signal.aborted,true);assert.equal(getEventListeners(job.signal,'abort').length,0);
  await send('/media',{signal:new AbortController().signal});assert.equal(signal.aborted,true);
 }finally{AbortSignal.any=native;}
});
