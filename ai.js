// Roar AI gateway — OpenAI-compatible.
// The key is read from the environment only; never hard-code it here.
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';

const apiKey = process.env.ROAR_API_KEY;
const baseURL = process.env.ROAR_BASE_URL || 'https://api.roar-ai.com/v1';

if (!apiKey) {
  throw new Error(
    'ROAR_API_KEY is not set. Add it to .env and run with `node --env-file=.env ...`, ' +
    'or set it as an environment variable in your host.'
  );
}

// Only relevant in a sandboxed/corporate network that forces an egress proxy.
// In normal hosting these are unset and the SDK connects directly.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;

export const roar = new OpenAI({
  apiKey,
  baseURL,
  ...(proxy ? { httpAgent: new HttpsProxyAgent(proxy) } : {})
});
export const MODELS = {
  // Cheap, in-country (Sri Lanka) — good default for background work
  local:    'qwen3.8-27b-lk',
  // Low-cost general purpose
  fast:     'claude-haiku-5-5',
  // Open-weight workhorse
  llama:    'llama-3.3-70b'
};
