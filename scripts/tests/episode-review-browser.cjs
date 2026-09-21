// Synthetic data only. Start Vite on 5175 before running.
const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/benja/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage(),requests=[],errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    let reviews=[];
    await page.route('**/api/entities/Session/episode-test/episode-reviews',async route=>{
      if(route.request().method()==='POST'){
        requests.push(route.request().postDataJSON());
        reviews=[{episode_id:'n',job:{status:'running',progress:{message:'Reviewing segment 1 of 2',current:1,total:3}}}];
        return route.fulfill({json:{jobs:[{id:'j'}]}});
      }
      return route.fulfill({json:reviews});
    });
    await page.goto('http://127.0.0.1:5175/scripts/tests/fixtures/episode-review.html');
    await page.getByRole('button',{name:'Fill missing analyses (1)'}).click();
    await page.getByRole('status').filter({hasText:'Reviewing segment 1 of 2'}).waitFor();
    assert.equal(requests[0].fillMissing,true);
    const episode={id:'n',kind:'near_climax',start_s:15,end_s:25,source:{key:'main',label:'Main'}};
    reviews=[{episode_id:'n',job:{status:'done'},result:{signature:JSON.stringify([1,episode.id,episode.kind,episode.start_s,episode.end_s,episode.source]),
      evidence:{peak:{score:70,time_s:20},median_score:60,usable_hrv_samples:10},source:{role:'main'},
      synthesis:{overview:'Independent current episode review.',approach_assessment:'Evidence increased during this window.',progression:'Early build, later easing.',recovery:'Toe flexion decreased.',limitations:'Synthetic test.',comparisons:[]},
      segments:[{start_s:10,end_s:30,summary:'Early to late progression.',metrics:[{metric:'Toes',visibility:'partial',confidence:'low',observation:'Possible slight flexion.',progression:'Later decrease.',time_s:22}]}]}}];
    await page.getByText('Independent current episode review.').waitFor();
    await page.getByRole('button',{name:'Fill missing analyses (0)'}).waitFor();
    assert.equal(await page.getByText('Head-to-toe visual checklist',{exact:false}).evaluate(el=>el.parentElement.open),true);
    await page.getByText('Early to late progression.',{exact:false}).click();
    await page.getByText('Possible slight flexion.').waitFor();
    await page.getByRole('button',{name:'0:22.0 ↗',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.lastSeek),22);
    reviews[0].job={status:'error',error:'Synthetic provider failure'};
    await page.getByRole('alert').filter({hasText:'Synthetic provider failure'}).waitFor();
    assert.equal(await page.getByText('Independent current episode review.').isVisible(),true);
    await page.getByRole('button',{name:'Re-analyze',exact:true}).click();
    assert.equal(requests.at(-1).episodeId,'n');assert.deepEqual(errors,[]);
    console.log('PASS: episode fill, progress, completed review, full checklist, seek, old-review retention on failure, and re-analyze. API mocked.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
