import {cleanWhisperTranscript} from '../utils/whisperTranscript.js';

// Only repair short coordinated fragments; never paraphrase clinical wording.
export function smoothReviewDictation(raw) {
  if (/^\s*(?:example[\s,.!?]*){2,}\s*$/i.test(String(raw||''))) return '';
  return cleanWhisperTranscript(raw).replace(/\.\s+(And|Or)\s+([^.!?]+)([.!?]|$)/g,(whole,join,tail,end)=>{
    if(tail.trim().split(/\s+/).length>6 || /\b(is|are|was|were|has|have|had|will|can|could|should|would)\b/i.test(tail))return whole;
    return ` ${join.toLowerCase()} ${tail}${end}`;
  });
}

// Revise the current spoken span while preserving typing before/after it.
export function mergeReviewDictation(previous, lastTranscript, transcript) {
  if(!transcript)return previous;
  if(lastTranscript){
    const at=previous.lastIndexOf(lastTranscript);
    if(at>=0)return previous.slice(0,at)+transcript+previous.slice(at+lastTranscript.length);
    // The user edited the spoken text: retain those edits, append only new speech.
    const before=lastTranscript.split(/\s+/),after=transcript.split(/\s+/);
    let common=0;while(common<before.length&&common<after.length&&before[common]===after[common])common++;
    if(common===0)return previous;
    transcript=after.slice(common).join(' ');
    if(!transcript)return previous;
  }
  return previous.trim()?`${previous.trim()} ${transcript}`:transcript;
}
