const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const pages=[],errors=[],posts=[];let session={active:false,activeSessionId:null,captureKind:'session'},doc=null;
 const status=()=>({session,hr:{recording:null,connected:false,relay:{obs:{identified:true}}},emg:{}});
 const publish=async()=>Promise.all(pages.map(p=>p.evaluate(s=>window.__streams.filter(e=>!e.closed).forEach(e=>e.handlers.live_session?.({data:JSON.stringify(s)})),session)));
 for(let i=0;i<2;i++){
  const context=await browser.newContext(),p=await context.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{window.__streams=[];window.EventSource=class{constructor(){this.handlers={};window.__streams.push(this);}addEventListener(n,f){this.handlers[n]=f;}close(){this.closed=true;}};});
  await p.route('**/api/**',async route=>{const req=route.request(),url=req.url(),json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
   if(url.includes('/entities/')&&url.endsWith('/filter'))return json(doc?[doc]:[]);
   if(req.method()!=='GET'){
    posts.push(url);
    if(url.endsWith('/live-capture/capture-kind')){session={...session,captureKind:req.postDataJSON().captureKind};await publish();return json({session});}
    return route.fulfill({status:409,contentType:'application/json',body:'{"error":"Read-only test"}'});
   }
   if(url.includes('/live-capture/status'))return json(status());
   if(url.includes('/entities/BodyExploration')||url.includes('/entities/Session'))return json(doc?[doc]:[]);
   return route.continue();
  });
  await p.goto('http://127.0.0.1:5175/capture');await p.getByRole('region',{name:'Session recording',exact:true}).waitFor();
 }
 assert.equal(posts.filter(u=>u.includes('/capture-kind')).length,0);
 const consoleFor=p=>p.getByRole('region',{name:'Session recording',exact:true});
 await consoleFor(pages[0]).getByRole('button',{name:/Body exploration/}).click();
 await pages[1].waitForFunction(()=>document.querySelector('[aria-label="Session recording"] button[aria-pressed="true"]')?.textContent.includes('Body exploration'));
 session={...session,active:true,activeSessionId:'shared-session-313',startedAt:new Date().toISOString(),entity:'BodyExploration'};
 doc={id:session.activeSessionId,title:'Shared test title',notes:'Shared test notes',event_timeline:[]};await publish();
 for(const p of pages){await p.waitForFunction(()=>document.querySelector('[aria-label="Session title"]')?.value==='Shared test title');assert.ok((await consoleFor(p).innerText()).includes('session shared-s'));}
 const before=posts.length;await consoleFor(pages[1]).getByRole('button',{name:'Join active session',exact:true}).click();
 await pages[1].getByText('Joined the existing shared session.',{exact:false}).waitFor();assert.equal(posts.length,before);
 session={...session,active:false,finalizedAt:new Date().toISOString()};
 for(const p of pages)await p.waitForFunction(()=>document.querySelector('[aria-label="Session recording"]')?.textContent.includes('SESSION ENDED'),{},{timeout:8000});
 assert.deepEqual(errors,[]);console.log('PASS two isolated clients: shared type/session/title; Start joins without writes; dropped-stream stop recovered by polling; no recording/device writes');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
