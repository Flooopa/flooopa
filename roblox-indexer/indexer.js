const fs = require('fs').promises;
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { OllamaClient } = require('./ollama.js');

class RobloxIndexer {
  constructor(config) {
    this.config = config;
    this.ollama = new OllamaClient(config.ollama);
    this.mcpClient = null;
    this.transport = null;
    this.index = {
      gameName: config.gameName,
      indexedAt: null,
      scripts: [],
      hierarchy: null,
      stats: { total: 0, byCategory: {} },
    };
  }

  async connectMCP() {
    const mcpConfig = this.config.mcp;
    console.log('[Indexer] Connecting to MCP server...');

    if (mcpConfig.transport === 'stdio') {
      this.transport = new StdioClientTransport({
        command: mcpConfig.command,
        args: mcpConfig.args,
        env: { ...process.env, ...mcpConfig.env },
      });
    } else {
      throw new Error(`Unsupported MCP transport: ${mcpConfig.transport}`);
    }

    this.mcpClient = new Client({ name: 'roblox-indexer', version: '1.0.0' });
    await this.mcpClient.connect(this.transport);

    // List available tools
    const tools = await this.mcpClient.listTools();
    console.log(`[Indexer] MCP connected. Available tools: ${tools.tools.map((t) => t.name).join(', ')}`);

    return this.mcpClient;
  }

