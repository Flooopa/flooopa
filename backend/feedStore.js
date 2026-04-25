const fs = require('fs').promises;
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'feed.json');

class FeedStore {
  constructor(broadcastFn) {
    this.posts = [];
    this.broadcast = broadcastFn || (() => {});
    this.load();
  }

  async load() {
    try {
      const raw = await fs.readFile(DATA_FILE, 'utf8');
      this.posts = JSON.parse(raw);
    } catch {
      this.posts = [];
    }
  }

  async save() {
    await fs.writeFile(DATA_FILE, JSON.stringify(this.posts, null, 2));
  }

  generateId() {
    return 'fd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5);
  }

  getAll(limit = 50) {
    return this.posts
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async create({ author, content, type = 'manual', metadata = {} }) {
    const post = {
      id: this.generateId(),
      author,
      content,
      type, // manual, todo_detected, fixme_resolved, planning_done, ai_event
      timestamp: Date.now(),
      metadata,
      reactions: {},
      replies: [],
    };
    this.posts.push(post);
    await this.save();
    this.broadcast('feed_post', post);
    return post;
  }

  async addReply(postId, { author, content }) {
    const post = this.posts.find((p) => p.id === postId);
    if (!post) return null;
    const reply = { id: this.generateId(), author, content, timestamp: Date.now() };
    post.replies.push(reply);
    await this.save();
    this.broadcast('feed_reply', { postId, reply });
    return reply;
  }

  async addReaction(postId, emoji, user) {
    const post = this.posts.find((p) => p.id === postId);
    if (!post) return null;
    if (!post.reactions[emoji]) post.reactions[emoji] = [];
    if (!post.reactions[emoji].includes(user)) {
      post.reactions[emoji].push(user);
    } else {
      post.reactions[emoji] = post.reactions[emoji].filter((u) => u !== user);
    }
    await this.save();
    this.broadcast('feed_reaction', { postId, emoji, user, count: post.reactions[emoji].length });
    return post.reactions[emoji];
  }

  async delete(postId) {
    const idx = this.posts.findIndex((p) => p.id === postId);
    if (idx === -1) return false;
    this.posts.splice(idx, 1);
    await this.save();
    this.broadcast('feed_deleted', { id: postId });
    return true;
  }

  // Automated events
  async logTodoDetected(todo) {
    return this.create({
      author: 'system',
      content: `Detected **${todo.type}** in \`${todo.file}\`: ${todo.text}`,
      type: 'todo_detected',
      metadata: { todoId: todo.id, file: todo.file, line: todo.line },
    });
  }

  async logFixmeResolved(todo) {
    return this.create({
      author: 'system',
      content: `Resolved **${todo.type}** in \`${todo.file}\`: ${todo.text}`,
      type: 'fixme_resolved',
      metadata: { todoId: todo.id, file: todo.file },
    });
  }

  async logPlanningDone(taskId, summary) {
    return this.create({
      author: 'system',
      content: `Planning session complete. ${summary.slice(0, 200)}`,
      type: 'planning_done',
      metadata: { taskId },
    });
  }

  async logAiEvent(message, metadata = {}) {
    return this.create({
      author: 'system',
      content: message,
      type: 'ai_event',
      metadata,
    });
  }

  getPublicView() {
    const resolved = this.posts.filter((p) => p.type === 'fixme_resolved').length;
    const totalTodos = this.posts.filter((p) => p.type === 'todo_detected').length;
    const planningPosts = this.posts.filter((p) => p.type === 'planning_done');

    return {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      stats: { resolved, totalTodos, planningSessions: planningPosts.length },
      roadmap: planningPosts.slice(0, 5).map((p) => ({
        title: p.content.slice(0, 80),
        status: 'planned',
        date: new Date(p.timestamp).toISOString(),
      })),
      patchNotes: this.posts
        .filter((p) => p.type === 'fixme_resolved')
        .slice(0, 10)
        .map((p) => ({
          text: p.content,
          date: new Date(p.timestamp).toISOString(),
        })),
      knownIssues: this.posts
        .filter((p) => p.type === 'todo_detected')
        .slice(0, 10)
        .map((p) => ({
          text: p.metadata?.file ? `${p.metadata.file}: ${p.content}` : p.content,
          severity: 'open',
        })),
    };
  }
}

module.exports = { FeedStore };
