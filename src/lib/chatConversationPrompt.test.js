import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildChatHistory, conversationalRequestInstruction } from './chatConversationPrompt.js';
import { buildConversationIntelligencePrompt, buildResponsePlan, updateConversationTopicState } from './sarahConversationIntelligence.js';

test('normal chat preserves the last ten complete messages and facts after character 520', () => {
  const messages=Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',text:`turn-${i}: ${'context '.repeat(100)}TAIL-FACT-${i}`}));
  const result=buildChatHistory(messages);
  assert.doesNotMatch(result,/turn-0:|turn-1:/);
  for(let i=2;i<12;i++)assert.match(result,new RegExp(`TAIL-FACT-${i}\\b`));
  assert.doesNotMatch(result,/truncated for faster/);
});
test('visual-review history remains compact and retains attachment references', () => {
  const result=buildChatHistory([{role:'user',text:'a'.repeat(2000),imageAttachments:[{}]}],{visual:true});
  assert.ok(result.length<850);assert.match(result,/1 attached image/);
});
test('ordinary questions are answered without forcing analysis, a new angle, or an interview', () => {
  const result=conversationalRequestInstruction('How was your day?', 'Switch to a fresh angle. ONE question.');
  assert.doesNotMatch(result,/Switch to a fresh angle\. ONE question/);
  assert.match(result,/Answer the user's newest message directly/);
  assert.match(result,/Only analyze/);assert.match(result,/Do not force a follow-up question/);
  assert.equal(conversationalRequestInstruction('', 'Begin the requested interview'), 'Begin the requested interview');
});
test('ordinary chat supplies profile grounding and leaves personality and speech settings intact', () => {
  const source=fs.readFileSync(new URL('../components/AIChat.jsx',import.meta.url),'utf8');
  assert.match(source,/: buildAIGroundingContext\(userProfile\)/);
  assert.match(source,/conversationalRequestInstruction\(text, interviewPrompt\)/);
  assert.match(source,/buildSarahPersonalityPrompt\(sarahPersonality/);
  assert.doesNotMatch(source,/CHAT_HISTORY_MESSAGE_MAX_CHARS = 520|CHAT_INTERACTIVE_HISTORY_LIMIT = 6/);
});
test('a hanging optional context service falls back instead of preventing the AI request', async () => {
  const source=fs.readFileSync(new URL('./sarahConversationContext.js',import.meta.url),'utf8')
    .replace(/^import[\s\S]*?from [^;]+;\r?\n/gm,'').replace(/^export /gm,'');
  const context=vm.createContext({AbortController,setTimeout,clearTimeout,apiUrl:p=>p,
    buildConversationIntelligencePrompt,buildResponsePlan,updateConversationTopicState,
    fetch:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Context request timed out'))))});
  vm.runInContext(source+'\nthis.load=loadSarahConversationContext;',context);
  const result=await context.load({message:'Tell me about coffee',mode:'profile'},{timeoutMs:20});
  assert.equal(result.degraded,true);assert.match(result.promptContext,/SARAH CONVERSATION CONTROL/);
  assert.match(result.error,/timed out/);
});
