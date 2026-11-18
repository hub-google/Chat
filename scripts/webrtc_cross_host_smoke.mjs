import { createClient } from '@supabase/supabase-js';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const endpoint=process.env.NEXT_PUBLIC_SUPABASE_URL;
const key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const runId=process.env.GITHUB_RUN_ID;
if(!endpoint||!key||!runId)throw Error('Missing Supabase public settings or GitHub run ID');
const supabase=createClient(endpoint,key,{auth:{persistSession:false,autoRefreshToken:true}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,limit,label,interval=700){
  const end=Date.now()+limit;let last;
  while(Date.now()<end){
    try{const v=await fn();if(v!==undefined&&v!==null&&v!==false)return v}catch(e){last=e}
    await sleep(interval);
  }
  throw Error(label+' timed out'+(last?': '+last.message:''));
}
function ok(result,label){if(result.error)throw Error(label+': '+result.error.message);return result.data}
const names=process.platform==='darwin'
? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium']
: ['google-chrome','chromium','chromium-browser'];
const browser=names.find(n=>n.startsWith('/')?existsSync(n):spawnSync('which',[n],{stdio:'ignore'}).status===0);
if(!browser)throw Error('No Chrome found on '+process.platform);
const folder=mkdtempSync(join(tmpdir(),'tunnel-remote-p2p-'));
let server,chrome,socket,stderr='',me,roomId,evaluateBrowser;
async function launch(){
  server=createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end('<!doctype html><title>Cross-host WebRTC smoke</title>')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const flags=['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+folder];
  if(process.platform==='linux')flags.push('--no-sandbox','--disable-dev-shm-usage','--disable-gpu');
  flags.push('http://127.0.0.1:'+server.address().port);
  chrome=spawn(browser,flags,{stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',v=>{stderr=(stderr+v.toString()).slice(-2000)});
  const portfile=join(folder,'DevToolsActivePort');
  await until(()=>{
    if(chrome.exitCode!==null)throw Error('Chrome exited '+chrome.exitCode+' '+stderr);
    return existsSync(portfile);
  },30000,'Chrome startup');
  const port=Number(readFileSync(portfile,'utf8').split('\n')[0]);
  const tab=await until(async()=>{
    const all=await (await fetch('http://127.0.0.1:'+port+'/json')).json();
    return all.find(v=>v.type==='page'&&v.url.startsWith('http://127.0.0.1:'));
  },15000,'Chrome page discovery');
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})}),
    new Promise((_,reject)=>setTimeout(()=>reject(Error('CDP connection timeout')),12000))
  ]);
  const pending=new Map();let counter=0;
  socket.addEventListener('message',event=>{
    const msg=JSON.parse(event.data),callback=pending.get(msg.id);
    if(callback){pending.delete(msg.id);msg.error?callback.reject(Error(JSON.stringify(msg.error))):callback.resolve(msg.result)}
  });
  return async expr=>{
    const result=await Promise.race([
      new Promise((resolve,reject)=>{
        const id=++counter;pending.set(id,{resolve,reject});
        socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:expr,awaitPromise:true,returnByValue:true}}));
      }),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('Browser script timeout')),26000))
    ]);
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result?.value;
  };
}
const setup=[
"(() => {",
"  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});",
"  window.smoke={pc,channel:null,received:[]};",
"  function install(ch){",
"    smoke.channel=ch;",
"    ch.onmessage=e=>{smoke.received.push(e.data);if(e.data.startsWith('ping:'))ch.send('pong:'+e.data.slice(5));};",
"  }",
"  pc.ondatachannel=e=>install(e.channel);",
"  smoke.makeOfferer=()=>install(pc.createDataChannel('chat',{ordered:true}));",
"  smoke.local=async kind=>{",
"    await pc.setLocalDescription(kind==='offer'?await pc.createOffer():await pc.createAnswer());",
"    if(pc.iceGatheringState!=='complete')await Promise.race([",
"      new Promise(resolve=>{const check=()=>{if(pc.iceGatheringState==='complete'){pc.removeEventListener('icegatheringstatechange',check);resolve()}};pc.addEventListener('icegatheringstatechange',check);check()}),",
"      new Promise(resolve=>setTimeout(resolve,11000))",
"    ]);",
"    return pc.localDescription.toJSON();",
"  };",
"  smoke.stats=async()=>{const x=[...(await pc.getStats()).values()];",
"    const t=x.find(s=>s.type==='transport'&&s.selectedCandidatePairId);",
"    const pair=x.find(s=>s.id===t?.selectedCandidatePairId)||x.find(s=>s.type==='candidate-pair'&&s.nominated&&s.state==='succeeded');",
"    return {state:pc.connectionState,local:x.find(s=>s.id===pair?.localCandidateId)?.candidateType||'unknown',",
"      remote:x.find(s=>s.id===pair?.remoteCandidateId)?.candidateType||'unknown',",
"      rttMs:Number.isFinite(pair?.currentRoundTripTime)?Math.round(pair.currentRoundTripTime*1000):null};",
"  };",
"  return true;",
"})()"
].join('\n');
try {
  const auth=ok(await supabase.auth.signInAnonymously({options:{data:{tunnel_crossnetwork_test:runId,runner:process.env.RUNNER_OS||process.platform}}}),'Anonymous test auth');
  me=auth.user.id;
  console.log('TEST_AUTH_ID='+me+' TEST_RUN='+runId+' OS='+process.platform);
  ok(await supabase.from('profiles').insert({id:me}),'Create test profile');
  const args={p_user_id:me,p_intent:'chill',p_lat:-74.123451,p_lng:31.234567,p_max_distance_km:1,p_distance_mode:'nearest'};
  const result=await until(async()=>{
    const data=ok(await supabase.rpc('fn_match_user',args),'Pair two remote runners');
    return data?.[0]?.match_id||null;
  },125000,'Matching peer',3500);
  roomId=result;
  const match=ok(await supabase.from('matches').select('participants').eq('id',roomId).single(),'Read pair');
  const initiator=match.participants[0]===me;
  console.log('MATCH_ID='+roomId+' ROLE='+(initiator?'offer':'answer'));
  const evaluate=await launch();
  evaluateBrowser=evaluate;
  await evaluate(setup);
  if(initiator)await evaluate('smoke.makeOfferer()');
  const json=value=>JSON.stringify(value);
  async function write(kind,sdp,nonce){
    ok(await supabase.from('tunnel_webrtc_signals').upsert({
      match_id:roomId,sender_id:me,kind,sdp,negotiation_id:nonce,created_at:new Date().toISOString()
    },{onConflict:'match_id,sender_id'}),'Send '+kind);
  }
  async function poll(kind,nonce){
    let query=supabase.from('tunnel_webrtc_signals').select('sdp,negotiation_id')
      .eq('match_id',roomId).neq('sender_id',me).eq('kind',kind);
    if(nonce)query=query.eq('negotiation_id',nonce);
    const data=ok(await query.maybeSingle(),'Receive '+kind);
    return data?.sdp&&data.negotiation_id?data:null;
  }
  if(initiator){
    const sdp=await evaluate("smoke.local('offer')");
    const nonce=crypto.randomUUID();
    await write('offer',sdp,nonce);
    const answer=await until(()=>poll('answer',nonce),85000,'Remote answer');
    await evaluate('smoke.pc.setRemoteDescription('+json(answer.sdp)+')');
  }else{
    const offer=await until(()=>poll('offer'),85000,'Remote offer');
    await evaluate('smoke.pc.setRemoteDescription('+json(offer.sdp)+')');
    await write('answer',await evaluate("smoke.local('answer')"),offer.negotiation_id);
  }
  await until(()=>evaluate("smoke.channel?.readyState==='open'"),40000,'Cross-host P2P connection',500);
  const marker='remote-'+runId;
  const begin=Date.now();
  if(initiator)await evaluate('smoke.channel.send('+json('ping:'+marker)+')');
  const expected=(initiator?'pong:':'ping:')+marker;
  await until(()=>evaluate('smoke.received.includes('+json(expected)+')'),18000,'Cross-host P2P message',350);
  const stats=await evaluate('smoke.stats()');
  console.log('CROSS_HOST_PASS '+JSON.stringify({runner:process.env.RUNNER_OS||process.platform,
    initiator,elapsedMs:initiator?Date.now()-begin:null,stats}));
}catch(error){
  console.error('CROSS_HOST_FAIL: '+(error.stack||error));
  if(evaluateBrowser){
    try{
      const report=await evaluateBrowser([
        "(() => {",
        "  const count=(s,pattern)=>(s.match(new RegExp(pattern,'g'))||[]).length;",
        "  const summary=sdp=>({host:count(sdp,'typ host'),srflx:count(sdp,'typ srflx'),relay:count(sdp,'typ relay')});",
        "  return {connection:smoke.pc.connectionState,ice:smoke.pc.iceConnectionState,",
        "    iceGathering:smoke.pc.iceGatheringState,",
        "    local:summary(smoke.pc.localDescription?.sdp||''),",
        "    remote:summary(smoke.pc.remoteDescription?.sdp||'')};",
        "})()"
      ].join('\n'));
      console.log('ICE_DIAGNOSTIC '+JSON.stringify(report));
    }catch(failure){console.error('ICE diagnostics unavailable:',failure.message)}
  }
  if(me&&roomId){
    try{
      // Verify production HTTP fallback using actual remote participants.
      const prefix='TUNNEL-CROSSHOST-HTTP-'+runId+'-';
      const content=prefix+process.platform;
      ok(await supabase.from('messages').insert({
        id:crypto.randomUUID(),match_id:roomId,sender_id:me,content,type:'text'
      }),'Write HTTP fallback');
      const records=await until(async()=>{
        const result=ok(await supabase.from('messages').select('sender_id,content')
          .eq('match_id',roomId).like('content',prefix+'%'),'Read HTTP fallback');
        return new Set((result||[]).map(msg=>msg.sender_id)).size>=2?result:null;
      },30000,'Remote HTTP fallback',750);
      console.log('HTTP_FALLBACK_PASS '+JSON.stringify({remoteSenders:new Set(records.map(msg=>msg.sender_id)).size}));
    }catch(failure){
      console.error('HTTP_FALLBACK_FAIL: '+(failure.stack||failure));
    }
  }
  if(stderr)console.error('Chrome diagnostic tail: '+stderr.slice(-450));
  process.exitCode=1;
}finally{
  if(me){
    try{if(roomId)await supabase.from('tunnel_webrtc_signals').delete().eq('match_id',roomId).eq('sender_id',me)}catch{}
    try{await supabase.rpc('tunnel_cancel_matching')}catch{}
  }
  try{socket?.close()}catch{}
  try{chrome?.kill('SIGTERM')}catch{}
  if(chrome)await Promise.race([
    new Promise(resolve=>chrome.once('exit',resolve)),
    sleep(1800)
  ]);
  if(server)await new Promise(resolve=>server.close(resolve));
  try{rmSync(folder,{recursive:true,force:true,maxRetries:3,retryDelay:200})}
  catch(failure){console.warn('Temporary Chrome profile cleanup warning:',failure.message)}
  console.log('TEST_AUTH_CLEANUP_ID='+me+' TEST_RUN='+runId);
}
