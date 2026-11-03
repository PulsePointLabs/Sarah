export function buildChatHistory(messages = [], { visual = false, formatTime = () => '' } = {}) {
  return messages.slice(-10).map(message => {
    let text = String(message.text || '');
    if (visual && text.length > 760) text = `${text.slice(0, 720)}\n[Earlier visual-review text shortened]`;
    const attachments = message.imageAttachments?.length;
    return `${message.role === 'user' ? 'User' : 'AI'} (${formatTime(message)}): ${text}${attachments ? ` [${attachments} attached image${attachments === 1 ? '' : 's'}]` : ''}`;
  }).join('\n');
}

export function conversationalRequestInstruction(text, interviewPrompt) {
  if (!String(text || '').trim()) return interviewPrompt;
  return `You are Sarah in an ongoing conversation. Answer the user's newest message directly and naturally, using their saved personality preferences.
Earlier session/profile material is background, not a request for analysis or an interview.
Only analyze, summarize, assess physiology, or introduce a new session topic when the user asks for it or it directly answers their current question.
Do not force a follow-up question, switch to a fresh angle, or steer ordinary conversation back to a procedure or session.
Use the recent conversation and supplied profile for continuity. Ask for clarification when a fact is missing rather than inventing it.
Match the requested level of detail. Preserve the distinction between reported facts, measurements and interpretations.`;
}
