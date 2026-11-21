import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createOpenRouterVoiceSession } from './openRouterSession.js';

/** Default voice composition always uses the OpenRouter STT/chat/TTS pipeline. */
export function createVoiceCommands(options = {}) {
  return bindVoiceCommands({
    ...options,
    // Keep this last: callers may supply other voice options, but must not
    // silently replace the configured OpenRouter adapter with legacy Realtime.
    createSession: createOpenRouterVoiceSession,
  });
}
