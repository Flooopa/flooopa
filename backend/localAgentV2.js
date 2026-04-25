/**
 * Local Agent v2 — Cloud-connected file watcher
 *
 * Watches project files, summarizes via Ollama,
 * and pushes TODOs/FIXMEs directly to Supabase (no WebSocket/Express needed).
 *
 * Usage:
 *   node localAgentV2.js
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKSPACE_ID
 *   PROJECT_PATH (optional, defaults to parent of backend dir)
 */

const chokidar = require('chokidar');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ───
const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
const OLLAMA_TAGS = 'http://127.0.0.1:11434/api/tags';
const DEFAULT_MODEL = 'qwen2.5:3b';
const ACCEPTED_MODELS = ['qwen2.5:3b', 'llama3.2:3b', 'llama3.1:8b', 'mistral-nemo:12b'];

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKSPACE_ID = process.env.WORKSPACE_ID || process.env.DEFAULT_WORKSPACE_ID || '00000000-0000-0000-0000-000000000000';
const PROJECT_PATH = process.env.PROJECT_PATH || path.resolve(__dirname, '..');

// ─── Supabase client ───
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
} else {
  console.warn('[LocalAgent] No Supabase credentials — running in local-only mode');
}

// ─── State ───
let model = DEFAULT_MODEL;
let available = false;
let knowledgeBase = new Map();
let fileChanges = [];
let progress = 0;
let watcher = null;
let knownTodos = new Set(); // Deduplication: text+file hash

// ─── Helpers ───
function todoKey(text, file) { return `${file}::${text}`; }

async function checkOllama() {
  try {
    const res = await fetch(OLLAMA_TAGS, { timeout: 3000 });
    if (!res.ok) return false;
    const data = await res.json();
    const models = data.models?.map((m) => m.name) || [];
    for (const candidate of ACCEPTED_MODELS) {
      if (models.includes(candidate)) {
        model = candidate;
        return true;
      }
    }
    console.log('[LocalAgent] No suitable Ollama model. Available:', models.join(', '));
    return false;
  } catch {
    return false;
  }
}

