// Used by the Windows launcher; never opens a client against an unready backend.
async function ready() {
  try {
    const response=await fetch('http://127.0.0.1:8787/api/health',{signal:AbortSignal.timeout(1500)});
    const data=await response.json();
    return response.ok&&data.ok===true&&data.app==='Sarah Local API';
  } catch {return false;}
}
(async()=>{
  const check=process.argv.includes('--check'),deadline=Date.now()+(check?0:45000);
  do {
    if(await ready())process.exit(0);
    if(check)break;
    await new Promise(resolve=>setTimeout(resolve,500));
  } while(Date.now()<deadline);
  process.exit(1);
})();