  async disconnectMCP() {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
      this.mcpClient = null;
    }
  }

  async fetchHierarchy() {
    console.log('[Indexer] Fetching game hierarchy...');
    const result = await this.mcpClient.callTool({
      name: 'search_game_tree',
      arguments: { path: 'Workspace', max_depth: 6, head_limit: 1000 },
    });
    const hierarchy = JSON.parse(result.content[0].text);
    this.index.hierarchy = hierarchy;
    console.log(`[Indexer] Found ${hierarchy.length} top-level instances`);
    return hierarchy;
  }

  async findScripts() {
    console.log('[Indexer] Finding all scripts...');
    const result = await this.mcpClient.callTool({
      name: 'search_game_tree',
      arguments: { instance_type: 'BaseScript', max_depth: 10, head_limit: 1000 },
    });
    const scripts = JSON.parse(result.content[0].text);
    console.log(`[Indexer] Found ${scripts.length} scripts`);
    return scripts;
  }

  async readScript(scriptPath) {
    try {
      const result = await this.mcpClient.callTool({
        name: 'script_read',
        arguments: { target_file: scriptPath },
      });
      return result.content[0].text;
    } catch (err) {
      console.warn(`[Indexer] Failed to read ${scriptPath}:`, err.message);
      return null;
    }
  }

  async indexScripts(scripts) {
    const indexed = [];
    const byCategory = {};

    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      console.log(`[Indexer] [${i + 1}/${scripts.length}] Processing ${script.fullPath}...`);

      const content = await this.readScript(script.fullPath);
      if (!content) continue;

      // Truncate if too long
      const truncated = content.length > this.config.index.maxScriptLength
        ? content.slice(0, this.config.index.maxScriptLength) + '\n-- [truncated]'
        : content;

      // Summarize with Ollama
      let summary = { summary: 'Failed to summarize', category: 'unknown', raw: '' };
      try {
        summary = await this.ollama.summarizeScript(script.name, truncated);
      } catch (err) {
        console.warn(`[Indexer] Ollama failed for ${script.name}:`, err.message);
      }

      const entry = {
        path: script.fullPath,
        name: script.name,
        className: script.className,
        summary: summary.summary,
        category: summary.category,
        length: content.length,
        content: truncated,
        indexedAt: new Date().toISOString(),
      };

      indexed.push(entry);

      // Track categories
      byCategory[summary.category] = (byCategory[summary.category] || 0) + 1;

      // Small delay to avoid overwhelming Ollama
      if (i < scripts.length - 1) await sleep(200);
    }

    this.index.scripts = indexed;
    this.index.stats = {
      total: indexed.length,
      byCategory,
    };
    this.index.indexedAt = new Date().toISOString();

    return indexed;
  }

  async saveIndex() {
    const outputDir = this.config.index.outputDir;
    await fs.mkdir(outputDir, { recursive: true });

    const filename = `${this.config.gameName}-${Date.now()}.json`;
    const filepath = path.join(outputDir, filename);
    const latestPath = path.join(outputDir, `${this.config.gameName}-latest.json`);

    await fs.writeFile(filepath, JSON.stringify(this.index, null, 2));
    await fs.writeFile(latestPath, JSON.stringify(this.index, null, 2));

    console.log(`[Indexer] Index saved to ${filepath}`);
    console.log(`[Indexer] Latest copy at ${latestPath}`);

    return { filepath, latestPath };
  }

  async loadLatestIndex() {
    const latestPath = path.join(this.config.index.outputDir, `${this.config.gameName}-latest.json`);
    try {
      const raw = await fs.readFile(latestPath, 'utf8');
      this.index = JSON.parse(raw);
      console.log(`[Indexer] Loaded existing index: ${this.index.scripts.length} scripts`);
      return true;
    } catch {
      console.log('[Indexer] No existing index found');
      return false;
    }
  }

  async syncToRailway() {
    if (!this.config.railway.autoSync || !this.config.railway.backendUrl) {
      console.log('[Indexer] Railway sync disabled');
      return;
    }

    const url = `${this.config.railway.backendUrl}/api/roblox-index`;
    console.log(`[Indexer] Syncing index to Railway: ${url}`);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.railway.apiKey ? { 'x-api-key': this.config.railway.apiKey } : {}),
        },
        body: JSON.stringify(this.index),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const result = await res.json();
      console.log('[Indexer] Railway sync complete:', result.message);
      return result;
    } catch (err) {
      console.error('[Indexer] Railway sync failed:', err.message);
      throw err;
    }
  }

  async runFullIndex() {
    console.log('\n========== ROBLOX INDEXER ==========');
    console.log(`Game: ${this.config.gameName}`);
    console.log(`Ollama model: ${this.config.ollama.model}`);

    // Check Ollama
    const ollamaReady = await this.ollama.isAvailable();
    if (!ollamaReady) {
      console.error('[Indexer] Ollama model not available. Run: ollama pull qwen2.5-coder:7b');
      throw new Error('Ollama not ready');
    }
    console.log('[Indexer] Ollama ready');

    // Connect MCP
    await this.connectMCP();

    try {
      // Fetch hierarchy and scripts
      await this.fetchHierarchy();
      const scripts = await this.findScripts();

      if (scripts.length === 0) {
        console.log('[Indexer] No scripts found');
        return this.index;
      }

      // Index all scripts
      await this.indexScripts(scripts);

      // Save locally
      await this.saveIndex();

      // Sync to Railway
      await this.syncToRailway().catch((err) => {
        console.warn('[Indexer] Sync failed (backend may not have the endpoint yet):', err.message);
      });

      console.log('\n========== INDEX COMPLETE ==========');
      console.log(`Scripts indexed: ${this.index.stats.total}`);
      console.log('By category:', this.index.stats.byCategory);

      return this.index;
    } finally {
      await this.disconnectMCP();
    }
  }

  search(query) {
    const q = query.toLowerCase();
    return this.index.scripts.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.summary.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      s.path.toLowerCase().includes(q)
    );
  }

  async findRelevant(task) {
    if (!this.ollama.isAvailable() || this.index.scripts.length === 0) {
      return this.index.scripts.slice(0, 10);
    }

    // Build prompt with all scripts
    const scriptsText = this.index.scripts
      .slice(0, 50)
      .map((s, i) => `${i + 1}. ${s.name} (${s.category}): ${s.summary}`)
      .join('\n');

    const prompt = `Given this coding task, rate how relevant each script is (0-10). Return ONLY a JSON array like [{"index":1,"score":8}].

Task: ${task}

Scripts:
${scriptsText}`;

    try {
      const response = await this.ollama.generate(prompt, 200);
      const match = response.match(/\[[\s\S]*\]/);
      const scores = match ? JSON.parse(match[0]) : [];
      const scoreMap = new Map(scores.map((s) => [s.index - 1, s.score]));

      return this.index.scripts
        .slice(0, 50)
        .map((s, i) => ({ ...s, score: scoreMap.get(i) || 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    } catch {
      return this.index.scripts.slice(0, 10);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { RobloxIndexer };
