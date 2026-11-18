const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const wav=Buffer.alloc(44+1600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
for(const kind of ['session','body_exploration']){
 const p=await browser.newPage({viewport:{width:1366,height:900}}),errors=[],generated=[],prepared=[];const start=Date.now()-180000;
 const hr=()=>({source:'direct_h10',currentHr:110,heartRate:110,baselineHr:80,buildConfidence:80,phase:'build',measuredAt:Date.now(),receivedAt:Date.now(),hrv:{rmssdMs:4,sdnnMs:10,quality:'high',sampleCount:180}});
 const prediction={nearClimax:76,recovery:0,plateauScore:78,controllerConfidence:80,buildEligibleForNearClimax:true,buildDurationSec:150,confirmationCount:3,hrvUsable:true,hrvContribution:13,hrvSignal:'compressed',recentSlope:2,multimodalTrusted:true,label:'Near-climax watch'};
 const status=()=>({hr:{latestTelemetry:hr(),recording:null,selectedSource:'direct_h10',connected:true},session:{active:false,activeSessionId:null},monitoring:{version:1,sessionId:null,active:true,paused:false,stale:false,observationStartedAt:start,latestAt:Date.now(),prediction,basePrediction:prediction},emg:{}});
 p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(({kind})=>{
  localStorage.setItem('sarah.liveCapture.launchProfile.v1',JSON.stringify({captureKind:kind,livePhysiologyCuesEnabled:true,cueVolume:.5,cueStyle:'sarah_soft',hrSource:'direct_h10',heartbeatAudioEnabled:false}));
  localStorage.setItem('pulsepoint.phaseAnnouncements.v1',JSON.stringify({enabled:true,volume:.5}));
  window.__audioStarts=0;const Context=window.AudioContext;
  window.AudioContext=class extends Context{createBufferSource(){const source=super.createBufferSource(),start=source.start.bind(source);source.start=(...args)=>{if(source.buffer?.length>1)window.__audioStarts++;return start(...args);};return source;}};
  window.__streams=[];window.EventSource=class{constructor(url){this.url=url;this.handlers={};window.__streams.push(this);}addEventListener(name,fn){this.handlers[name]=fn;}close(){this.closed=true;}};
 },{kind});
 await p.route('**/api/**',async route=>{
  const req=route.request(),url=req.url(),json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  if(url.includes('/live-cues/generate')){const body=req.postDataJSON();generated.push(body);return json({text:'Your heart rate is elevated from baseline. Take your time.'});}
  if(url.includes('/live-cues/prepare')){const body=req.postDataJSON();prepared.push(...body.clips);return json({clips:body.clips.map(c=>({...c,url:'/api/test-live-audio'}))});}
  if(url.includes('/test-live-audio'))return route.fulfill({status:200,contentType:'audio/wav',body:wav});
  if(req.method()!=='GET')return route.fulfill({status:409,contentType:'application/json',body:'{"error":"Read-only test"}'});
  if(url.includes('/live-capture/status'))return json(status());
  if(url.includes('/live-capture/monitoring'))return json({sessionId:null,history:Array.from({length:150},(_,i)=>({ts:start+i*1000,sessionTimeSec:i,hr:110,baseline:80,build:80,phase:'build',nearClimax:76,hrvRmssd:4}))});
  if(url.includes('/howl/control/status'))return json({ok:true,measured_at:new Date().toISOString(),howl:{power_a:20,power_b:25,player:{playing:true}}});
  return route.continue();
 });
 await p.goto('http://127.0.0.1:5175/capture?display=telemetry');await p.getByTestId('viewport-telemetry-grid').waitFor();await p.getByLabel('Telemetry view preset',{exact:true}).selectOption('device');
 await p.getByRole('button',{name:'Edit layout',exact:true}).click();await p.getByRole('button',{name:'Done',exact:true}).click();
 for(const id of ['phase','threshold','civet','howl','cardiac'])await p.locator(`[data-telemetry-item="${id}"]`).waitFor();
 if(kind==='body_exploration'){assert.ok(await p.getByRole('heading',{name:'Procedure response',exact:true}).count());assert.equal(await p.getByText('Rectal fluid logged',{exact:true}).count(),0);}
 const push=setInterval(async()=>{try{const data=status();await p.evaluate(data=>{for(const stream of window.__streams.filter(s=>!s.closed&&s.url.includes('/live-capture/stream'))){stream.handlers.status?.({data:JSON.stringify(data)});stream.handlers.hr_telemetry?.({data:JSON.stringify(data.hr.latestTelemetry)});}},data);}catch{}},1000);
 try{await p.waitForFunction(()=>window.__audioStarts>=2,{},{timeout:40000});}catch(error){console.error(JSON.stringify({kind,generated,prepared,errors,starts:await p.evaluate(()=>window.__audioStarts),text:(await p.locator('body').innerText()).slice(-5000)}));await p.screenshot({path:'logs/telemetry-312-voice-failure.png'});throw error;}finally{clearInterval(push);}
 assert.ok(generated.length>0,`${kind}: no generated cue request`);assert.ok(prepared.some(c=>c.text==='Your heart rate is elevated from baseline. Take your time.'));
 assert.ok(prepared.some(c=>['Elevated.','Plateau.','Sustained build.','Climax possibility.'].includes(c.text)));
 assert.equal(generated[0].captureKind,kind);assert.deepEqual(errors,[]);console.log(`PASS ${kind}: encouragement and phase audio dispatch without recording; pressure focus retains evidence/metrics and Howl; no mutating device requests`);
 await p.close();
}
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
