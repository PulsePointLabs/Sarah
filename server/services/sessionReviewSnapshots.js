import {Worker} from 'node:worker_threads';
import {databasePath,dataDir} from '../config.js';
import path from 'node:path';

// Work outside the acquisition event loop; never replay pressure morphology for a picker.
const cache=new Map();
export function loadSessionReviewSnapshots(records,{dbPath=databasePath,civetDirectory=path.join(dataDir,'civet'),fresh=false}={}) {
  const key=JSON.stringify([dbPath,records]);
  const previous=cache.get(key);
  if(!fresh&&previous&&Date.now()-previous.at<60000)return previous.promise;
  const promise=new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./sessionReviewSnapshotWorker.js',import.meta.url),{workerData:{records,dbPath,civetDirectory}});
    worker.once('message',message=>message.error?reject(new Error(message.error)):resolve(message.snapshots));
    worker.once('error',reject);worker.once('exit',code=>{if(code!==0)reject(new Error('Session snapshot worker exited unexpectedly.'));});
  }).catch(error=>{cache.delete(key);throw error;});
  if(cache.size>20)cache.delete(cache.keys().next().value);
  cache.set(key,{at:Date.now(),promise});return promise;
}
