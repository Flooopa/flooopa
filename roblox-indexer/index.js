const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { RobloxIndexer } = require('./indexer.js');

// Load config
let config;
try {
  const raw = require('fs').readFileSync('./config.json', 'utf8');
  config = JSON.parse(raw);
} catch {
  console.error('config.json not found. Copy config.json.example and fill in your details.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const indexer = new RobloxIndexer(config);

// ─── Health ───
app.get('/health', (req, res) => {
  res.json({ status: 'ok', game: config.gameName, scriptsIndexed: indexer.index.scripts.length });
});

// ─── GET /index ───
// Returns the full current index (scripts + hierarchy + stats)
app.get('/index', async (req, res) => {
  await indexer.loadLatestIndex();
  res.json(indexer.index);
});

// ─── GET /search?q=query ───
// Searches scripts by name, summary, category, or path
app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter required' });

  await indexer.loadLatestIndex();
  const results = indexer.search(q);
  res.json({ query: q, count: results.length, results });
});

// ─── GET /relevant?task=description ───
// Uses Ollama to rank scripts by relevance to a task
app.get('/relevant', async (req, res) => {
  const { task } = req.query;
  if (!task) return res.status(400).json({ error: 'task parameter required' });

  await indexer.loadLatestIndex();
  if (indexer.index.scripts.length === 0) {
    return res.status(404).json({ error: 'No index available. Run /rescan first.' });
  }

  try {
    const results = await indexer.findRelevant(task);
    res.json({ task, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /rescan ───
// Triggers a full re-index of the Roblox game
app.post('/rescan', async (req, res) => {
  res.json({ message: 'Rescan started', game: config.gameName });

  // Run scan in background
  try {
    await indexer.runFullIndex();
  } catch (err) {
    console.error('[Server] Rescan failed:', err.message);
  }
});

// ─── POST /sync ───
// Manually sync current index to Railway
app.post('/sync', async (req, res) => {
  await indexer.loadLatestIndex();
  if (indexer.index.scripts.length === 0) {
    return res.status(404).json({ error: 'No index to sync' });
  }

  try {
    const result = await indexer.syncToRailway();
    res.json({ message: 'Sync complete', result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── POST /import ───
// Import an index manually (for testing without MCP)
app.post('/import', async (req, res) => {
  const { scripts, hierarchy } = req.body;
  if (!scripts) return res.status(400).json({ error: 'scripts array required' });

  indexer.index = {
    gameName: config.gameName,
    indexedAt: new Date().toISOString(),
    scripts,
    hierarchy: hierarchy || null,
    stats: {
      total: scripts.length,
      byCategory: scripts.reduce((acc, s) => {
        acc[s.category] = (acc[s.category] || 0) + 1;
        return acc;
      }, {}),
    },
  };

  await indexer.saveIndex();
  res.json({ message: 'Index imported', scripts: scripts.length });
});

// ─── Startup ───
const PORT = config.server?.port || 3002;

app.listen(PORT, async () => {
  console.log(`Roblox Indexer running on port ${PORT}`);
  console.log(`Game: ${config.gameName}`);
  console.log(`Endpoints:`);
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  GET  http://localhost:${PORT}/index`);
  console.log(`  GET  http://localhost:${PORT}/search?q=...`);
  console.log(`  GET  http://localhost:${PORT}/relevant?task=...`);
  console.log(`  POST http://localhost:${PORT}/rescan`);
  console.log(`  POST http://localhost:${PORT}/sync`);

  // Load existing index if available
  await indexer.loadLatestIndex();

  // If --once flag, run immediately and exit
  if (process.argv.includes('--once')) {
    try {
      await indexer.runFullIndex();
    } catch (err) {
      console.error('One-shot indexing failed:', err.message);
      process.exit(1);
    }
    process.exit(0);
  }

  // If --watch flag, rescan periodically
  if (process.argv.includes('--watch')) {
    const interval = 5 * 60 * 1000; // 5 minutes
    console.log(`[Watch] Auto-rescan every ${interval / 1000}s`);
    setInterval(() => {
      console.log('[Watch] Triggering auto-rescan...');
      indexer.runFullIndex().catch((err) => console.error('[Watch] Auto-rescan failed:', err.message));
    }, interval);
  }
});
