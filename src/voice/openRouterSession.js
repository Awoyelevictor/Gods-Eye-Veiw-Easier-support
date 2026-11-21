const API = '/api/voice';

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read microphone audio'));
    reader.readAsDataURL(blob);
  });
}

function abortError() {
  return new DOMException('Voice session stopped', 'AbortError');
}

/**
 * Mobile-friendly turn-based voice adapter. It keeps the existing GEV action
 * runner and session lifecycle, while replacing OpenAI WebRTC with OpenRouter
 * STT -> chat/tool calls -> TTS requests through same-origin Vercel functions.
 */
export function createOpenRouterVoiceSession({ emit, runAction, signal: lifetime } = {}) {
  let stream = null;
  let audioContext = null;
  let analyser = null;
  let source = null;
  let raf = 0;
  let recorder = null;
  let chunks = [];
  let recording = false;
  let speaking = false;
  let stopped = true;
  let lastVoiceAt = 0;
  let speechStartedAt = 0;
  let activeRequest = null;
  let audioElement = null;
  let audioUrl = null;
  let turnQueue = Promise.resolve();
  let history = [];
  let pendingMapEvents = [];
  const TIMEOUT_SILENCE_MS = 850;
  const SPEECH_THRESHOLD = 0.035;
  const MIN_UTTERANCE_MS = 320;

  const setState = (state, detail) => emit?.({ type: 'state', state, detail });
  const requestSignal = () => {
    activeRequest?.abort();
    activeRequest = new AbortController();
    return AbortSignal.any([activeRequest.signal, lifetime].filter(Boolean));
  };

  async function post(action, payload, signal) {
    const response = await fetch(`${API}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal,
      body: JSON.stringify(payload),
    });
    const data = action === 'speak' && response.ok ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `Voice request failed (HTTP ${response.status})`);
    return action === 'speak' ? response.blob() : data;
  }

  function recorderMime() {
    if (!globalThis.MediaRecorder) return '';
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
  }

  function startRecording() {
    if (stopped || recording || speaking || !stream) return;
    const mimeType = recorderMime();
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      setState('error', error.message || 'This browser cannot record microphone audio');
      return;
    }
    chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      chunks = [];
      recording = false;
      if (stopped || blob.size < 1200) return;
      const elapsed = Date.now() - speechStartedAt;
      if (elapsed < MIN_UTTERANCE_MS) return;
      turnQueue = turnQueue.then(() => processAudio(blob)).catch((error) => {
        if (error?.name !== 'AbortError' && !stopped) {
          console.warn('[GEV voice]', error);
          setState('error', error.message || 'Voice turn failed');
        }
      });
    }, { once: true });
    recorder.start(250);
    recording = true;
    speechStartedAt = Date.now();
    setState('listening', 'Listening…');
  }

  function stopRecording() {
    if (!recording || !recorder || recorder.state === 'inactive') return;
    try { recorder.stop(); } catch { recording = false; }
  }

  function detectSpeech() {
    if (stopped || !analyser) return;
    const samples = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    if (!speaking && rms > SPEECH_THRESHOLD) {
      lastVoiceAt = now;
      if (!recording) startRecording();
    } else if (recording && rms > SPEECH_THRESHOLD * 0.72) {
      lastVoiceAt = now;
    } else if (recording && now - lastVoiceAt > TIMEOUT_SILENCE_MS) {
      stopRecording();
    }
    raf = requestAnimationFrame(detectSpeech);
  }

  async function playSpeech(text, signal) {
    const blob = await post('speak', { text }, signal);
    if (stopped || signal.aborted) throw abortError();
    audioUrl = URL.createObjectURL(blob);
    audioElement = new Audio(audioUrl);
    audioElement.preload = 'auto';
    speaking = true;
    setState('executing', 'Speaking…');
    try {
      await audioElement.play();
      await new Promise((resolve, reject) => {
        audioElement.addEventListener('ended', resolve, { once: true });
        audioElement.addEventListener('error', () => reject(new Error('Audio playback failed')), { once: true });
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    } finally {
      speaking = false;
      audioElement?.pause();
      audioElement = null;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = null;
      if (!stopped) setState('listening', 'Listening…');
    }
  }

  async function processTranscript(transcript, signal) {
    const clean = String(transcript || '').trim();
    if (!clean || stopped || signal.aborted) return;
    emit?.({ type: 'transcript', role: 'user', text: clean });
    const mapContext = pendingMapEvents.splice(0).map((event) => JSON.stringify(event)).join('\n');
    history.push({ role: 'user', content: mapContext ? `${clean}\n\nRecent map changes:\n${mapContext}` : clean });
    setState('executing', 'Thinking…');
    for (let round = 0; round < 7; round++) {
      const result = await post('chat', { messages: history }, signal);
      if (stopped || signal.aborted) throw abortError();
      const message = result.message || {};
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        history.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
          if (call.type !== 'function' || !call.function?.name) continue;
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
          emit?.({ type: 'action-call', name: call.function.name, arguments: args });
          let output;
          try {
            output = await runAction(call.function.name, args, { signal });
          } catch (error) {
            output = { ok: false, error: error?.message || 'Action failed' };
          }
          emit?.({ type: 'action-result', name: call.function.name, result: output });
          history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output ?? { ok: true }) });
          if (stopped || signal.aborted) throw abortError();
        }
        continue;
      }
      const answer = String(message.content || '').trim();
      if (answer) {
        history.push({ role: 'assistant', content: answer });
        emit?.({ type: 'transcript', role: 'assistant', text: answer });
        history = history.slice(-24);
        await playSpeech(answer, signal);
      }
      return;
    }
    throw new Error('Voice reached its tool-call limit for one request');
  }

  async function processAudio(blob) {
    if (stopped || speaking) return;
    const signal = requestSignal();
    setState('executing', 'Transcribing…');
    const format = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('wav') ? 'wav' : 'webm';
    const audio = await toBase64(blob);
    const result = await post('transcribe', { audio, format }, signal);
    await processTranscript(result.text, signal);
    if (!stopped) setState('listening', 'Listening…');
  }

  async function sendText(text) {
    if (stopped || !String(text || '').trim()) return;
    const signal = requestSignal();
    turnQueue = turnQueue.then(() => processTranscript(text, signal)).catch((error) => {
      if (error?.name !== 'AbortError' && !stopped) setState('error', error.message);
    });
    return turnQueue;
  }

  async function start() {
    if (!stopped) return;
    stopped = false;
    setState('connecting', 'Requesting microphone permission…');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
        throw new Error('Microphone recording is not supported by this browser');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (stopped || lifetime?.aborted) throw abortError();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContextClass();
      await audioContext.resume();
      source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      setState('listening', 'Listening…');
      raf = requestAnimationFrame(detectSpeech);
    } catch (error) {
      stop();
      if (error?.name !== 'AbortError') setState('error', error.message || 'Could not start microphone');
      throw error;
    }
  }

  function stop() {
    stopped = true;
    activeRequest?.abort();
    activeRequest = null;
    cancelAnimationFrame(raf);
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    }
    recording = false;
    speaking = false;
    audioElement?.pause();
    audioElement = null;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    source?.disconnect();
    source = null;
    analyser = null;
    audioContext?.close().catch(() => {});
    audioContext = null;
  }

  const onAbort = () => stop();
  lifetime?.addEventListener('abort', onAbort, { once: true });
  return {
    capabilities: { costControls: false, pushToTalk: false },
    start,
    stop,
    sendText,
    sendMapEvent(event) {
      if (event && typeof event === 'object') pendingMapEvents.push(event);
      if (pendingMapEvents.length > 12) pendingMapEvents.shift();
    },
    bindControls() {},
  };
}
