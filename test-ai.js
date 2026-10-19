// Verifies the gateway wiring end to end.
//   node --env-file=.env test-ai.js
import { roar } from './ai.js';

const MODEL = 'llama-3.3-70b';

const res = await roar.chat.completions.create({
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are a concise assistant inside a marketing CRM.' },
    { role: 'user', content: 'In two sentences, say hello and confirm you are reachable through the Roar AI gateway.' }
  ],
  max_tokens: 120
});

console.log('model:   ', res.model || MODEL);
console.log('reply:   ', res.choices?.[0]?.message?.content?.trim());
console.log('tokens:  ', JSON.stringify(res.usage));
