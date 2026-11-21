import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createOpenRouterVoiceSession } from './openRouterSession.js';

/** Default voice composition uses the OpenRouter STT/chat/TTS pipeline. */
export function createVoiceCommands(options) {
  return bindVoiceCommands({
    createSession: createOpenRouterVoiceSession,
    ...options,
  });
}
