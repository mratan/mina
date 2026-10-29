// Old reasoning out of each request (docs/architecture.md). Pi sends every earlier assistant turn's reasoning
// back to the server (llama.cpp: reasoning_content), and some chat templates put it in the prompt. In earlier
// test runs that was about 15k of 70k context tokens, so compaction freed less and less. The tuning file's
// keep_reasoning_turns keeps the reasoning of the last N assistant messages, which the model may still be using, and
// drops the rest from the request only: the session file keeps everything, for recall. The server's prompt cache
// breaks once per turn where a message falls out of the window, which costs re-reading the last few messages.
export function stripOldReasoning(messages, keep) {
  if (keep === null || keep === undefined || !Array.isArray(messages)) return { messages, dropped: 0 };
  const assistants = [];
  messages.forEach((m, i) => { if (m?.role === 'assistant' && Array.isArray(m.content)) assistants.push(i); });
  const old = new Set(assistants.slice(0, Math.max(0, assistants.length - keep)));
  let dropped = 0;
  const out = messages.map((m, i) => {
    if (!old.has(i)) return m;
    const rest = m.content.filter((b) => b?.type !== 'thinking');
    if (rest.length === m.content.length || rest.length === 0) return m;               // nothing to drop, or only reasoning
    dropped += m.content.length - rest.length;
    return { ...m, content: rest };
  });
  return { messages: out, dropped };
}