async function ollamaGenerate(prompt, maxTokens = 60) {
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
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

async function summarizeFile(relPath, content) {
  const snippet = content.slice(0, 1500);
  const prompt = `In one sentence, describe what this code file does. Be specific.

File: ${relPath}
\`\`\`
${snippet}
\`\`\``;
  return ollamaGenerate(prompt, 60);
}

async function pushTodoToSupabase(type, text, filePath) {
  if (!supabase) return null;

  // Check for duplicates
  const { data: existing } = await supabase
    .from('todos')
    .select('id')
    .eq('workspace_id', WORKSPACE_ID)
    .eq('text', text)
    .eq('file', filePath)
    .maybeSingle();

  if (existing) return null; // Already exists

  // Get max order
  const { data: maxOrder } = await supabase
    .from('todos')
    .select('order')
    .eq('workspace_id', WORKSPACE_ID)
    .order('order', { ascending: false })
    .limit(1)
    .single();

  const { data, error } = await supabase
    .from('todos')
    .insert({
      workspace_id: WORKSPACE_ID,
      type,
      text,
      file: filePath,
      priority: type === 'FIXME' ? 'high' : 'medium',
      source: 'auto',
      order: (maxOrder?.order ?? -1) + 1,
    })
    .select()
    .single();

  if (error) {
    console.error('[LocalAgent] Failed to push todo:', error.message);
    return null;
  }

  return data;
}

async function pushFeedEvent(type, content, metadata = {}) {
  if (!supabase) return;
  const { error } = await supabase.from('feed_posts').insert({
    workspace_id: WORKSPACE_ID,
    author: 'system',
    author_id: 'local-agent',
    content,
    type,
    metadata,
  });
  if (error) console.error('[LocalAgent] Failed to push feed event:', error.message);
}

async function scanTodos(content, filePath) {
  const todoRe = /--\s*TODO[:\s]+(.+)/gi;
  const fixmeRe = /--\s*FIXME[:\s]+(.+)/gi;
  let m;

  while ((m = todoRe.exec(content)) !== null) {
    const text = m[1].trim();
    const key = todoKey(text, filePath);
    if (!knownTodos.has(key)) {
      knownTodos.add(key);
      const todo = await pushTodoToSupabase('TODO', text, filePath);
      if (todo) {
        console.log(`[LocalAgent] TODO detected: ${text.slice(0, 60)}`);
        await pushFeedEvent('todo_detected', `TODO detected in ${filePath}: ${text.slice(0, 100)}`, { todo_id: todo.id, file: filePath });
      }
    }
  }

  while ((m = fixmeRe.exec(content)) !== null) {
    const text = m[1].trim();
    const key = todoKey(text, filePath);
    if (!knownTodos.has(key)) {
      knownTodos.add(key);
      const todo = await pushTodoToSupabase('FIXME', text, filePath);
      if (todo) {
        console.log(`[LocalAgent] FIXME detected: ${text.slice(0, 60)}`);
        await pushFeedEvent('todo_detected', `FIXME detected in ${filePath}: ${text.slice(0, 100)}`, { todo_id: todo.id, file: filePath });
      }
    }
  }
}

async function onFileChange(filePath) {
  const rel = path.relative(PROJECT_PATH, filePath);
  const ext = path.extname(rel).toLowerCase();
  if (!ext || ext === '.tmp' || ext === '.lock') return;

  const content = await fs.readFile(filePath, 'utf8').catch(() => '');

  fileChanges.push({ file: rel, time: Date.now() });
  if (fileChanges.length > 100) fileChanges.shift();

  // Scan for TODOs/FIXMEs
  await scanTodos(content, rel);

  // Summarize (non-blocking)
  summarizeFile(rel, content).then((summary) => {
    if (summary) {
      knowledgeBase.set(rel, summary);
      console.log(`[LocalAgent] ${rel}: ${summary.slice(0, 80)}`);
    }
  });
}

function updateProgress() {
  const files = Array.from(knowledgeBase.keys());
  if (files.length === 0) { progress = 0; return; }
  const meaningful = files.filter((f) => {
    const s = knowledgeBase.get(f);
    return s && s.length > 10 && !s.includes('empty');
  });
  progress = Math.min(100, Math.round((meaningful.length / files.length) * 100));
}

// ─── Bootstrap ───
async function start() {
  available = await checkOllama();
  if (!available) {
    console.log('[LocalAgent] Ollama not available — local AI features disabled');
    console.log('[LocalAgent] Start Ollama and ensure one of these models is pulled:');
    console.log('  ', ACCEPTED_MODELS.join(', '));
    return;
  }

  console.log(`[LocalAgent] Model: ${model}`);
  console.log(`[LocalAgent] Watching: ${PROJECT_PATH}`);
  console.log(`[LocalAgent] Supabase: ${supabase ? SUPABASE_URL : 'disabled'}`);
  console.log(`[LocalAgent] Workspace: ${WORKSPACE_ID}`);

  // Pre-seed known todos from Supabase to avoid duplicates
  if (supabase) {
    const { data: todos } = await supabase
      .from('todos')
      .select('text, file')
      .eq('workspace_id', WORKSPACE_ID);
    if (todos) {
      for (const t of todos) knownTodos.add(todoKey(t.text, t.file));
      console.log(`[LocalAgent] Pre-loaded ${todos.length} existing todos`);
    }
  }

  watcher = chokidar.watch(PROJECT_PATH, {
    ignored: /(^|[\/\])\..|node_modules|\.git|memory|\.next/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });

  watcher.on('change', (fp) => onFileChange(fp));
  watcher.on('add', (fp) => onFileChange(fp));

  // Progress heartbeat
  setInterval(updateProgress, 30 * 1000);

  // Session compression every 24h
  setInterval(async () => {
    console.log('[LocalAgent] Running session compression...');
    // TODO: compress session memory if stored in Supabase
  }, 24 * 60 * 60 * 1000);

  console.log('[LocalAgent] Ready. Watching for file changes...');
}

function stop() {
  if (watcher) { watcher.close(); watcher = null; }
  console.log('[LocalAgent] Stopped');
}

// Handle graceful shutdown
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

// Start if run directly
if (require.main === module) {
  start().catch(console.error);
}

module.exports = { start, stop, getStatus: () => ({ available, model, watchedFiles: knowledgeBase.size, progress }) };
