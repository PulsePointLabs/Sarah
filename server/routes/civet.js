import { Router } from 'express';
import path from 'node:path';
import { dataDir } from '../config.js';
import { upsertEntity } from '../db.js';
import { createCivetService } from '../services/civet.js';
export function createCivetRouter(session) {
  const router=Router();
  const service=createCivetService({directory:path.join(dataDir,'civet'),session,onRecorded: current=>upsertEntity(current.entity||'Session',current.id,{civet_enabled:true,civet_algorithm:'civet-pressure-v1'})});
  router.get('/status',(_req,res)=>res.json(service.status()));
  router.get('/session/:id',(req,res)=>{try{res.json({samples:service.samples(req.params.id)});}catch(error){res.status(400).json({error:error.message});}});
  router.get('/session/:id/export',(req,res)=>{try{const rows=service.samples(req.params.id);const keys=['t','timestamp_ms','pressure_kpa','delta_kpa','level_pct','avg_kpa','max_kpa','contractions_60s','duration_s','rhythm','usable','evidence'];res.type('text/csv').attachment(`civet-${req.params.id}.csv`).send([keys.join(','),...rows.map(row=>keys.map(key=>JSON.stringify(row[key]??'')).join(','))].join('\n'));}catch(error){res.status(400).json({error:error.message});}});
  for(const action of ['install','scan','connect','disconnect','calibrate']) router.post(`/${action}`,async(req,res)=>{try{res.json(await service[action](req.body||{}));}catch(error){res.status(400).json({error:error.message});}});
  return router;
}
