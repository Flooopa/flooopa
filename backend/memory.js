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
    const summary = fullLogs.slice(-800);
    this.setSessionMemory(taskId, summary);
    return summary;
  }

  /* ───── Markdown Context Block ───── */
  async buildContextBlock(projectName, currentTask, fileChanges = [], todos = [], progress = 0, knowledgeBase = new Map(), options = {}) {
    const maxTokens = options.maxTokens || 6000;
    const global = await this.getGlobalMemory();
    const project = await this.getProjectMemory(projectName);
    const session = this.getSessionMemory(projectName) || '';

    const sections = [];

    // Helper: add section if content exists
    const add = (priority, header, content) => {
      const trimmed = content?.toString().trim();
      if (trimmed && trimmed !== 'null' && trimmed !== 'undefined') {
        sections.push({ priority, header, content: trimmed });
      }
    };

    // P1: Current task (always included)
    add(1, 'Current Task', currentTask);

    // P2: Stack & tech
    if (project.stack) {
      add(2, 'Stack', project.stack);
    }

    // P3: Guidelines (coding style + preferences)
    const guideParts = [];
    if (global.codingStyle) guideParts.push(`**Style:** ${global.codingStyle}`);
    if (global.preferences?.length) guideParts.push(`**Preferences:** ${global.preferences.join('; ')}`);
    if (global.alwaysInject) guideParts.push(`**Always Remember:** ${global.alwaysInject}`);
    if (project.codingStylePrefs?.length) guideParts.push(`**Project Style:** ${project.codingStylePrefs.join('; ')}`);
    add(3, 'Guidelines', guideParts.join('\n'));

    // P4: Architecture Decisions (full text, last 15)
    if (project.decisions?.length) {
      const decisions = project.decisions
        .slice(-15)
        .map((d) => `- ${d.text}`)
        .join('\n');
      add(4, 'Architecture Decisions', decisions);
    }

    // P5: Known Bugs (full text, last 10)
    if (project.knownBugs?.length) {
      const bugs = project.knownBugs
        .slice(-10)
        .map((b) => `- ${b.text}`)
        .join('\n');
      add(5, 'Known Bugs', bugs);
    }

    // P6: Systems (Roblox-specific)
    const sysParts = [];
    if (project.gameName) sysParts.push(`**Game:** ${project.gameName}`);
    if (project.serviceStructure?.length) sysParts.push(`**Services:** ${project.serviceStructure.join(', ')}`);
    if (project.remoteNames?.length) sysParts.push(`**Remotes:** ${project.remoteNames.join(', ')}`);
    if (global.activeSystems?.length) sysParts.push(`**Active Systems:** ${global.activeSystems.join(', ')}`);
    add(6, 'Systems', sysParts.join('\n'));

    // P7: File Summaries from knowledgeBase (the key addition for conflict detection)
    if (knowledgeBase.size > 0) {
      const entries = Array.from(knowledgeBase.entries())
        .slice(-20)
        .map(([file, summary]) => `### \`${file}\`\n${summary}`)
        .join('\n\n');
      add(7, 'File Summaries', entries);
    }

    // P8: Recent file changes
    if (fileChanges.length) {
      const changes = fileChanges
        .slice(-8)
        .map((c) => {
          const ago = Math.round((Date.now() - c.time) / 1000);
          const unit = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.round(ago / 60)}m` : `${Math.round(ago / 3600)}h`;
          return `- **\`${c.file}\`** — changed ${unit} ago`;
        })
        .join('\n');
      add(8, 'Recent Changes', changes);
    }

    // P9: Open Tasks (todos/fixmes)
    const openTodos = todos?.filter((t) => t.status !== 'resolved' && t.status !== 'done');
    if (openTodos?.length) {
      const highPriority = openTodos.filter((t) => t.priority === 'high' || t.type === 'FIXME');
      const rest = openTodos.filter((t) => t.priority !== 'high' && t.type !== 'FIXME');
      const todoList = [
        ...highPriority.slice(-8).map((t) => `- [${t.type}] **${t.text}**${t.file ? ` (\`${t.file}\`)` : ''}`),
        ...rest.slice(-5).map((t) => `- [${t.type}] ${t.text}${t.file ? ` (\`${t.file}\`)` : ''}`),
      ].join('\n');
      add(9, 'Open Tasks', todoList);
    }

    // P10: Progress
    if (progress > 0) {
      add(10, 'Progress', `Project file coverage: ${progress}%`);
    }

    // P11: Session context
    if (session) {
      add(11, 'Recent Session', session);
    }

    // Sort by priority
    sections.sort((a, b) => a.priority - b.priority);

    // Build full block
    let block = sections.map((s) => `## ${s.header}\n${s.content}`).join('\n\n');
    let tokens = this.estimateTokens(block);

    // Intelligent truncation if over budget
    if (tokens > maxTokens) {
      const kept = [];
      let currentTokens = 0;

      for (const section of sections) {
        const sectionText = `## ${section.header}\n${section.content}`;
        const sectionTokens = this.estimateTokens(sectionText);

        if (currentTokens + sectionTokens <= maxTokens * 0.85) {
          kept.push(sectionText);
          currentTokens += sectionTokens;
        } else {
          // Try a truncated placeholder
          const truncated = `## ${section.header}\n*[Truncated — ${sectionTokens}t exceeds budget. See project memory endpoint for full details.]*`;
          const truncTokens = this.estimateTokens(truncated);
          if (currentTokens + truncTokens <= maxTokens) {
            kept.push(truncated);
            currentTokens += truncTokens;
          }
          break;
        }
      }

      block = kept.join('\n\n');
      tokens = this.estimateTokens(block);
    }

    return {
      block,
      tokens,
      sections: sections.map((s) => ({ header: s.header, priority: s.priority })),
    };
  }

  estimateTokens(text) {
    // Conservative estimate: ~4 chars per token for English/code
    return Math.ceil(text.length / 3.5);
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
