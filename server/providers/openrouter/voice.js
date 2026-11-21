import { realtimeInstructions } from '../openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../openai/tools.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const MAX_AUDIO_BASE64 = 14 * 1024 * 1024;
const CHAT_MODEL_DEFAULT = 'openai/gpt-4.1-mini';
const STT_MODEL_DEFAULT = 'openai/whisper-1';
const TTS_MODEL_DEFAULT = 'openai/gpt-4o-mini-tts';

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

function chatTools() {
  return GEV_REALTIME_TOOLS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));
}

async function upstream(path, apiKey, body, signal) {
  const response = await fetch(`${OPENROUTER_BASE}${path}`, {
    method: 'POST',
    redirect: 'error',
    signal: signal || AbortSignal.timeout(55_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://gods-eye-view.vercel.app',
      'X-Title': "God's Eye View",
    },
    body: JSON.stringify(body),
  });
  return response;
}

export async function handleOpenRouterVoice(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return json(res, 503, { error: 'OPENROUTER_API_KEY is not configured' });

  const action = String(req.query?.action || '').toLowerCase();
  const body = readBody(req);
  try {
    if (action === 'transcribe') {
      const audio = typeof body.audio === 'string' ? body.audio : '';
      const format = ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac'].includes(body.format) ? body.format : 'webm';
      if (!audio || audio.length > MAX_AUDIO_BASE64) return json(res, 413, { error: 'Audio is missing or exceeds the 10 MB limit' });
      const response = await upstream('/audio/transcriptions', apiKey, {
        model: process.env.OPENROUTER_STT_MODEL || STT_MODEL_DEFAULT,
        input_audio: { data: audio, format },
        ...(body.language ? { language: String(body.language).slice(0, 12) } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: payload.error?.message || payload.error || 'Speech transcription failed' });
      return json(res, 200, { text: payload.text || '' });
    }

    if (action === 'chat') {
      const messages = Array.isArray(body.messages) ? body.messages.slice(-24) : [];
      if (!messages.length) return json(res, 400, { error: 'Conversation messages are required' });
      const safeMessages = messages.filter((m) => m && ['user', 'assistant', 'tool'].includes(m.role)).map((m) => {
        if (m.role === 'tool') return { role: 'tool', tool_call_id: String(m.tool_call_id || '').slice(0, 160), content: String(m.content ?? '').slice(0, 12000) };
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
        return { role: m.role, content: String(m.content ?? '').slice(0, 12000) };
      });
      const response = await upstream('/chat/completions', apiKey, {
        model: process.env.OPENROUTER_CHAT_MODEL || CHAT_MODEL_DEFAULT,
        messages: [{ role: 'system', content: realtimeInstructions() }, ...safeMessages],
        tools: chatTools(),
        tool_choice: 'auto',
        parallel_tool_calls: false,
        max_tokens: 900,
        temperature: 0.35,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: payload.error?.message || payload.error || 'AI response failed' });
      return json(res, 200, { message: payload.choices?.[0]?.message || { role: 'assistant', content: 'I could not form a response.' } });
    }

    if (action === 'speak') {
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
      if (!text) return json(res, 400, { error: 'Speech text is required' });
      const response = await upstream('/audio/speech', apiKey, {
        model: process.env.OPENROUTER_TTS_MODEL || TTS_MODEL_DEFAULT,
        input: text,
        voice: process.env.OPENROUTER_TTS_VOICE || 'alloy',
        response_format: 'mp3',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        return json(res, response.status, { error: payload.error?.message || payload.error || 'Speech generation failed' });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
      const contentLength = response.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    return json(res, 404, { error: 'Unknown voice action' });
  } catch (error) {
    if (error?.name === 'AbortError') return json(res, 499, { error: 'Voice request was cancelled' });
    console.error('[GEV OpenRouter voice]', error?.message || error);
    return json(res, 502, { error: error?.message || 'OpenRouter voice request failed' });
  }
}
