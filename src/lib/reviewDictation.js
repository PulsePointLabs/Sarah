import {cleanWhisperTranscript} from '../utils/whisperTranscript.js';

// Only repair short coordinated fragments; never paraphrase clinical wording.
export function smoothReviewDictation(raw) {
  return cleanWhisperTranscript(raw).replace(/\.\s+(And|Or)\s+([^.!?]+)([.!?]|$)/g,(whole,join,tail,end)=>{
    if(tail.trim().split(/\s+/).length>6 || /\b(is|are|was|were|has|have|had|will|can|could|should|would)\b/i.test(tail))return whole;
    return ` ${join.toLowerCase()} ${tail}${end}`;
  });
}
