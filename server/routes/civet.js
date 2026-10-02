import { Router } from 'express';
import path from 'node:path';
import { dataDir } from '../config.js';
import { upsertEntity } from '../db.js';
import { createCivetService } from '../services/civet.js';
import { CIVET_VERSION } from '../../src/lib/civetAnalysis.js';
import { civetCsv } from '../../src/lib/civetExport.js';
export function createCivetRouter(session, onService = () => {}) {
  const router=Router();
  const service=createCivetService({directory:path.join(dataDir,'civet'),session,onRecorded:current=>upsertEntity(current.entity||'Session',current.id,{civet_enabled:true,civet_algorithm:CIVET_VERSION})});
  onService(service);
  router.get('/status',(_req,res)=>res.json(service.status()));
  router.get('/session/:id',(req,res)=>{try{res.json({samples:service.samples(req.params.id),analysis:service.analysis(req.params.id)});}catch(error){res.status(400).json({error:error.message});}});
  router.get('/session/:id/export',(req,res)=>{try{
    const kind=req.query.kind||'samples',mode=req.query.mode||'review';
    if(!['samples','events','trains','analysis'].includes(kind)||!['live','review','reprocessed'].includes(mode))throw new Error('Unknown CIVET export.');
    const analysis=kind==='samples'&&mode==='live'?null:service.analysis(req.params.id);
    if(mode==='review'&&!analysis?.review)throw new Error('Review analysis is available after recording ends. Recorded live results remain available.');
    if(kind==='analysis'){res.attachment(`civet-${req.params.id}-analysis.json`).json(analysis);return;}
    if(mode==='reprocessed'&&!analysis?.reprocessed)throw new Error('Reprocessed analysis is available after recording ends.');
    const rows=kind==='samples'?(mode==='live'?service.samples(req.params.id):analysis[mode].rows):analysis[mode][kind];
    const sampleKeys=['t','timestamp_ms','pressure_kpa','delta_kpa','level_pct','avg_kpa','max_kpa','contractions_60s','duration_s','rhythm','usable','evidence','monotonic_ms','sequence','connection_id','raw_pressure_integer','raw_packet_hex','filtered_kpa','tonic_kpa','phasic_kpa','gap','gap_s','calibration','calibration_valid','quality_flags','algorithm','mode','peak_candidates'];
    const keys=kind==='samples'?[...sampleKeys,'acquisition_policy','acquisition_state','reprocessed','recorded_acquisition_state','recorded_usable']:[...new Set(rows.flatMap(Object.keys))];
    res.type('text/csv').attachment(`civet-${req.params.id}-${kind}-${mode}.csv`).send(civetCsv(rows,keys.length?keys:[kind==='trains'?'train_index':'event_index','algorithm']));
  }catch(error){res.status(400).json({error:error.message});}});
  for(const action of ['install','scan','connect','disconnect','calibrate','zero'])router.post(`/${action}`,async(req,res)=>{try{res.json(await service[action](req.body||{}));}catch(error){res.status(400).json({error:error.message});}});
  return router;
}
