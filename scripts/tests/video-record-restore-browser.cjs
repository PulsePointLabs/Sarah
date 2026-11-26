const assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const p=await browser.newPage({viewport:{width:1366,height:900}}),errors=[],writes=[],details=[];
 p.on('pageerror',e=>errors.push(e.message));
 const records=[
  {id:'record-a',date:'2026-10-20',event_timeline:[{id:'a-note',time_s:3,note:'Retained note A',category:['observation']}],subjective_near_climax_episodes:[{id:'episode-a',kind:'near_climax',start_s:1,end_s:4}],linked_local_videos:[{id:'a-video',path:'C:/fixture/a.mp4',filename:'saved-a.mp4',label:'Saved camera A',exists:true}],ai_analysis:{saved_marker:'Retained analysis'}},
  {id:'record-b',date:'2026-10-27',event_timeline:[{id:'b-note',time_s:2,note:'Retained note B',category:['observation']},{id:'b-note-2',time_s:4,note:'Second note B',category:['observation']}],subjective_near_climax_episodes:[{id:'episode-b',kind:'near_climax',start_s:1,end_s:4},{id:'episode-b-2',kind:'climax',start_s:8,end_s:10}],linked_local_videos:[{id:'b-video',path:'C:/fixture/b.mp4',filename:'saved-b.mp4',label:'Saved camera B',exists:true}]}
 ];
 let failTimeline=false,slowA=false;
 await p.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),pathname=url.pathname;
  if(pathname.includes('/src/'))return route.continue();
  const json=body=>route.fulfill({json:body});
 if(url.pathname==='/api/session-video/review-summaries')return json({snapshots:[]});
  if(req.method()==='GET'&&pathname==='/api/entities/Session')return json(records.map(({id,date})=>({id,date})));
  const record=records.find(r=>pathname===`/api/entities/Session/${r.id}`);
  if(record&&req.method()==='GET'){details.push(record.id);if(slowA&&record.id==='record-a')await new Promise(r=>setTimeout(r,650));return json(record);}
  if(pathname==='/api/entities/HeartRateTimeline/filter')return failTimeline?route.fulfill({status:503,json:{error:'Timeline unavailable'}}):json([]);
  if(pathname==='/api/files/local-video/playback-preview')return json({status:'ready',url:'/api/fixture-video',cached:true});
  if(pathname==='/api/fixture-video')return route.fulfill({path:'logs/two-angle-test.mp4',contentType:'video/mp4'});
  if(req.method()!=='GET'){writes.push(pathname);return route.fulfill({status:409,json:{error:'No data writes permitted'}});}
  return json([]);
 });
 await p.goto('http://127.0.0.1:5175/video?id=record-a');
 await p.getByRole('button',{name:'Visible Events (1)',exact:true}).waitFor();await p.getByRole('button',{name:'Near-climax / climax episodes (1)',exact:true}).waitFor();
 assert.ok(await p.getByText('Saved camera A',{exact:true}).count());await p.locator('video[src]').first().waitFor();
 await p.getByRole('button',{name:'Near-climax / climax episodes (1)',exact:true}).click();await p.getByRole('region',{name:'Subjective near-climax episodes',exact:true}).waitFor();
 failTimeline=true;await p.getByRole('button',{name:'Refresh selected',exact:true}).click();
 await p.getByText(/Saved videos, events and marked episodes are loaded/).waitFor();await p.getByRole('button',{name:'Visible Events (1)',exact:true}).waitFor();
 failTimeline=false;slowA=true;
 await p.getByRole('combobox').first().click();await p.getByRole('option').filter({hasText:'Oct 27, 2026'}).click();
 await p.getByRole('button',{name:'Visible Events (2)',exact:true}).waitFor();
 await p.getByRole('combobox').first().click();await p.getByRole('option').filter({hasText:'Oct 20, 2026'}).click();
 await p.getByRole('combobox').first().click();await p.getByRole('option').filter({hasText:'Oct 27, 2026'}).click();
 await p.getByRole('button',{name:'Visible Events (2)',exact:true}).waitFor();await p.waitForTimeout(850);
 assert.ok(await p.getByRole('button',{name:'Near-climax / climax episodes (2)',exact:true}).count());assert.equal(await p.getByRole('button',{name:'Visible Events (1)',exact:true}).count(),0);
 assert.ok(details.includes('record-a')&&details.includes('record-b'));assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 console.log('PASS saved record detail hydration, linked cached video, events/episodes, independent timeline failure, rapid-selection stale response protection; no record writes');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
