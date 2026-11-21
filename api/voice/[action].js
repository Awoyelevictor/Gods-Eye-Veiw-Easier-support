import { handleOpenRouterVoice } from '../../server/providers/openrouter/voice.js';

export default function voice(req, res) {
  return handleOpenRouterVoice(req, res);
}
