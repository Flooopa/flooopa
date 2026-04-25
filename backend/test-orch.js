require('dotenv').config();
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3001');
let taskId = null;
let events = 0;

ws.on('open', async () => {
  console.log('WS connected');
  const res = await fetch('http://localhost:3001/api/orchestrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'say hello', mode: 'code' })
  });
  const data = await res.json();
  taskId = data.taskId;
  console.log('Task started:', taskId);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.data?.taskId === taskId) {
    events++;
    console.log('EVENT #' + events, msg.event, JSON.stringify(msg.data).slice(0, 120));
  }
  if (msg.event === 'final_output' && msg.data?.taskId === taskId) {
    console.log('=== DONE ===');
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => console.log('WS ERROR', e.message));

setTimeout(() => {
  console.log('Timeout, events received:', events);
  ws.close();
  process.exit(1);
}, 60000);
