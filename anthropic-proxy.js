#!/usr/bin/env node
// Minimal Anthropic Messages API -> OpenAI chat.completions proxy (no dependencies).
// Lets Claude Code talk to an OpenAI-only server such as llama.cpp.
//   PROXY_PORT (default 8089)  PROXY_HOST (default 127.0.0.1)
//   UPSTREAM   (default http://127.0.0.1:8083)
'use strict';
const http = require('http');

const PORT = Number(process.env.PROXY_PORT || 8089);
const HOST = process.env.PROXY_HOST || '127.0.0.1';
const UPSTREAM = new URL(process.env.UPSTREAM || 'http://127.0.0.1:8083');

const log = (...a) => console.error(new Date().toISOString(), ...a);
const textOf = (c) =>
  typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

function toOpenAI(body) {
  const messages = [];
  if (body.system) {
    const s = textOf(body.system);
    if (s) messages.push({ role: 'system', content: s });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = textOf(m.content);
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
    } else {
      const parts = [];
      // tool results first (they must follow the assistant tool_calls), then remaining user content
      const results = m.content.filter((b) => b.type === 'tool_result');
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: textOf(r.content) || (r.is_error ? 'error' : '') });
      }
      const rest = m.content.filter((b) => b.type !== 'tool_result');
      const content = rest.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'image' && b.source) {
          const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url;
          return { type: 'image_url', image_url: { url } };
        }
        return null;
      }).filter(Boolean);
      if (content.length) {
        messages.push({ role: 'user', content: content.every((c) => c.type === 'text') ? content.map((c) => c.text).join('\n') : content });
      }
    }
  }
  const out = { messages, stream: !!body.stream };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body.tools && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
    const tc = body.tool_choice;
    if (tc) {
      if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'none') out.tool_choice = 'none';
      else if (tc.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
      else out.tool_choice = 'auto';
    }
  }
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

const stopReason = (fr) => ({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use' }[fr] || 'end_turn');
const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const msgId = () => 'msg_' + Math.random().toString(36).slice(2, 14);

function toAnthropic(res, model) {
  const ch = (res.choices || [])[0] || {};
  const m = ch.message || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const c of m.tool_calls || []) {
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: safeJson(c.function.arguments) });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: msgId(), type: 'message', role: 'assistant', model, content,
    stop_reason: stopReason(ch.finish_reason), stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens || 0, output_tokens: res.usage?.completion_tokens || 0 },
  };
}

function upstreamReq(path, method, payload, cb) {
  const data = payload ? JSON.stringify(payload) : null;
  return http.request({
    host: UPSTREAM.hostname, port: UPSTREAM.port, path, method,
    headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
  }, cb);
}

function sendErr(res, status, message) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message } }));
}

function handleMessages(body, res) {
  const model = body.model || 'local';
  const payload = toOpenAI(body);
  // Upstream streaming hangs on some llama.cpp builds: fetch the full reply and replay it as SSE.
  const replay = payload.stream && process.env.UPSTREAM_STREAM !== '1';
  if (replay) { payload.stream = false; delete payload.stream_options; }
  const req = upstreamReq('/v1/chat/completions', 'POST', payload, (up) => {
    if (up.statusCode >= 400) {
      let b = ''; up.on('data', (d) => (b += d)); up.on('end', () => sendErr(res, up.statusCode, 'upstream: ' + b.slice(0, 500)));
      return;
    }
    if (replay) {
      let b = ''; up.on('data', (d) => (b += d));
      up.on('end', () => {
        const m = toAnthropic(safeJson(b), model);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (event, data) => res.write(`event: ${event}
data: ${JSON.stringify({ type: event, ...data })}

`);
        send('message_start', { message: { ...m, content: [], stop_reason: null, usage: { input_tokens: m.usage.input_tokens, output_tokens: 0 } } });
        m.content.forEach((blk, i) => {
          if (blk.type === 'text') {
            send('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
            if (blk.text) send('content_block_delta', { index: i, delta: { type: 'text_delta', text: blk.text } });
          } else {
            send('content_block_start', { index: i, content_block: { type: 'tool_use', id: blk.id, name: blk.name, input: {} } });
            send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(blk.input) } });
          }
          send('content_block_stop', { index: i });
        });
        send('message_delta', { delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: m.usage.output_tokens } });
        send('message_stop', {});
        res.end();
      });
      return;
    }
    if (!payload.stream) {
      let b = ''; up.on('data', (d) => (b += d));
      up.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(toAnthropic(safeJson(b), model)));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('message_start', { message: { id: msgId(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    let index = -1, open = null /* 'text' | 'tool' */, finish = null, usage = {};
    const toolIdx = new Map(); // openai tool index -> anthropic block index
    const closeBlock = () => { if (open) { send('content_block_stop', { index }); open = null; } };
    let buf = '';
    const handle = (line) => {
      if (!line.startsWith('data:')) return;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') return;
      const j = safeJson(d);
      if (j.usage) usage = j.usage;
      const c = (j.choices || [])[0];
      if (!c) return;
      const delta = c.delta || {};
      if (delta.content) {
        if (open !== 'text') { closeBlock(); index++; open = 'text'; send('content_block_start', { index, content_block: { type: 'text', text: '' } }); }
        send('content_block_delta', { index, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const tc of delta.tool_calls || []) {
        const k = tc.index ?? 0;
        if (!toolIdx.has(k)) {
          closeBlock(); index++; open = 'tool'; toolIdx.set(k, index);
          send('content_block_start', { index, content_block: { type: 'tool_use', id: tc.id || 'toolu_' + index, name: tc.function?.name || '', input: {} } });
        }
        const args = tc.function?.arguments;
        if (args) send('content_block_delta', { index: toolIdx.get(k), delta: { type: 'input_json_delta', partial_json: args } });
      }
      if (c.finish_reason) finish = c.finish_reason;
    };
    up.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    });
    up.on('end', () => {
      if (buf.trim()) handle(buf.trim());
      closeBlock();
      send('message_delta', { delta: { stop_reason: stopReason(finish), stop_sequence: null }, usage: { output_tokens: usage.completion_tokens || 0 } });
      send('message_stop', {});
      res.end();
    });
    up.on('error', () => res.end());
  });
  req.on('error', (e) => sendErr(res, 502, 'upstream unreachable: ' + e.message));
  res.on('close', () => req.destroy());
  req.end(JSON.stringify(payload));
}

http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (req.method === 'GET' && (path === '/health' || path === '/')) { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET' && path === '/v1/models') {
    const u = upstreamReq('/v1/models', 'GET', null, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    u.on('error', (e) => sendErr(res, 502, e.message)); return u.end();
  }
  if (req.method !== 'POST' || !path.startsWith('/v1/messages')) return sendErr(res, 404, 'not found');
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = safeJson(raw);
    if (path === '/v1/messages/count_tokens') {
      const n = Math.ceil(JSON.stringify([body.system, body.messages, body.tools]).length / 4);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: n }));
    }
    try { handleMessages(body, res); } catch (e) { log('error', e); sendErr(res, 500, String(e)); }
  });
}).listen(PORT, HOST, () => log(`anthropic proxy on http://${HOST}:${PORT} -> ${UPSTREAM.origin}`));
