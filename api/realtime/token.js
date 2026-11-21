import { createRealtimeTokenHandler } from '../../server/providers/openai/realtime.js';

// Vercel Node.js Function for the browser's short-lived Realtime credential.
// The permanent OPENAI_API_KEY remains server-side and is never sent to clients.
const handleRealtimeToken = createRealtimeTokenHandler();

export default function realtimeToken(req, res) {
  return handleRealtimeToken(req, res);
}
