import Anthropic from '@anthropic-ai/sdk';
const fields=['hr','baselineHr','hrvRmssd','hrvSdnn','buildConfidence','plateauConfidence','recovery','deltaHr','pressure_kpa','sessionTimeSec'];
export function liveCueContext(input={}){
  return Object.fromEntries(fields.filter(key=>typeof input[key]==='number'&&Number.isFinite(input[key])).map(key=>[key,Math.round(input[key]*10)/10]));
}
export async function generateLiveCue({type,captureKind,context,recent=[],style},create){
  if(typeof type!=='string'||!/^[a-z_]{1,40}$/.test(type))throw Error('Invalid live cue type.');
  const previous=Array.isArray(recent)?recent.filter(v=>typeof v==='string').slice(-6).map(v=>v.slice(0,200)):[];
  const payload={model:process.env.LIVE_CUE_AI_MODEL||process.env.ANTHROPIC_MODEL||'claude-sonnet-4-6',max_tokens:110,temperature:.85,
    system:'Write one original spoken observation or encouragement for Ben, an adult physiological tracking user. Warm, natural, grounded and concise; maximum 26 words. No preamble, quotation marks, emoji or canned slogans. Be comfortable with the domain but do not eroticize. Only describe supplied numeric evidence; a detector cue is uncertain, never confirmation of orgasm, safety, emotion, muscle identity, or current through tissue. Do not recommend changing stimulation or procedures. No breathing instructions without breathing data. Avoid all wording and advice in recent utterances. Prefer a useful observation over generic praise. If nothing new is supported, output QUIET. Return only the spoken text.',
    messages:[{role:'user',content:JSON.stringify({event:type,captureKind:captureKind==='body_exploration'?'body_exploration':'session',tone:style==='clinical_minimal'?'brief clinical':'warm conversational',telemetry:liveCueContext(context),recent:previous})}]};
  if(!create){
    if(!process.env.ANTHROPIC_API_KEY)throw Error('Generated feedback needs the configured Sarah AI key. Choose prerecorded cues to use the offline phrase library.');
    const client=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY,timeout:6500,maxRetries:0});create=data=>client.messages.create(data);
  }
  const response=await create(payload);
  let text=(response.content||[]).filter(p=>p.type==='text').map(p=>p.text).join(' ').trim().replace(/^['"]|['"]$/g,'');
  if(!text||text==='QUIET'||response.stop_reason==='max_tokens')return '';
  const normalize=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
  if(previous.some(p=>normalize(p)===normalize(text)))return '';
  if(text.split(/\s+/).length>40)return '';
  return text;
}
