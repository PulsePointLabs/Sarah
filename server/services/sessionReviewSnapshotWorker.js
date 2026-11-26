import {parentPort,workerData} from 'node:worker_threads';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {recordedDevices,sessionOutcome} from '../../src/lib/videoRecordSummary.js';
import {bloodPressureFallsInSession} from '../../src/lib/liveSessionBloodPressure.js';

function accumulator(){let min=Infinity,max=-Infinity,sum=0,n=0;return {add(v){if(typeof v!=='number'||!Number.isFinite(v))return;min=Math.min(min,v);max=Math.max(max,v);sum+=v;n++;},result(){return n?{min,avg:sum/n,max,samples:n}:null;}};}
async function pressureSummary(file){
  if(!fs.existsSync(file))return null;
  const raw=accumulator(),usable=accumulator();
  for await(const line of readline.createInterface({input:fs.createReadStream(file,{encoding:'utf8'}),crlfDelay:Infinity})){
    if(!line.trim())continue;
    let row;try{row=JSON.parse(line);}catch{throw new Error('Recorded pressure contains an unreadable row; snapshot unavailable.');}
    raw.add(row.pressure_kpa);
    if(row.usable!==false&&row.calibration_valid!==false)usable.add(row.pressure_kpa);
  }
  const good=usable.result();return good?{...good,unit:'kPa',quality:'usable recorded samples'}:raw.result()?{...raw.result(),unit:'kPa',quality:'raw / uncalibrated'}:null;
}

const db=new Database(workerData.dbPath,{readonly:true});
try{
  const snapshots=[];
  const get=db.prepare('SELECT data FROM entities WHERE entity=? AND id=?');
  const heart=db.prepare(`SELECT MIN(CAST(json_extract(data,'$.hr') AS REAL)) AS min,AVG(CAST(json_extract(data,'$.hr') AS REAL)) AS avg,MAX(CAST(json_extract(data,'$.hr') AS REAL)) AS max,COUNT(*) AS samples FROM entities WHERE entity='HeartRateTimeline' AND json_extract(data,'$.session')=? AND CAST(json_extract(data,'$.hr') AS REAL) BETWEEN 20 AND 260`);
  const has=db.prepare("SELECT 1 FROM entities WHERE entity=? AND json_extract(data,'$.session')=? LIMIT 1");
  const howl=db.prepare("SELECT 1 FROM entities WHERE entity='HowlTelemetry' AND json_extract(data,'$.session')=? AND json_extract(data,'$.connection_state')='connected' LIMIT 1");
  for(const item of workerData.records){
    if(!['Session','BodyExploration'].includes(item.entity)||!/^[a-zA-Z0-9_-]{1,150}$/.test(item.id))continue;
    const row=get.get(item.entity,item.id);if(!row)continue;const record=JSON.parse(row.data);
    let hr=heart.get(item.id);if(!hr.samples)hr=null;
    if(!hr&&record.hr_timeline?.length){const samples=accumulator();for(const value of record.hr_timeline){const v=typeof value==='number'?value:value.hr;if(v>=20&&v<=260)samples.add(v);}hr=samples.result();}
    if(!hr&&Number(record.avg_hr)>0)hr={min:Number(record.min_hr)>0?Number(record.min_hr):null,avg:Number(record.avg_hr),max:Number(record.max_hr)>0?Number(record.max_hr):null,samples:null};
    let pressure=null,pressureError=null;
    try{pressure=await pressureSummary(path.join(workerData.civetDirectory,`${item.id}.jsonl`));}catch(error){pressureError=error.message;}
    const startMs=Date.parse(record.capture_started_at||`${String(record.date||'').slice(0,10)}T${record.start_time||'00:00'}:00`);
    const duration=Math.max(Number(record.capture_wall_duration_seconds)||0,(Number(record.duration_minutes)||0)*60);
    const endMs=Date.parse(record.capture_finalized_at||'')||startMs+duration*1000;
    const bp=(record.blood_pressure_readings||[]).some(reading=>bloodPressureFallsInSession(reading,{startMs,endMs,sessionId:item.id,pauses:record.capture_pause_intervals||[]}));
    snapshots.push({id:item.id,entity:item.entity,version:1,event_count:record.event_timeline?.length||0,episode_count:record.subjective_near_climax_episodes?.length||0,record_updated_at:record.updated_date,generated_at:new Date().toISOString(),heart_rate:hr,pelvic_pressure:pressure,pressure_error:pressureError,devices:recordedDevices(record,{hr:!!hr,civet:!!pressure,emg:!!has.get('EMGTimeline',item.id),bp:bp||!!has.get('BloodPressureReading',item.id),howl:!!howl.get(item.id)}),outcome:sessionOutcome(record,item.entity==='BodyExploration'?'body_exploration':'session')});
  }
  parentPort.postMessage({snapshots});
}catch(error){parentPort.postMessage({error:error.message});}finally{db.close();}
