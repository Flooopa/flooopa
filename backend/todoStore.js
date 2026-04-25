const fs = require('fs').promises;
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'todos.json');

class TodoStore {
  constructor(broadcastFn) {
    this.todos = [];
    this.broadcast = broadcastFn || (() => {});
    this.autoMode = false;
    this.currentIndex = 0;
    this.load();
  }

  async load() {
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      this.todos = JSON.parse(raw);
    } catch {
      this.todos = [];
    }
  }

  async save() {
    await fs.writeFile(DATA_FILE, JSON.stringify(this.todos, null, 2));
  }

  generateId() {
    return 'td-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  }

  getAll() {
    // Sort by: active first, then priority, then type (FIXME before TODO), then order
    return [...this.todos].sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      const prioMap = { high: 0, medium: 1, low: 2 };
      const pa = prioMap[a.priority] ?? 1;
      const pb = prioMap[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      if (a.type === 'FIXME' && b.type !== 'FIXME') return -1;
      if (b.type === 'FIXME' && a.type !== 'FIXME') return 1;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  }

  getById(id) {
    return this.todos.find((t) => t.id === id);
  }

  async create({ type, text, file = '', line = null, assignee = '', priority = 'medium', source = 'manual' }) {
    const todo = {
      id: this.generateId(),
      type: type === 'FIXME' ? 'FIXME' : 'TODO',
      text,
      file,
      line,
      timestamp: Date.now(),
      assignee,
      priority,
      status: 'open',
      order: this.todos.length,
      source,
    };
    this.todos.push(todo);
    await this.save();
    this.broadcast('todo_created', todo);
    return todo;
  }

  async update(id, updates) {
    const idx = this.todos.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    this.todos[idx] = { ...this.todos[idx], ...updates };
    await this.save();
    this.broadcast('todo_updated', this.todos[idx]);
    return this.todos[idx];
  }

  async delete(id) {
    const idx = this.todos.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    const removed = this.todos.splice(idx, 1)[0];
    // Reindex orders
    this.todos.forEach((t, i) => { t.order = i; });
    await this.save();
    this.broadcast('todo_deleted', { id: removed.id });
    return true;
  }

  async reorder(orderedIds) {
    const map = new Map(this.todos.map((t) => [t.id, t]));
    const newOrder = [];
    orderedIds.forEach((id, i) => {
      if (map.has(id)) {
        map.get(id).order = i;
        newOrder.push(map.get(id));
      }
    });
    // Append any missing todos at the end
    map.forEach((t) => {
      if (!newOrder.includes(t)) {
        t.order = newOrder.length;
        newOrder.push(t);
      }
    });
    this.todos = newOrder;
    await this.save();
    this.broadcast('todo_reordered', { ids: orderedIds });
  }

  async setActive(id) {
    this.todos.forEach((t) => { t.status = t.id === id ? 'active' : (t.status === 'active' ? 'open' : t.status); });
    await this.save();
    this.broadcast('todo_activated', { id });
  }

  async resolve(id) {
    return this.update(id, { status: 'resolved', resolvedAt: Date.now() });
  }

  async clearResolved() {
    this.todos = this.todos.filter((t) => t.status !== 'resolved');
    this.todos.forEach((t, i) => { t.order = i; });
    await this.save();
    this.broadcast('todo_cleared_resolved', {});
  }

  // Auto mode: get next todo to work on
  getNextAuto() {
    const sorted = this.getAll().filter((t) => t.status === 'open');
    return sorted[0] || null;
  }

  async startAuto() {
    this.autoMode = true;
    this.broadcast('auto_mode', { active: true });
    await this.processNextAuto();
  }

  stopAuto() {
    this.autoMode = false;
    this.todos.forEach((t) => { if (t.status === 'active') t.status = 'open'; });
    this.broadcast('auto_mode', { active: false });
  }

  async processNextAuto() {
    if (!this.autoMode) return;
    const next = this.getNextAuto();
    if (!next) {
      this.stopAuto();
      this.broadcast('auto_mode', { active: false, reason: 'queue_empty' });
      return;
    }
    await this.setActive(next.id);
    this.broadcast('auto_mode', { active: true, currentId: next.id, progress: this.getProgress() });
  }

  getProgress() {
    const total = this.todos.filter((t) => t.status !== 'resolved').length;
    const active = this.todos.filter((t) => t.status === 'active').length;
    if (total === 0) return 100;
    return Math.round((active / total) * 100);
  }

  getStats() {
    return {
      total: this.todos.length,
      open: this.todos.filter((t) => t.status === 'open').length,
      active: this.todos.filter((t) => t.status === 'active').length,
      resolved: this.todos.filter((t) => t.status === 'resolved').length,
      fixme: this.todos.filter((t) => t.type === 'FIXME').length,
      todo: this.todos.filter((t) => t.type === 'TODO').length,
    };
  }
}

module.exports = { TodoStore };
