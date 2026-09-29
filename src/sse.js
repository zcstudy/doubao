// 上游 OpenAI 兼容 SSE → 结构化增量。
// 学校v100 这类思考模型会把正文放在 delta.reasoning_content，答案放在 delta.content，
// 两者必须分开收集，否则前端在"想"的阶段会看到空白。

export function createAccumulator() {
  return {
    text: '',
    reasoning: '',
    toolCalls: [],   // 按 index 累积，arguments 是分片拼出来的
    finishReason: null,
    usage: null,
  };
}

export function feedJson(chunk, acc) {
  const delta = chunk?.choices?.[0]?.delta ?? {};
  const out = { text: '', reasoning: '', toolCallStart: [] };

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    acc.reasoning += delta.reasoning_content;
    out.reasoning = delta.reasoning_content;
  }
  if (typeof delta.content === 'string' && delta.content) {
    acc.text += delta.content;
    out.text = delta.content;
  }
  for (const tc of delta.tool_calls ?? []) {
    const idx = tc.index ?? 0;
    if (!acc.toolCalls[idx]) {
      acc.toolCalls[idx] = { id: tc.id ?? '', name: '', arguments: '' };
      out.toolCallStart.push(idx);
    }
    const slot = acc.toolCalls[idx];
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name = tc.function.name;
    if (tc.function?.arguments) slot.arguments += tc.function.arguments;
  }

  const fr = chunk?.choices?.[0]?.finish_reason;
  if (fr) acc.finishReason = fr;
  if (chunk?.usage) acc.usage = chunk.usage;
  return out;
}

// 把字节流切成 SSE 事件，交给 onEvent({ type:'data'|'done', payload })
export async function parseSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { await onEvent({ type: 'done' }); continue; }
        try { await onEvent({ type: 'data', payload: JSON.parse(data) }); }
        catch { /* 上游偶尔会发半截心跳，忽略 */ }
      }
    }
  }
}

// 有些服务不支持流式工具调用，非流式响应走这个折进同一个累加器
export function absorbNonStream(body, acc) {
  const msg = body?.choices?.[0]?.message;
  if (!msg) return;
  if (typeof msg.reasoning_content === 'string') acc.reasoning += msg.reasoning_content;
  if (typeof msg.content === 'string') acc.text += msg.content;
  for (const tc of msg.tool_calls ?? []) {
    acc.toolCalls.push({
      id: tc.id ?? '', name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '',
    });
  }
  acc.finishReason = body?.choices?.[0]?.finish_reason ?? 'stop';
  if (body?.usage) acc.usage = body.usage;
}
