const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

const KNOWLEDGE_BASE_FILE = path.join(__dirname, 'memory', 'knowledge-base.json');

module.exports = function createContextRoutes({ localAgent, memoryManager, robloxIndex }) {
  const router = express.Router();

  // ─── GET /api/context ───
  // Returns everything: knowledge base, roblox index, project memory, global memory, todos, file changes
  router.get('/', async (req, res) => {
    try {
      const [projectMemory, globalMemory] = await Promise.all([
        memoryManager.getProjectMemory(process.env.PROJECT_NAME || 'default'),
        memoryManager.getGlobalMemory(),
      ]);

      res.json({
        knowledgeBase: Object.fromEntries(localAgent.knowledgeBase),
        fileChanges: localAgent.fileChanges.slice(-20),
        robloxIndex: {
          gameName: robloxIndex.gameName,
          indexedAt: robloxIndex.indexedAt,
          stats: robloxIndex.stats,
          scripts: robloxIndex.scripts.slice(0, 50),
        },
        projectMemory,
        globalMemory,
        todos: localAgent.todoStore?.todos?.slice(-50) || [],
        localAgentStatus: localAgent.getStatus(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/context/status ───
  // Live indicators: Ollama, MCP, Railway last update
  router.get('/status', async (req, res) => {
    let ollamaStatus = 'disconnected';
    try {
      const ollamaRes = await fetch('http://localhost:11434/api/tags', { timeout: 3000 });
      if (ollamaRes.ok) {
        const data = await ollamaRes.json();
        const models = data.models?.map((m) => m.name) || [];
        ollamaStatus = models.length > 0 ? `running (${models.length} models)` : 'running (no models)';
      }
    } catch {
      ollamaStatus = 'disconnected';
    }

    res.json({
      ollama: ollamaStatus,
      localAgent: localAgent.available ? 'connected' : 'disconnected',
      model: localAgent.model,
      watchedFiles: localAgent.knowledgeBase.size,
      robloxIndex: {
        gameName: robloxIndex.gameName,
        scriptCount: robloxIndex.scripts.length,
        indexedAt: robloxIndex.indexedAt,
      },
      railway: robloxIndex.indexedAt ? `last sync ${robloxIndex.indexedAt}` : 'never synced',
      uptime: process.uptime(),
    });
  });

  // ─── File Summary CRUD ───

  // Update file summary
  router.put('/file-summary', async (req, res) => {
    const { file, summary } = req.body;
    if (!file || typeof summary !== 'string') {
      return res.status(400).json({ error: 'file and summary required' });
    }
    localAgent.knowledgeBase.set(file, summary);
    await localAgent.saveKnowledgeBase();
    res.json({ success: true, file, summary });
  });

  // Delete file summary
  router.delete('/file-summary', async (req, res) => {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'file required' });
    const existed = localAgent.knowledgeBase.has(file);
    localAgent.knowledgeBase.delete(file);
    await localAgent.saveKnowledgeBase();
    res.json({ success: true, file, deleted: existed });
  });

  // Add file summary
  router.post('/file-summary', async (req, res) => {
    const { file, summary } = req.body;
    if (!file || typeof summary !== 'string') {
      return res.status(400).json({ error: 'file and summary required' });
    }
    localAgent.knowledgeBase.set(file, summary);
    await localAgent.saveKnowledgeBase();
    res.json({ success: true, file, summary });
  });

  // ─── Project Memory CRUD ───

  // Update project memory field
  router.put('/project-memory', async (req, res) => {
    const { field, value } = req.body;
    if (!field) return res.status(400).json({ error: 'field required' });

    const projectName = process.env.PROJECT_NAME || 'default';
    const mem = await memoryManager.getProjectMemory(projectName);
    mem[field] = value;
    await memoryManager.setProjectMemory(projectName, mem);
    res.json({ success: true, field, value });
  });

  // Add decision
  router.post('/decisions', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const projectName = process.env.PROJECT_NAME || 'default';
    await memoryManager.addProjectDecision(projectName, text);
    res.json({ success: true, text });
  });

  // Delete decision by index
  router.delete('/decisions/:index', async (req, res) => {
    const idx = parseInt(req.params.index, 10);
    const projectName = process.env.PROJECT_NAME || 'default';
    const mem = await memoryManager.getProjectMemory(projectName);
    if (idx < 0 || idx >= (mem.decisions?.length || 0)) {
      return res.status(404).json({ error: 'Decision not found' });
    }
    mem.decisions.splice(idx, 1);
    await memoryManager.setProjectMemory(projectName, mem);
    res.json({ success: true, deletedIndex: idx });
  });

  // Add bug
  router.post('/bugs', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const projectName = process.env.PROJECT_NAME || 'default';
    await memoryManager.addProjectBug(projectName, text);
    res.json({ success: true, text });
  });

  // Delete bug by index
  router.delete('/bugs/:index', async (req, res) => {
    const idx = parseInt(req.params.index, 10);
    const projectName = process.env.PROJECT_NAME || 'default';
    const mem = await memoryManager.getProjectMemory(projectName);
    if (idx < 0 || idx >= (mem.knownBugs?.length || 0)) {
      return res.status(404).json({ error: 'Bug not found' });
    }
    mem.knownBugs.splice(idx, 1);
    await memoryManager.setProjectMemory(projectName, mem);
    res.json({ success: true, deletedIndex: idx });
  });

  // ─── Todo CRUD ───

  // Update todo
  router.put('/todos/:id', async (req, res) => {
    const todo = await localAgent.todoStore?.update(req.params.id, req.body);
    if (!todo) return res.status(404).json({ error: 'Not found' });
    res.json(todo);
  });

  // Delete todo
  router.delete('/todos/:id', async (req, res) => {
    const ok = await localAgent.todoStore?.delete(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  });

  // ─── Actions ───

  // Trigger rescan (proxies to local indexer if configured)
  router.post('/rescan', async (req, res) => {
    const indexerUrl = process.env.INDEXER_URL || 'http://localhost:3002';
    try {
      const result = await fetch(`${indexerUrl}/rescan`, { method: 'POST' });
      if (!result.ok) throw new Error(`Indexer HTTP ${result.status}`);
      res.json({ message: 'Rescan triggered', indexerUrl });
    } catch (err) {
      res.status(502).json({ error: `Failed to reach indexer at ${indexerUrl}: ${err.message}` });
    }
  });

  // Sync to Railway (re-post current roblox index)
  router.post('/sync', async (req, res) => {
    if (robloxIndex.scripts.length === 0) {
      return res.status(404).json({ error: 'No Roblox index to sync' });
    }
    // The index is already on Railway (we're the Railway backend).
    // Just broadcast that it's synced.
    broadcast('roblox_index_synced', {
      gameName: robloxIndex.gameName,
      scriptCount: robloxIndex.scripts.length,
      syncedAt: new Date().toISOString(),
    });
    res.json({ message: 'Index synced', scripts: robloxIndex.scripts.length });
  });

  // Force reload knowledge base from disk
  router.post('/reload-kb', async (req, res) => {
    await localAgent.loadKnowledgeBase();
    res.json({ message: 'Knowledge base reloaded', count: localAgent.knowledgeBase.size });
  });

  return router;
};
