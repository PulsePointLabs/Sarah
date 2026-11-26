import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {databasePath,dataDir} from '../server/config.js';
import {loadSessionReviewSnapshots} from '../server/services/sessionReviewSnapshots.js';

// Derived display metadata only. Does not alter notes, telemetry or update dates.
const db=new Database(databasePath,{readonly:!process.argv.includes('--write')});
try{
  const records=db.prepare("SELECT entity,id,updated_date,data FROM entities WHERE entity IN ('Session','BodyExploration')").all();
  const snapshots=await loadSessionReviewSnapshots(records.map(({entity,id})=>({entity,id})),{fresh:true});
  console.log(JSON.stringify({records:snapshots.length,withHeartRate:snapshots.filter(s=>s.heart_rate).length,withPressure:snapshots.filter(s=>s.pelvic_pressure).length,pressureErrors:snapshots.filter(s=>s.pressure_error).length}));
  if(process.argv.includes('--write')){
    const directory=path.join(dataDir,'backups');fs.mkdirSync(directory,{recursive:true});
    const backup=path.join(directory,`review-snapshots-${Date.now()}.json`);
    fs.writeFileSync(backup,JSON.stringify(records.map(record=>({entity:record.entity,id:record.id,previous:JSON.parse(record.data).review_snapshot??null}))),{flag:'wx'});
    const original=new Map(records.map(row=>[`${row.entity}:${row.id}`,row.data]));
    const update=db.prepare("UPDATE entities SET data=json_set(data,'$.review_snapshot',json(?)) WHERE entity=? AND id=? AND data=?");
    let updated=0;
    db.transaction(()=>{for(const snapshot of snapshots)updated+=update.run(JSON.stringify(snapshot),snapshot.entity,snapshot.id,original.get(`${snapshot.entity}:${snapshot.id}`)).changes;})();
    console.log(JSON.stringify({updated,backup,changedNotes:false,changedTimestamps:false}));
  }
}finally{db.close();}
