require('dotenv').config();
const fetch = require('node-fetch');

fetch('https://api.kimi.com/coding/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + process.env.KIMI_CODE_API_KEY,
    'User-Agent': 'KimiCLI/1.5',
  },
  body: JSON.stringify({
    model: 'kimi-for-coding',
    messages: [{ role: 'user', content: 'say hi' }],
    stream: true,
    max_tokens: 20,
  }),
}).then((r) => {
  console.log('status', r.status);
  const reader = r.body;
  let count = 0;
  reader.on('data', (c) => {
    count++;
    console.log('chunk #' + count, c.toString().slice(0, 80));
  });
  reader.on('end', () => console.log('end, total chunks:', count));
  reader.on('error', (e) => console.log('err', e.message));
});
