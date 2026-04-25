const fs = require('fs').promises;
const path = require('path');

const MEMORY_DIR = path.join(__dirname, 'memory');

class MemoryManager {
  constructor() {
    this.sessionMemory = new Map();
    this.ensureDir();
  }

  async ensureDir() {
    await fs.mkdir(MEMORY_DIR, { recursive: true });
  }

  /* ───── Global Memory ───── */
  async getGlobalMemory() {
    try {
      const raw = await fs.readFile(path.join(MEMORY_DIR, 'global.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      return {
        preferences: [],
        codingStyle: '',
        activeSystems: [],
        alwaysInject: '',
      };
    }
  }

  async setGlobalMemory(data) {
    await fs.writeFile(path.join(MEMORY_DIR, 'global.json'), JSON.stringify(data, null, 2));
  }

  async addGlobalPreference(text) {
    const mem = await this.getGlobalMemory();
    if (!mem.preferences.includes(text)) {
      mem.preferences.push(text);
      await this.setGlobalMemory(mem);
    }
  }

  /* ───── Project Memory ───── */
  async getProjectMemory(projectName) {
    const safeName = projectName.replace(/[^a-z0-9_-]/gi, '_');
    try {
      const raw = await fs.readFile(path.join(MEMORY_DIR, `project-${safeName}.json`), 'utf8');
      return JSON.parse(raw);
    } catch {
      return {
        name: projectName,
        decisions: [],
        architecture: [],
        knownBugs: [],
        stack: '',
        lastUpdated: null,
        // Roblox-specific
        gameName: '',
        serviceStructure: [],
        remoteNames: [],
        codingStylePrefs: [],
      };
    }
  }

  async setProjectMemory(projectName, data) {
    const safeName = projectName.replace(/[^a-z0-9_-]/gi, '_');
    data.lastUpdated = new Date().toISOString();
    await fs.writeFile(path.join(MEMORY_DIR, `project-${safeName}.json`), JSON.stringify(data, null, 2));
  }

  async addProjectDecision(projectName, decision) {
    const mem = await this.getProjectMemory(projectName);
    const exists = mem.decisions.some((d) => d.text === decision);
    if (!exists) {
      mem.decisions.push({ text: decision, created: new Date().toISOString() });
      await this.setProjectMemory(projectName, mem);
    }
  }

  async addProjectBug(projectName, bug) {
    const mem = await this.getProjectMemory(projectName);
    const exists = mem.knownBugs.some((b) => b.text === bug);
    if (!exists) {
      mem.knownBugs.push({ text: bug, created: new Date().toISOString() });
      await this.setProjectMemory(projectName, mem);
    }
  }

  /* ───── Session Memory ───── */
  getSessionMemory(taskId) {
    return this.sessionMemory.get(taskId) || '';
  }

  setSessionMemory(taskId, summary) {
    this.sessionMemory.set(taskId, summary);
  }

  compressSession(taskId, fullLogs) {
    // Simple compression: keep last 3 rounds of key decisions
    const summary = fullLogs.slice(-800);
    this.setSessionMemory(taskId, summary);
    return summary;
  }

  /* ───── Context Block ───── */
  async buildContextBlock(projectName, currentTask, fileChanges = [], todoCount = 0, progress = 0) {
    const global = await this.getGlobalMemory();
    const project = await this.getProjectMemory(projectName);
    const session = this.getSessionMemory(projectName) || '';

    const globalText = this._formatGlobal(global);
    const projectText = this._formatProject(project);
    const sessionText = session ? `Recent: ${session.slice(0, 300)}` : '';
    const contextText = this._formatContext(project, currentTask, fileChanges, todoCount, progress);

    const parts = [];
    if (globalText) parts.push(`GLOBAL|${globalText}`);
    if (projectText) parts.push(`PROJECT|${projectText}`);
    if (sessionText) parts.push(`SESSION|${sessionText}`);
    if (contextText) parts.push(`CTX|${contextText}`);

    const block = parts.join('\n');
    const tokens = this.estimateTokens(block);
    return { block, tokens, parts: { global: globalText, project: projectText, session: sessionText, context: contextText } };
  }

  _formatGlobal(g) {
    const out = [];
    if (g.codingStyle) out.push(`style:${g.codingStyle}`);
    if (g.preferences?.length) out.push(`prefs:${g.preferences.slice(-3).join(',')}`);
    if (g.activeSystems?.length) out.push(`sys:${g.activeSystems.slice(-3).join(',')}`);
    if (g.alwaysInject) out.push(`inject:${g.alwaysInject.slice(0, 120)}`);
    return out.join('|');
  }

  _formatProject(p) {
    const out = [];
    if (p.gameName) out.push(`game:${p.gameName}`);
    if (p.stack) out.push(`lang:${p.stack}`);
    if (p.decisions?.length) out.push(`decisions:${p.decisions.slice(-2).map((d) => d.text).join('; ').slice(0, 200)}`);
    if (p.knownBugs?.length) out.push(`bugs:${p.knownBugs.slice(-2).map((b) => b.text).join('; ').slice(0, 150)}`);
    if (p.remoteNames?.length) out.push(`remotes:${p.remoteNames.join(',')}`);
    if (p.serviceStructure?.length) out.push(`svcs:${p.serviceStructure.slice(-3).join(',')}`);
    return out.join('|');
  }

  _formatContext(project, task, fileChanges, todoCount, progress) {
    const out = [];
    if (project.name) out.push(`proj:${project.name}`);
    if (task) out.push(`focus:${task.slice(0, 80)}`);
    if (fileChanges.length) {
      const latest = fileChanges[fileChanges.length - 1];
      const ago = Math.round((Date.now() - latest.time) / 1000);
      out.push(`last_change:${latest.file}(${ago}s ago)`);
    }
    out.push(`todos_high:${todoCount}`);
    out.push(`progress:${progress}%`);
    return out.join('|');
  }

  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  /* ───── Utilities ───── */
  async listProjects() {
    try {
      const files = await fs.readdir(MEMORY_DIR);
      return files
        .filter((f) => f.startsWith('project-') && f.endsWith('.json'))
        .map((f) => f.replace(/^project-/, '').replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  async getAllMemory(projectName) {
    const [global, project] = await Promise.all([
      this.getGlobalMemory(),
      this.getProjectMemory(projectName),
    ]);
    return { global, project, session: this.getSessionMemory(projectName) || '' };
  }
}

module.exports = { MemoryManager };
