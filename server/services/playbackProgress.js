import { spawn } from 'node:child_process';

export function applyPlaybackProgress(job, fields, now = Date.now()) {
  const seconds = Number(fields.out_time_us ?? fields.out_time_ms) / 1e6;
  if (Number.isFinite(seconds)) job.encodedSeconds = Math.max(0, seconds);
  const speed = Number(String(fields.speed || '').replace(/x$/, ''));
  if (Number.isFinite(speed) && speed > 0) job.speed = speed;
  job.percent = job.durationSeconds > 0 ? Math.min(99, job.encodedSeconds / job.durationSeconds * 100) : null;
  job.etaSeconds = job.speed > 0 && job.durationSeconds > 0 ? Math.max(0, (job.durationSeconds-job.encodedSeconds)/job.speed) : null;
  job.lastProgressAt = now;
  if (fields.progress === 'end' || job.percent >= 99) job.stage = 'Finalizing MP4';
}
export function runPlaybackProcess(args, job) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-progress','pipe:1',...args], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let buffer='', stderr='', fields={};
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines=buffer.split(/\r?\n/);buffer=lines.pop();
      for(const line of lines) {
        const split=line.indexOf('=');if(split<0)continue;
        fields[line.slice(0,split)]=line.slice(split+1);
        if(line.startsWith('progress=')) { applyPlaybackProgress(job,fields);fields={}; }
      }
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-12000);});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(new Error(stderr.trim()||`FFmpeg exited with code ${code}`)));
  });
}
export function playbackJobStatus(job, queuePosition = 0, now = Date.now()) {
  return { status:job.status, stage:job.stage, percent:job.percent ?? null, encodedSeconds:job.encodedSeconds||0,
    durationSeconds:job.durationSeconds||0, speed:job.speed||null, etaSeconds:job.etaSeconds??null,
    elapsedSeconds:Math.max(0,(now-(job.startedAt||job.createdAt))/1000), queuePosition,
    secondsSinceProgress:job.lastProgressAt?Math.max(0,(now-job.lastProgressAt)/1000):null,
    fallback:job.fallback||false };
}
