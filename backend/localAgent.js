const chokidar = require('chokidar');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const path = require('path');

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_TAGS = 'http://localhost:11434/api/tags';
const DEFAULT_MODEL = 'qwen2.5:3b';
const FALLBACK_MODEL = 'llama3.1:8b';
const ACCEPTED_MODELS = ['qwen2.5:3b', 'llama3.2:3b', 'llama3.1:8b', 'mistral-nemo:12b'];

class LocalAgent {
  constructor(projectPath, memoryManager, broadcastFn, todoStore, feedStore) {
    this.projectPath = projectPath || process.cwd();
    this.memory = memoryManager;
    this.broadcast = broadcastFn || (() => {});
    this.todoStore = todoStore;
    this.feedStore = feedStore;
    this.knowledgeBase = new Map();
    this.fileChanges = [];
    this.progress = 0;
    this.available = false;
    this.model = DEFAULT_MODEL;
    this.watcher = null;
  }

  async start() {
    this.available = await this.checkOllama();
    if (!this.available) {
      console.log('[LocalAgent] Ollama not available — local AI features disabled');
      this.broadcast('local_agent_status', { available: false, message: 'Ollama not running' });
      return;
    }

    console.log(`[LocalAgent] Using model: ${this.model}`);
    this.broadcast('local_agent_status', { available: true, model: this.model, message: 'Watching project files' });

    this.watcher = chokidar.watch(this.projectPath, {
      ignored: /(^|[\/\\])\..|node_modules|\.git|memory/,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });

    this.watcher.on('change', (fp) => this.onFileChange(fp));
    this.watcher.on('add', (fp) => this.onFileChange(fp));

    // Periodic compression every 24hrs
    setInterval(() => this.compressOldSessions(), 24 * 60 * 60 * 1000);

    // Progress update heartbeat
    setInterval(() => this.updateProgress(), 30 * 1000);
  }

  async checkOllama() {
    try {
      const res = await fetch(OLLAMA_TAGS, { timeout: 3000 });
      if (!res.ok) return false;
      const data = await res.json();
      const models = data.models?.map((m) => m.name) || [];
      for (const candidate of ACCEPTED_MODELS) {
        if (models.includes(candidate)) {
          this.model = candidate;
          return true;
        }
      }
      console.log('[LocalAgent] Ollama running but no suitable model found. Available:', models.join(', '));
      console.log('[LocalAgent] Acceptable models:', ACCEPTED_MODELS.join(', '));
      return false;
    } catch {
      return false;
    }
  }

  async onFileChange(filePath) {
    const rel = path.relative(this.projectPath, filePath);
    const ext = path.extname(rel).toLowerCase();
    if (!ext || ext === '.tmp' || ext === '.lock') return;

    const content = await fs.readFile(filePath, 'utf8').catch(() => '');
    const time = Date.now();

    // Log change
    this.fileChanges.push({ file: rel, time });
    if (this.fileChanges.length > 100) this.fileChanges.shift();

    // Scan TODO/FIXME
    this.scanTodos(content, rel);

    // Summarize file (async, non-blocking)
    this.summarizeFile(rel, content).then((summary) => {
      if (summary) {
        this.knowledgeBase.set(rel, summary);
        this.broadcast('local_agent_update', {
          type: 'file_summary',
          file: rel,
          summary,
          todoCount: this.todoStore?.todos?.length || 0,
          progress: this.progress,
        });
      }
    });

    // Update progress immediately
    this.updateProgress();
  }

  async scanTodos(content, filePath) {
    const todoRe = /--\s*TODO[:\s]+(.+)/gi;
    const fixmeRe = /--\s*FIXME[:\s]+(.+)/gi;
    let m;

    while ((m = todoRe.exec(content)) !== null) {
      const text = m[1].trim();
      const existing = this.todoStore?.todos?.find((t) => t.text === text && t.file === filePath);
      if (!existing && this.todoStore) {
        const todo = await this.todoStore.create({
          type: 'TODO',
          text,
          file: filePath,
          source: 'auto',
          priority: 'medium',
        });
        if (this.feedStore) await this.feedStore.logTodoDetected(todo);
        this.broadcast('local_agent_update', { type: 'todo_found', todo });
      }
    }
    while ((m = fixmeRe.exec(content)) !== null) {
      const text = m[1].trim();
      const existing = this.todoStore?.todos?.find((t) => t.text === text && t.file === filePath);
      if (!existing && this.todoStore) {
        const todo = await this.todoStore.create({
          type: 'FIXME',
          text,
          file: filePath,
          source: 'auto',
          priority: 'high',
        });
        if (this.feedStore) await this.feedStore.logTodoDetected(todo);
        this.broadcast('local_agent_update', { type: 'todo_found', todo });
      }
    }
  }

  async summarizeFile(relPath, content) {
    const snippet = content.slice(0, 1500);
    const prompt = `In one sentence, describe what this code file does. Be specific.

File: ${relPath}
\`\`\`
${snippet}
\`\`\``;
    return this.ollamaGenerate(prompt, 60);
  }

  async ollamaGenerate(prompt, maxTokens) {
    try {
      const res = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: { num_predict: maxTokens, temperature: 0.3 },
        }),
      });
      if (!res.ok) return '';
      const data = await res.json();
      return (data.response || '').trim();
    } catch {
      return '';
    }
  }

  updateProgress() {
    const files = Array.from(this.knowledgeBase.keys());
    if (files.length === 0) {
      this.progress = 0;
      return;
    }
    const meaningful = files.filter((f) => {
      const s = this.knowledgeBase.get(f);
      return s && s.length > 10 && !s.includes('empty');
    });
    this.progress = Math.min(100, Math.round((meaningful.length / files.length) * 100));
  }

  async compressOldSessions() {
    console.log('[LocalAgent] Compressing old session memory...');
    const projects = await this.memory.listProjects();
    for (const proj of projects) {
      const session = this.memory.getSessionMemory(proj);
      if (session && session.length > 1000) {
        const prompt = `Compress these session notes into 2-3 bullet points of key decisions only:\n\n${session.slice(0, 2000)}`;
        const compressed = await this.ollamaGenerate(prompt, 120);
        this.memory.setSessionMemory(proj, compressed);
        this.broadcast('local_agent_update', { type: 'session_compressed', project: proj });
      }
    }
  }

  async logSessionDecision(taskId, projectName, decision) {
    if (!decision) return;
    await this.memory.addProjectDecision(projectName, decision);
    this.broadcast('local_agent_update', {
      type: 'decision_logged',
      project: projectName,
      decision: decision.slice(0, 200),
    });
  }

  getStatus() {
    const stats = this.todoStore ? this.todoStore.getStats() : { total: 0, open: 0, active: 0, resolved: 0 };
    return {
      available: this.available,
      model: this.model,
      watchedFiles: this.knowledgeBase.size,
      todoCount: stats.total,
      progress: this.progress,
      recentChanges: this.fileChanges.slice(-5),
      stats,
    };
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

module.exports = { LocalAgent };
