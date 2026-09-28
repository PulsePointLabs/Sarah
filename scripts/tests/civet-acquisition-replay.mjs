import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createCivetProcessor} from '../../src/lib/civet.js';
const file=process.argv[2];if(!file)throw Error('Provide a CIVET JSONL path; this replay never writes recordings.');
const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');
const rows=bytes.toString().trim().split('\n').map(JSON.parse),p=createCivetProcessor();let previousKind=null;const counts={},transitions=[];let lastState='',pulses=0,usable=0,previousConnection;
for(const r of rows){const status=r.calibration_status;const kind=['preparing','collecting'].includes(status?.phase)?status.kind:null;if(kind&&kind!==previousKind)p.calibrate(kind,{prepareS:status.phase==='preparing'?3:0});previousKind=kind;
const out=p.ingest(r.pressure_kpa,r.t,{timestamp_ms:r.timestamp_ms,reconnected:previousConnection!=null&&r.connection_id!==previousConnection});previousConnection=r.connection_id;
if(out.acquisition_state!==lastState){transitions.push({t:r.t,state:out.acquisition_state});lastState=out.acquisition_state;}counts[out.acquisition_state]=(counts[out.acquisition_state]||0)+1;if(out.usable)usable++;if(r.t>rows.at(-1).t-600)pulses+=out.events.filter(e=>e.quality==='usable').length;}
if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw Error('Recording changed');
console.log(JSON.stringify({samples:rows.length,unchanged:true,counts,usable,pulses_last10minutes:pulses,transitions:transitions.slice(0,20)},null,2));
