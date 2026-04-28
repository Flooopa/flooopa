const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { finished } = require('stream');
require('dotenv').config();

const { MemoryManager } = require('./memory');
const { LocalAgent } = require('./localAgent');
const { TodoStore } = require('./todoStore');
const { FeedStore } = require('./feedStore');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3001;
const PROJECT_NAME = process.env.PROJECT_NAME || 'default';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-for-coding';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1/chat/completions';
const CLAUDE_BASE_URL = process.env.CLAUDE_BASE_URL || 'https://api.anthropic.com/v1';

const TOKEN_CAP = {
  solver: 2000,
  critic: 400,
  synthesizer: 600,
  planner: 2000,
  devil: 400,
  compiler: 600,
  finalizer: 800,
};

const WORKFLOW_MODES = {
  code: { primary: 'kimi', secondary: 'claude', description: 'Kimi drafts, Claude reviews' },
  planning: { primary: 'claude', secondary: 'kimi', description: 'Claude architects, Kimi stress-tests' },
  content: { primary: 'claude', secondary: 'kimi', description: 'Claude writes, Kimi edits' },
  research: { primary: 'both', secondary: null, description: 'Both run independently, compare' },
  debate: { primary: 'both', secondary: null, description: 'Opposing sides forced' },
};

// ─── Init Memory, Todo, Feed, Local Agent ───
const memoryManager = new MemoryManager();
const todoStore = new TodoStore((event, data) => broadcast(event, data));
const feedStore = new FeedStore((event, data) => broadcast(event, data));
const localAgent = new LocalAgent(
  path.join(__dirname, '..', '..'),
  memoryManager,
  (event, data) => broadcast(event, data),
  todoStore,
  feedStore
);

// Key validation logs
console.log('Kimi Code API Key loaded:', !!process.env.KIMI_CODE_API_KEY);
console.log('Anthropic API Key loaded:', !!process.env.ANTHROPIC_API_KEY);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Store active agents state
const activeAgents = new Map();

// Roblox index storage (populated by roblox-indexer service)
const robloxIndex = {
  gameName: '',
  indexedAt: null,
  scripts: [],
  hierarchy: null,
  stats: { total: 0, byCategory: {} },
};

// SSE listeners: taskId -> Set of response objects
const sseListeners = new Map();

// Event buffer for SSE replay (prevents race condition where client connects after pipeline starts)
const taskEventBuffers = new Map();
const EVENT_BUFFER_LIMIT = 500;

function bufferTaskEvent(taskId, event, data) {
  if (!taskEventBuffers.has(taskId)) taskEventBuffers.set(taskId, []);
  const buffer = taskEventBuffers.get(taskId);
  buffer.push({ event, data, timestamp: new Date().toISOString() });
  if (buffer.length > EVENT_BUFFER_LIMIT) buffer.shift();
}

function flushTaskEventBuffer(taskId, res) {
  const buffer = taskEventBuffers.get(taskId) || [];
  for (const msg of buffer) {
    sendSSE(res, msg.event, msg.data);
  }
}

function addSseListener(taskId, res) {
  if (!sseListeners.has(taskId)) sseListeners.set(taskId, new Set());
  sseListeners.get(taskId).add(res);
}

function removeSseListener(taskId, res) {
  const set = sseListeners.get(taskId);
  if (set) {
    set.delete(res);
    if (set.size === 0) sseListeners.delete(taskId);
  }
}

function sendSSE(res, event, data) {
  try {
    res.write(`data: ${JSON.stringify({ event, data, timestamp: new Date().toISOString() })}\n\n`);
  } catch {
    // Client disconnected
  }
}

function broadcastToTask(taskId, event, data) {
  const listeners = sseListeners.get(taskId);
  if (listeners) {
    listeners.forEach((res) => sendSSE(res, event, data));
  }
}

// Broadcast to all connected WebSocket clients AND matching SSE listeners
function broadcast(event, data) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
  // Also broadcast to SSE listeners if this event belongs to a task
  if (data && data.taskId) {
    broadcastToTask(data.taskId, event, data);
    bufferTaskEvent(data.taskId, event, data);
  }
}

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.send(JSON.stringify({ event: 'connected', data: { message: 'Connected to AI Orchestrator' }, timestamp: new Date().toISOString() }));
});

// ─── Context Injection ───

function findRelevantRobloxScripts(task, maxResults = 8) {
  if (!robloxIndex.scripts.length || !task) return [];
  const taskWords = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const scored = robloxIndex.scripts.map((s) => {
    const text = `${s.name} ${s.summary} ${s.category}`.toLowerCase();
    let score = 0;
    for (const word of taskWords) {
      if (text.includes(word)) score += 1;
    }
    if (taskWords.some((w) => s.category.toLowerCase().includes(w))) score += 3;
    return { script: s, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults).filter((s) => s.score > 0).map((s) => s.script);
}

async function buildMemoryContext(taskId, currentTask) {
  const changes = localAgent.fileChanges;
  const todos = localAgent.todoStore?.todos || [];
  const { block, tokens, sections } = await memoryManager.buildContextBlock(
    PROJECT_NAME,
    currentTask,
    changes,
    todos,
    localAgent.progress,
    localAgent.knowledgeBase,
    { maxTokens: 6000 }
  );

  // Append relevant Roblox scripts if available
  let finalBlock = block;
  const relevantScripts = findRelevantRobloxScripts(currentTask);
  if (relevantScripts.length > 0) {
    const robloxSection = [
      '## Roblox Game Scripts (Chisld)',
      ...relevantScripts.map((s) =>
        `### \`${s.name}\` (${s.category})\n${s.summary}\n\`\`\`lua\n${s.content?.slice(0, 800) || '[content not cached]'}\n\`\`\``
      ),
    ].join('\n\n');
    finalBlock = block + '\n\n' + robloxSection;
  }

  const finalTokens = memoryManager.estimateTokens(finalBlock);
  console.log(`[${taskId}] context built: ${finalTokens}t (${relevantScripts.length} Roblox scripts), sections: [${sections.map((s) => s.header).join(', ')}]`);
  return { block: finalBlock, tokens: finalTokens, sections };
}

function injectContext(messages, contextBlock) {
  if (!contextBlock) return messages;

  const contextPrefix = `## Project Context\n\n${contextBlock}\n\n---\n\n`;

  // Find all system messages and combine them with context
  const systemIndices = [];
  let combinedSystem = contextPrefix;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') {
      systemIndices.push(i);
      combinedSystem += messages[i].content + '\n\n';
    }
  }

  if (systemIndices.length === 0) {
    // No system message exists — prepend combined context
    return [{ role: 'system', content: combinedSystem.trim() }, ...messages];
  }

  // Replace first system message with combined content, drop other system messages
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    if (i === systemIndices[0]) {
      result.push({ role: 'system', content: combinedSystem.trim() });
    } else if (messages[i].role !== 'system') {
      result.push(messages[i]);
    }
  }
  return result;
}


// ─── Streaming Helpers ───

async function streamKimi(taskId, messages, maxTokens, onChunk, onComplete, onError) {
  const apiKey = process.env.KIMI_CODE_API_KEY;
  if (!apiKey) { onError('Kimi API key not configured'); return; }

  let httpStatus = 0;
  const abortController = new AbortController();
  const timeout = setTimeout(() => { abortController.abort(); }, 90000);

  try {
    const response = await fetch(KIMI_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'KimiCLI/1.5',
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages,
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: abortController.signal,
    });

    clearTimeout(timeout);
    httpStatus = response.status;
    console.log(`[${taskId}] kimi stream — HTTP ${httpStatus}, maxTokens=${maxTokens}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error (kimi): ${response.status} ${text}`);
    }

    const reader = response.body;
    if (!reader) throw new Error('Response body is null');

    let buffer = '';
    let fullText = '';
    let hasReceivedData = false;
    let currentData = '';
    let resolved = false;

    const safeComplete = (text) => {
      if (!resolved) {
        resolved = true;
        onComplete(text);
      }
    };
    const safeError = (msg) => {
      if (!resolved) {
        resolved = true;
        onError(msg);
      }
    };

    reader.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (currentData) {
            if (currentData === '[DONE]') {
              safeComplete(fullText);
            } else {
              try {
                const data = JSON.parse(currentData);
                if (data.error) {
                  console.error(`[${taskId}] kimi in-stream error:`, data.error.message || JSON.stringify(data.error));
                  continue;
                }
                const content = data.choices?.[0]?.delta?.content || '';
                const reasoning = data.choices?.[0]?.delta?.reasoning_content || '';
                const text = content || reasoning;
                if (text) {
                  hasReceivedData = true;
                  fullText += text;
                  onChunk(text, fullText);
                }
              } catch (parseErr) {
                console.warn(`[${taskId}] kimi SSE parse error:`, parseErr.message, '| raw:', currentData.slice(0, 200));
              }
            }
            currentData = '';
          }
          continue;
        }

        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (currentData) currentData += '\n' + dataStr;
          else currentData = dataStr;
        } else if (currentData) {
          currentData += '\n' + trimmed;
        }
      }
    });

    finished(reader, (err) => {
      if (resolved) return;
      if (err) {
        console.error(`[${taskId}] kimi stream finished with error:`, err.message);
        safeError(err.message);
        return;
      }
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (dataStr && dataStr !== '[DONE]') {
            try {
              const data = JSON.parse(dataStr);
              const content = data.choices?.[0]?.delta?.content || '';
              const reasoning = data.choices?.[0]?.delta?.reasoning_content || '';
              const text = content || reasoning;
              if (text) {
                hasReceivedData = true;
                fullText += text;
                onChunk(text, fullText);
              }
            } catch {}
          } else if (dataStr === '[DONE]') {
            safeComplete(fullText);
            return;
          }
        }
      }
      if (!hasReceivedData) console.warn(`[${taskId}] kimi stream ended with NO data (HTTP ${httpStatus}).`);
      if (!fullText.trim()) console.warn(`[${taskId}] kimi EMPTY output (HTTP ${httpStatus}, maxTokens=${maxTokens}).`);
      safeComplete(fullText);
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error(`[${taskId}] kimi stream aborted — timed out after 90s`);
      onError('Request timed out after 90 seconds');
    } else {
      console.error(`[${taskId}] kimi stream failed — HTTP ${httpStatus}:`, err.message);
      onError(err.message);
    }
  }
}


async function streamClaude(taskId, messages, maxTokens, onChunk, onComplete, onError) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { onError('Claude API key not configured'); return; }

  // Combine all system messages into one (Claude only accepts a single system string)
  const systemMessages = messages.filter((m) => m.role === 'system');
  const systemMsg = systemMessages.map((m) => m.content).join('\n\n');
  const chatMessages = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (chatMessages.length === 0) {
    onError('No chat messages provided to Claude');
    return;
  }

  let httpStatus = 0;
  const abortController = new AbortController();
  const timeout = setTimeout(() => { abortController.abort(); }, 90000);

  try {
    const response = await fetch(`${CLAUDE_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        ...(systemMsg ? { system: systemMsg } : {}),
        messages: chatMessages,
        stream: true,
      }),
      signal: abortController.signal,
    });

    clearTimeout(timeout);
    httpStatus = response.status;
    console.log(`[${taskId}] claude stream — HTTP ${httpStatus}, maxTokens=${maxTokens}`);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error (claude): ${response.status} ${text}`);
    }

    const reader = response.body;
    if (!reader) throw new Error('Response body is null');

    let buffer = '';
    let fullText = '';
    let hasReceivedData = false;
    let currentData = '';
    let resolved = false;

    const safeComplete = (text) => {
      if (!resolved) {
        resolved = true;
        onComplete(text);
      }
    };
    const safeError = (msg) => {
      if (!resolved) {
        resolved = true;
        onError(msg);
      }
    };

    reader.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (currentData) {
            try {
              const data = JSON.parse(currentData);
              if (data.type === 'content_block_delta' && data.delta?.text) {
                hasReceivedData = true;
                fullText += data.delta.text;
                onChunk(data.delta.text, fullText);
              } else if (data.type === 'content_block_start' && data.content_block?.text) {
                hasReceivedData = true;
                fullText += data.content_block.text;
                onChunk(data.content_block.text, fullText);
              } else if (data.type === 'message_delta' && data.delta?.stop_reason === 'error') {
                console.error(`[${taskId}] claude in-stream error event:`, data);
                safeError('Claude reported an in-stream error');
                return;
              }
            } catch (parseErr) {
              console.warn(`[${taskId}] claude SSE parse error:`, parseErr.message, '| raw:', currentData.slice(0, 200));
            }
            currentData = '';
          }
          continue;
        }

        if (trimmed.startsWith('event:')) {
          // Track event type if needed for debugging
        } else if (trimmed.startsWith('data:')) {
          const dataStr = trimmed.slice(5).trim();
          if (currentData) currentData += '\n' + dataStr;
          else currentData = dataStr;
        } else if (currentData) {
          currentData += '\n' + trimmed;
        }
      }
    });

    finished(reader, (err) => {
      if (resolved) return;
      if (err) {
        console.error(`[${taskId}] claude stream finished with error:`, err.message);
        safeError(err.message);
        return;
      }
      if (buffer.trim()) {
        const lines = buffer.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr && dataStr !== '[DONE]') {
              try {
                const data = JSON.parse(dataStr);
                if (data.type === 'content_block_delta' && data.delta?.text) {
                  hasReceivedData = true;
                  fullText += data.delta.text;
                  onChunk(data.delta.text, fullText);
                } else if (data.type === 'content_block_start' && data.content_block?.text) {
                  hasReceivedData = true;
                  fullText += data.content_block.text;
                  onChunk(data.content_block.text, fullText);
                }
              } catch {}
            }
          }
        }
      }
      if (!hasReceivedData) console.warn(`[${taskId}] claude stream ended with NO data (HTTP ${httpStatus}).`);
      if (!fullText.trim()) console.warn(`[${taskId}] claude EMPTY output (HTTP ${httpStatus}, maxTokens=${maxTokens}).`);
      safeComplete(fullText);
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error(`[${taskId}] claude stream aborted — timed out after 90s`);
      onError('Request timed out after 90 seconds');
    } else {
      console.error(`[${taskId}] claude stream failed — HTTP ${httpStatus}:`, err.message);
      onError(err.message);
    }
  }
}


// ─── Task Detection & Role Logic ───
function detectTaskType(task) {
  const t = task.toLowerCase();
  if (t.includes('debug') || t.includes('fix') || t.includes('bug') || t.includes('error') || t.includes('implement') || t.includes('build') || t.includes('function') || t.includes('refactor') || t.includes('code')) {
    return 'coding';
  }
  if (t.includes('plan') || t.includes('architect') || t.includes('design') || t.includes('structure') || t.includes('system')) {
    return 'planning';
  }
  return 'content';
}

function getModelsForMode(mode, taskType, override) {
  if (override && override !== 'auto') {
    return { primary: override, secondary: override === 'kimi' ? 'claude' : 'kimi' };
  }
  const config = WORKFLOW_MODES[mode];
  if (!config) {
    if (taskType === 'coding') return { primary: 'kimi', secondary: 'claude' };
    return { primary: 'claude', secondary: 'kimi' };
  }
  return config;
}

function parseConfidence(text) {
  const match = text.match(/Confidence:\s*(\d+)(?:\/10)?/i);
  if (match) return parseInt(match[1], 10);
  const match2 = text.match(/(\d+)\s*\/\s*10/);
  if (match2) return parseInt(match2[1], 10);
  return 5;
}

// ─── Agent Runner ───
async function runAgent(taskId, agentName, role, modelKey, messages, maxTokens, startTime, round, contextBlock = null) {
  const finalMessages = contextBlock ? injectContext(messages, contextBlock) : messages;

  return new Promise((resolve) => {
    let output = '';
    let resolved = false;

    // Hard timeout guard: if stream callbacks never fire, force resolve
    const hardTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.error(`[${taskId}] ${modelKey} (${role}) HARD TIMEOUT — forcing resolve after 120s`);
        broadcast('error', {
          taskId,
          agent: modelKey,
          role,
          error: 'Agent hard timeout — did not complete within 120 seconds',
          round,
        });
        if (activeAgents.has(taskId)) {
          activeAgents.get(taskId)[modelKey].status = 'error';
        }
        resolve(output);
      }
    }, 120000);

    const safeResolve = (value) => {
      clearTimeout(hardTimeout);
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    };

    broadcast('agent_start', {
      taskId,
      agent: modelKey,
      role,
      model: modelKey === 'kimi' ? KIMI_MODEL : CLAUDE_MODEL,
      message: `${modelKey === 'kimi' ? 'Kimi' : 'Claude'} is ${role}...`,
      round,
    });

    const onChunk = (chunk, full) => {
      output = full;
      if (activeAgents.has(taskId)) {
        activeAgents.get(taskId)[modelKey].output = full;
      }
      broadcast('agent_stream', {
        taskId,
        agent: modelKey,
        role,
        chunk,
        fullText: full,
        charCount: full.length,
        duration: Date.now() - startTime,
        round,
      });
    };

    const onComplete = (full) => {
      output = full;
      if (activeAgents.has(taskId)) {
        activeAgents.get(taskId)[modelKey].status = 'complete';
      }
      if (!full.trim()) {
        console.warn(`[${taskId}] ${modelKey} (${role}) completed with EMPTY output after ${Date.now() - startTime}ms.`);
        broadcast('warning', {
          taskId,
          agent: modelKey,
          role,
          message: 'Agent returned empty output — possible context limit, content filter, or reasoning-only response.',
          round,
        });
      }
      broadcast('agent_complete', {
        taskId,
        agent: modelKey,
        role,
        fullText: full,
        charCount: full.length,
        duration: Date.now() - startTime,
        round,
      });
      safeResolve(full);
    };

    const onError = (err) => {
      if (activeAgents.has(taskId)) {
        activeAgents.get(taskId)[modelKey].status = 'error';
      }
      broadcast('error', { taskId, agent: modelKey, role, error: err, round });
      safeResolve('');
    };

    if (modelKey === 'kimi') {
      streamKimi(taskId, finalMessages, maxTokens, onChunk, onComplete, onError);
    } else {
      streamClaude(taskId, finalMessages, maxTokens, onChunk, onComplete, onError);
    }
  });
}


// ─── Standard Pipeline ───
async function runStandardPipeline(taskId, task, mode, primary, secondary, planningMode, requestedRounds, startTime) {
  const isPlanning = planningMode || mode === 'planning';
  const maxRounds = isPlanning ? Math.max(3, requestedRounds || 4) : (requestedRounds || 2);

  let currentSolution = '';
  let currentCritique = '';
  let confidence = 5;
  let roundNum = 0;

  // Build memory context
  const { block: contextBlock } = await buildMemoryContext(taskId, task);

  // --- Round 1: Solver (primary) ---
  roundNum++;
  const solverRole = isPlanning ? 'architect' : 'solver';
  const solverSystem = isPlanning
    ? 'You are a senior software architect. Create a structured plan with: Objective, Stack, Steps, Constraints, Success Criteria. Be thorough and specific.'
    : 'You are an expert coder and problem solver. Solve the given task thoroughly. Show your reasoning, provide complete, paste-ready code with clear file paths and placement instructions. Use surgical edits over full rewrites when possible.';
  const solverMessages = [
    { role: 'system', content: solverSystem },
    { role: 'user', content: `Task: ${task}\n\nPlease ${isPlanning ? 'architect a structured plan' : 'solve this completely with code'}.` },
  ];

  currentSolution = await runAgent(taskId, primary, solverRole, primary, solverMessages, TOKEN_CAP.solver, startTime, roundNum, contextBlock);

  // --- Round 2: Critic (secondary) ---
  roundNum++;
  const criticRole = isPlanning ? 'devil' : 'critic';
  const criticSystem = isPlanning
    ? `You are a ruthless devil's advocate. Aggressively challenge the plan. Identify flaws, risks, missing edge cases, and unrealistic assumptions. Check against existing project systems for conflicts. Be brief but ruthless. End with "Confidence: X/10" where X is 1-10.`
    : `You are a critical code reviewer. Review the solution for bugs, security issues, performance problems, and conflicts with existing project systems. Be concise and specific. End with "Confidence: X/10" where X is 1-10.`;
  const criticUser = `Task: ${task}\n\n${isPlanning ? 'Plan' : 'Solution'} to review:\n${currentSolution}\n\nProvide your critique and confidence score.`;
  const criticMessages = [
    { role: 'system', content: criticSystem },
    { role: 'user', content: criticUser },
  ];

  currentCritique = await runAgent(taskId, secondary, criticRole, secondary, criticMessages, TOKEN_CAP.critic, startTime, roundNum, contextBlock);
  confidence = parseConfidence(currentCritique);
  broadcast('confidence_update', { taskId, confidence, round: roundNum });

  // --- Revision rounds ---
  // Planning: always revise if maxRounds >= 3
  // Coding: revise if confidence < 6 and we have rounds left
  const needsRevision = isPlanning ? (maxRounds >= 3) : (confidence < 6 && maxRounds > 2);

  if (needsRevision) {
    roundNum++;
    const revisionSystem = isPlanning
      ? 'You are a senior software architect. Revise your plan addressing ALL critiques. Maintain structured format: Objective, Stack, Steps, Constraints, Success Criteria.'
      : 'You are the primary coder. Revise your solution addressing every critique point. Provide complete, paste-ready code.';
    const revisionMessages = [
      { role: 'system', content: revisionSystem },
      { role: 'user', content: `Task: ${task}\n\nYour original ${isPlanning ? 'plan' : 'solution'}:\n${currentSolution}\n\nCritiques to address:\n${currentCritique}\n\nPlease produce the revised ${isPlanning ? 'plan' : 'solution'}.` },
    ];
    currentSolution = await runAgent(taskId, primary, 'reviser', primary, revisionMessages, TOKEN_CAP.solver, startTime, roundNum, contextBlock);

    // Second critique after revision
    if (maxRounds >= 4 || isPlanning) {
      roundNum++;
      const reviewSystem = isPlanning
        ? 'You are a reviewer. Assess the revised plan for completeness. End with "Confidence: X/10".'
        : 'You are a critical reviewer. Review the revised solution. End with "Confidence: X/10".';
      const reviewUser = `Task: ${task}\n\nRevised ${isPlanning ? 'plan' : 'solution'}:\n${currentSolution}\n\nProvide brief review and confidence score.`;
      const reviewMessages = [
        { role: 'system', content: reviewSystem },
        { role: 'user', content: reviewUser },
      ];
      currentCritique = await runAgent(taskId, secondary, 'reviewer', secondary, reviewMessages, TOKEN_CAP.critic, startTime, roundNum, contextBlock);
      confidence = parseConfidence(currentCritique);
      broadcast('confidence_update', { taskId, confidence, round: roundNum });
    }
  }

  // Planning mode: additional polish round if maxRounds >= 5
  if (isPlanning && maxRounds >= 5) {
    roundNum++;
    const polishSystem = 'You are a senior architect. Polish the plan into final structured markdown: Objective, Stack, Steps, Constraints, Success Criteria, Risks & Mitigations.';
    const polishMessages = [
      { role: 'system', content: polishSystem },
      { role: 'user', content: `Task: ${task}\n\nPlan:\n${currentSolution}\n\nCritiques addressed:\n${currentCritique}\n\nProduce the final polished plan in structured markdown.` },
    ];
    currentSolution = await runAgent(taskId, primary, 'finalizer', primary, polishMessages, TOKEN_CAP.planner, startTime, roundNum, contextBlock);
  }

  // --- Skip synthesis if high confidence (non-planning only) ---
  if (!isPlanning && confidence > 8) {
    broadcast('pipeline_complete', {
      taskId,
      pipeline: 'orchestrate',
      mode,
      confidence,
      skippedSynthesis: true,
      duration: Date.now() - startTime,
      message: 'High confidence — synthesis skipped',
    });
    return currentSolution;
  }

  // --- Joint Synthesis: Both models produce synthesis, primary merges ---
  roundNum++;
  const synthesizerSystem = isPlanning
    ? 'You are a synthesis expert. Combine the plan and critiques into one coherent, improved final plan. Use structured markdown format.'
    : 'You are a synthesis expert. Combine the original solution and critiques into one coherent, improved final answer with complete, paste-ready code.';
  const synthesizerUser = `Task: ${task}\n\nOriginal ${isPlanning ? 'plan' : 'solution'}:\n${currentSolution}\n\nCritiques:\n${currentCritique}\n\nSynthesize the final best ${isPlanning ? 'plan' : 'answer'}.`;
  const synthesizerMessages = [
    { role: 'system', content: synthesizerSystem },
    { role: 'user', content: synthesizerUser },
  ];

  // Run synthesis on both models in parallel
  const primarySynthPromise = runAgent(taskId, primary, 'synthesizer', primary, synthesizerMessages, TOKEN_CAP.synthesizer, startTime, roundNum, contextBlock);
  const secondarySynthPromise = runAgent(taskId, secondary, 'synthesizer', secondary, synthesizerMessages, TOKEN_CAP.synthesizer, startTime, roundNum, contextBlock);

  const primarySynth = await primarySynthPromise;
  const secondarySynth = await secondarySynthPromise;

  // If secondary produced something useful and different, have primary do a final merge
  let finalOutput = primarySynth;
  if (secondarySynth && secondarySynth.trim().length > 50 && secondarySynth !== primarySynth) {
    roundNum++;
    const mergeSystem = isPlanning
      ? 'You are a final editor. Take two synthesized plans and produce the single best combined plan. Be concise and complete.'
      : 'You are a final editor. Take two synthesized answers and produce the single best combined answer with complete, paste-ready code.';
    const mergeUser = `Task: ${task}\n\nSynthesis A:\n${primarySynth}\n\nSynthesis B:\n${secondarySynth}\n\nProduce the definitive final output.`;
    const mergeMessages = [
      { role: 'system', content: mergeSystem },
      { role: 'user', content: mergeUser },
    ];
    finalOutput = await runAgent(taskId, primary, 'final-merger', primary, mergeMessages, TOKEN_CAP.synthesizer, startTime, roundNum, contextBlock);
  }

  // Log decision to project memory
  if (finalOutput) {
    await localAgent.logSessionDecision(taskId, PROJECT_NAME, finalOutput.slice(0, 400));
  }

  broadcast('pipeline_complete', {
    taskId,
    pipeline: 'orchestrate',
    mode,
    confidence,
    duration: Date.now() - startTime,
    message: 'Orchestration complete',
  });

  return finalOutput;
}


// ─── Research Pipeline ───
async function runResearchPipeline(taskId, task, primary, secondary, startTime) {
  const { block: contextBlock } = await buildMemoryContext(taskId, task);

  const kimiMessages = [
    { role: 'system', content: 'You are an expert researcher. Investigate the task thoroughly and provide a complete analysis.' },
    { role: 'user', content: `Task: ${task}\n\nPlease research and analyze this completely.` },
  ];

  const claudeMessages = [
    { role: 'system', content: 'You are an expert researcher. Investigate the task thoroughly and provide a complete analysis.' },
    { role: 'user', content: `Task: ${task}\n\nPlease research and analyze this completely.` },
  ];

  const kimiPromise = runAgent(taskId, 'kimi', 'researcher', 'kimi', kimiMessages, TOKEN_CAP.solver, startTime, 1, contextBlock);
  const claudePromise = runAgent(taskId, 'claude', 'researcher', 'claude', claudeMessages, TOKEN_CAP.solver, startTime, 1, contextBlock);

  const kimiResult = await kimiPromise;
  const claudeResult = await claudePromise;

  const synthesizerMessages = [
    { role: 'system', content: 'You are a synthesis expert. Compare two research analyses, identify agreements, disagreements, and gaps. Produce a unified summary. Be concise.' },
    { role: 'user', content: `Task: ${task}\n\nResearch Analysis A:\n${kimiResult}\n\nResearch Analysis B:\n${claudeResult}\n\nPlease synthesize a unified summary.` },
  ];

  await runAgent(taskId, primary, 'synthesizer', primary, synthesizerMessages, TOKEN_CAP.synthesizer, startTime, 2, contextBlock);

  broadcast('pipeline_complete', {
    taskId,
    pipeline: 'research',
    duration: Date.now() - startTime,
    message: 'Research pipeline complete',
  });

  return activeAgents.get(taskId)[primary].output;
}

// ─── Debate Pipeline ───
async function runDebatePipeline(taskId, task, requestedRounds, startTime) {
  const rounds = requestedRounds || 2;
  const { block: contextBlock } = await buildMemoryContext(taskId, task);

  const kimiMessages = [
    { role: 'system', content: 'You are debating this topic. Take a strong position and defend it with evidence and logic.' },
    { role: 'user', content: `Task: ${task}\n\nPresent your opening argument.` },
  ];

  const claudeMessages = [
    { role: 'system', content: 'You are debating this topic. Take the opposing position and defend it with evidence and logic.' },
    { role: 'user', content: `Task: ${task}\n\nPresent your opening argument.` },
  ];

  let kimiPosition = await runAgent(taskId, 'kimi', 'debater', 'kimi', kimiMessages, TOKEN_CAP.solver, startTime, 1, contextBlock);
  let claudePosition = await runAgent(taskId, 'claude', 'debater', 'claude', claudeMessages, TOKEN_CAP.solver, startTime, 1, contextBlock);

  for (let round = 2; round <= rounds + 1; round++) {
    activeAgents.get(taskId).kimi.status = 'thinking';
    activeAgents.get(taskId).claude.status = 'thinking';

    const kimiRebuttal = [
      { role: 'system', content: 'You are in a debate. Rebut the opponent\'s argument forcefully but logically.' },
      { role: 'user', content: `Task: ${task}\n\nYour position:\n${kimiPosition}\n\nOpponent's argument:\n${claudePosition}\n\nProvide your rebuttal.` },
    ];

    const claudeRebuttal = [
      { role: 'system', content: 'You are in a debate. Rebut the opponent\'s argument forcefully but logically.' },
      { role: 'user', content: `Task: ${task}\n\nYour position:\n${claudePosition}\n\nOpponent's argument:\n${kimiPosition}\n\nProvide your rebuttal.` },
    ];

    const kimiPromise = runAgent(taskId, 'kimi', 'rebutter', 'kimi', kimiRebuttal, TOKEN_CAP.critic, startTime, round, contextBlock);
    const claudePromise = runAgent(taskId, 'claude', 'rebutter', 'claude', claudeRebuttal, TOKEN_CAP.critic, startTime, round, contextBlock);

    kimiPosition = await kimiPromise;
    claudePosition = await claudePromise;
  }

  const synthesizerMessages = [
    { role: 'system', content: 'You are a synthesis expert. Analyze both sides of the debate objectively. Identify the strongest points from each side and propose a balanced resolution.' },
    { role: 'user', content: `Task: ${task}\n\nKimi's final position:\n${kimiPosition}\n\nClaude's final position:\n${claudePosition}\n\nSynthesize a balanced final answer.` },
  ];

  await runAgent(taskId, 'kimi', 'synthesizer', 'kimi', synthesizerMessages, TOKEN_CAP.synthesizer, startTime, rounds + 2, contextBlock);

  broadcast('pipeline_complete', {
    taskId,
    pipeline: 'debate',
    rounds,
    duration: Date.now() - startTime,
    message: 'Debate pipeline complete',
  });

  return activeAgents.get(taskId).kimi.output;
}

// ─── Finalize Endpoint (Joint Output) ───
app.post('/api/finalize', async (req, res) => {
  const { task, kimiOutput, claudeOutput, mode = 'code' } = req.body;
  if (!kimiOutput && !claudeOutput) {
    return res.status(400).json({ error: 'At least one AI output is required' });
  }

  const taskId = 'final-' + Date.now().toString(36);
  const startTime = Date.now();

  activeAgents.set(taskId, {
    kimi: { status: 'thinking', output: '', startTime },
    claude: { status: 'thinking', output: '', startTime },
  });

  res.json({ taskId, message: 'Joint finalization started' });

  const { block: contextBlock } = await buildMemoryContext(taskId, task || 'Finalize output');

  // Both AIs refine together
  const kimiMessages = [
    { role: 'system', content: 'You are collaborating with another AI on a final polished output. Incorporate the best ideas from both versions. Produce one unified, production-ready result.' },
    { role: 'user', content: `Task: ${task || 'Finalize the output'}\n\nKimi's version:\n${kimiOutput || '[none]'}\n\nClaude's version:\n${claudeOutput || '[none]'}\n\nProduce the final unified output.` },
  ];

  const claudeMessages = [
    { role: 'system', content: 'You are collaborating with another AI on a final polished output. Incorporate the best ideas from both versions. Produce one unified, production-ready result.' },
    { role: 'user', content: `Task: ${task || 'Finalize the output'}\n\nKimi's version:\n${kimiOutput || '[none]'}\n\nClaude's version:\n${claudeOutput || '[none]'}\n\nProduce the final unified output.` },
  ];

  const kimiPromise = runAgent(taskId, 'kimi', 'finalizer', 'kimi', kimiMessages, TOKEN_CAP.finalizer, startTime, 1, contextBlock);
  const claudePromise = runAgent(taskId, 'claude', 'finalizer', 'claude', claudeMessages, TOKEN_CAP.finalizer, startTime, 1, contextBlock);

  const kimiFinal = await kimiPromise;
  const claudeFinal = await claudePromise;

  // Synthesize the two final versions into one
  const jointMessages = [
    { role: 'system', content: 'You are a final editor. Take two AI-refined versions and produce the single best combined output. Be concise and complete.' },
    { role: 'user', content: `Task: ${task || 'Finalize'}\n\nVersion A:\n${kimiFinal}\n\nVersion B:\n${claudeFinal}\n\nProduce the definitive final output.` },
  ];

  const jointOutput = await runAgent(taskId, mode === 'code' ? 'kimi' : 'claude', 'joint', mode === 'code' ? 'kimi' : 'claude', jointMessages, TOKEN_CAP.finalizer, startTime, 2, contextBlock);

  broadcast('finalize_complete', {
    taskId,
    kimiFinal,
    claudeFinal,
    jointOutput,
    duration: Date.now() - startTime,
  });
});

// ─── Main Orchestrate Endpoint ───
app.post('/api/orchestrate', async (req, res) => {
  const { task, mode = 'code', primaryOverride, planningMode = false, rounds } = req.body;
  if (!task) {
    return res.status(400).json({ error: 'Task is required' });
  }

  const taskId = 'orch-' + Date.now().toString(36);
  const startTime = Date.now();
  const taskType = detectTaskType(task);
  const { primary, secondary } = getModelsForMode(mode, taskType, primaryOverride);

  activeAgents.set(taskId, {
    kimi: { status: 'thinking', output: '', startTime },
    claude: { status: 'thinking', output: '', startTime },
  });

  res.json({
    taskId,
    message: 'Orchestration started',
    mode,
    taskType,
    primary,
    secondary,
    planningMode,
  });

  try {
    let finalOutput = '';
    if (mode === 'research') {
      finalOutput = await runResearchPipeline(taskId, task, primary, secondary, startTime);
    } else if (mode === 'debate') {
      finalOutput = await runDebatePipeline(taskId, task, rounds, startTime);
    } else {
      finalOutput = await runStandardPipeline(taskId, task, mode, primary, secondary, planningMode, rounds, startTime);
    }

    broadcast('final_output', {
      taskId,
      pipeline: 'orchestrate',
      mode,
      output: finalOutput,
      duration: Date.now() - startTime,
    });
  } catch (err) {
    broadcast('error', { taskId, error: err.message });
  }
});

// ─── Compile Plan Endpoint ───
app.post('/api/compile-plan', async (req, res) => {
  const { planText, model = 'claude' } = req.body;
  if (!planText) {
    return res.status(400).json({ error: 'planText is required' });
  }

  const taskId = 'compile-' + Date.now().toString(36);
  const startTime = Date.now();

  activeAgents.set(taskId, {
    kimi: { status: 'thinking', output: '', startTime },
    claude: { status: 'thinking', output: '', startTime },
  });

  res.json({ taskId, message: 'Plan compilation started' });

  const { block: contextBlock } = await buildMemoryContext(taskId, 'Compile plan');

  const messages = [
    { role: 'system', content: 'You are a technical writer. Condense the given plan into clean, token-efficient markdown. Preserve all critical details but remove fluff. Use clear headings and bullet points.' },
    { role: 'user', content: `Please compile this plan into concise markdown:\n\n${planText}` },
  ];

  const output = await runAgent(taskId, model, 'compiler', model, messages, TOKEN_CAP.compiler, startTime, 1, contextBlock);

  broadcast('compile_complete', {
    taskId,
    output,
    duration: Date.now() - startTime,
  });
});

// ─── Legacy Endpoints ───
app.post('/api/role-division', async (req, res) => {
  const { task, primaryOverride } = req.body;
  const taskId = 'role-' + Date.now().toString(36);
  const startTime = Date.now();
  const taskType = detectTaskType(task);
  const { primary, secondary } = getModelsForMode('code', taskType, primaryOverride);

  activeAgents.set(taskId, {
    kimi: { status: 'thinking', output: '', startTime },
    claude: { status: 'thinking', output: '', startTime },
  });

  res.json({ taskId, message: 'Role division pipeline started', taskType, primary, secondary });

  try {
    const output = await runStandardPipeline(taskId, task, 'code', primary, secondary, false, 2, startTime);
    broadcast('final_output', { taskId, pipeline: 'role-division', output, duration: Date.now() - startTime });
  } catch (err) {
    broadcast('error', { taskId, error: err.message });
  }
});

app.post('/api/debate', async (req, res) => {
  const { task, rounds = 2, primaryOverride } = req.body;
  const taskId = 'debate-' + Date.now().toString(36);
  const startTime = Date.now();

  activeAgents.set(taskId, {
    kimi: { status: 'thinking', output: '', startTime },
    claude: { status: 'thinking', output: '', startTime },
  });

  res.json({ taskId, message: 'Debate pipeline started', rounds });

  try {
    const output = await runDebatePipeline(taskId, task, rounds, startTime);
    broadcast('final_output', { taskId, pipeline: 'debate', output, duration: Date.now() - startTime });
  } catch (err) {
    broadcast('error', { taskId, error: err.message });
  }
});

// ─── Memory Endpoints ───
app.get('/api/memory', async (req, res) => {
  const { project = PROJECT_NAME } = req.query;
  try {
    const memory = await memoryManager.getAllMemory(project);
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memory/remember', async (req, res) => {
  const { text, project = PROJECT_NAME, type = 'decision' } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  if (type === 'decision') {
    await memoryManager.addProjectDecision(project, text);
  } else if (type === 'bug') {
    await memoryManager.addProjectBug(project, text);
  } else if (type === 'global') {
    await memoryManager.addGlobalPreference(text);
  }

  res.json({ success: true, type, text });
});

app.post('/api/memory/project', async (req, res) => {
  const { project = PROJECT_NAME, data } = req.body;
  await memoryManager.setProjectMemory(project, data);
  res.json({ success: true });
});

app.post('/api/memory/global', async (req, res) => {
  const { data } = req.body;
  await memoryManager.setGlobalMemory(data);
  res.json({ success: true });
});

// ─── Local Agent Endpoint ───
app.get('/api/local-agent/status', (req, res) => {
  res.json(localAgent.getStatus());
});

// ─── Test Model Endpoint ───
app.post('/api/test-model', async (req, res) => {
  const { model } = req.body;
  if (!model || (model !== 'kimi' && model !== 'claude')) {
    return res.status(400).json({ error: 'model must be "kimi" or "claude"' });
  }

  const url = model === 'kimi' ? KIMI_BASE_URL : CLAUDE_BASE_URL;
  const apiKey = model === 'kimi' ? process.env.KIMI_CODE_API_KEY : process.env.ANTHROPIC_API_KEY;
  const modelName = model === 'kimi' ? KIMI_MODEL : CLAUDE_MODEL;

  if (!apiKey) {
    return res.status(500).json({ error: `${model} API key not configured` });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(model === 'kimi' ? { 'User-Agent': 'KimiCLI/1.5' } : {}),
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say "API test successful" and nothing else.' },
        ],
        max_tokens: 100,
        stream: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: `API returned ${response.status}`, details: text });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ model, status: 'ok', response: content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Todo Board Endpoints ───
app.get('/api/todos', (req, res) => {
  res.json({ todos: todoStore.getAll(), stats: todoStore.getStats(), autoMode: todoStore.autoMode });
});

app.post('/api/todos', async (req, res) => {
  const { type, text, file, line, assignee, priority } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const todo = await todoStore.create({ type, text, file, line, assignee, priority });
  res.json(todo);
});

app.put('/api/todos/:id', async (req, res) => {
  const todo = await todoStore.update(req.params.id, req.body);
  if (!todo) return res.status(404).json({ error: 'Not found' });
  res.json(todo);
});

app.delete('/api/todos/:id', async (req, res) => {
  const ok = await todoStore.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.post('/api/todos/reorder', async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array required' });
  await todoStore.reorder(orderedIds);
  res.json({ success: true });
});

app.post('/api/todos/:id/resolve', async (req, res) => {
  const todo = await todoStore.resolve(req.params.id);
  if (!todo) return res.status(404).json({ error: 'Not found' });
  if (feedStore) await feedStore.logFixmeResolved(todo);
  res.json(todo);
});

app.post('/api/todos/auto/start', async (req, res) => {
  await todoStore.startAuto();
  res.json({ active: true });
});

app.post('/api/todos/auto/stop', (req, res) => {
  todoStore.stopAuto();
  res.json({ active: false });
});

// ─── Feed Endpoints ───
app.get('/api/feed', (req, res) => {
  res.json({ posts: feedStore.getAll() });
});

app.post('/api/feed', async (req, res) => {
  const { author, content, type } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const post = await feedStore.create({ author: author || 'dev', content, type: type || 'manual' });
  res.json(post);
});

app.post('/api/feed/:id/reply', async (req, res) => {
  const { author, content } = req.body;
  const reply = await feedStore.addReply(req.params.id, { author: author || 'dev', content });
  if (!reply) return res.status(404).json({ error: 'Post not found' });
  res.json(reply);
});

app.post('/api/feed/:id/react', async (req, res) => {
  const { emoji, user } = req.body;
  const reactions = await feedStore.addReaction(req.params.id, emoji, user || 'anon');
  if (!reactions) return res.status(404).json({ error: 'Post not found' });
  res.json({ emoji, count: reactions.length });
});

// ─── Public View Endpoint ───
app.get('/api/public', (req, res) => {
  res.json(feedStore.getPublicView());
});

// ─── SSE Stream Endpoint ───
app.get('/api/stream/:taskId', (req, res) => {
  const { taskId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial connected event
  sendSSE(res, 'connected', { message: 'Connected to AI Orchestrator', taskId });

  // Replay any events that were broadcast before this client connected
  flushTaskEventBuffer(taskId, res);

  addSseListener(taskId, res);

  // Heartbeat to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    sendSSE(res, 'heartbeat', {});
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseListener(taskId, res);
  });

  req.on('error', () => {
    clearInterval(heartbeat);
    removeSseListener(taskId, res);
  });
});

// Diagnostic endpoint — shows env state without leaking secrets
app.get('/api/diag', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    keys: {
      kimi: {
        present: !!process.env.KIMI_CODE_API_KEY,
        length: process.env.KIMI_CODE_API_KEY ? process.env.KIMI_CODE_API_KEY.length : 0,
        prefix: process.env.KIMI_CODE_API_KEY ? process.env.KIMI_CODE_API_KEY.slice(0, 10) : null,
      },
      anthropic: {
        present: !!process.env.ANTHROPIC_API_KEY,
        length: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.length : 0,
        prefix: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.slice(0, 10) : null,
      },
    },
    envVarNames: Object.keys(process.env).filter(k => k.includes('KIMI') || k.includes('ANTHROPIC') || k.includes('API_KEY')),
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Roblox Index Endpoints ───

// Receive index from roblox-indexer service
app.post('/api/roblox-index', (req, res) => {
  const { gameName, scripts, hierarchy, stats, indexedAt } = req.body;
  if (!scripts || !Array.isArray(scripts)) {
    return res.status(400).json({ error: 'scripts array required' });
  }

  robloxIndex.gameName = gameName || 'unknown';
  robloxIndex.scripts = scripts;
  robloxIndex.hierarchy = hierarchy || null;
  robloxIndex.stats = stats || { total: scripts.length, byCategory: {} };
  robloxIndex.indexedAt = indexedAt || new Date().toISOString();

  console.log(`[RobloxIndex] Received index for ${robloxIndex.gameName}: ${scripts.length} scripts`);
  broadcast('roblox_index_updated', {
    gameName: robloxIndex.gameName,
    scriptCount: scripts.length,
    indexedAt: robloxIndex.indexedAt,
  });

  res.json({ message: 'Index received', scripts: scripts.length, game: robloxIndex.gameName });
});

// Get current Roblox index
app.get('/api/roblox-index', (req, res) => {
  res.json(robloxIndex);
});

// Search Roblox scripts
app.get('/api/roblox-index/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter required' });
  if (robloxIndex.scripts.length === 0) return res.status(404).json({ error: 'No index available' });

  const query = q.toLowerCase();
  const results = robloxIndex.scripts.filter((s) =>
    s.name.toLowerCase().includes(query) ||
    s.summary.toLowerCase().includes(query) ||
    s.category.toLowerCase().includes(query) ||
    s.path.toLowerCase().includes(query)
  );

  res.json({ query: q, count: results.length, results: results.slice(0, 20) });
});

// Find relevant scripts for a task
app.get('/api/roblox-index/relevant', (req, res) => {
  const { task } = req.query;
  if (!task) return res.status(400).json({ error: 'task parameter required' });
  if (robloxIndex.scripts.length === 0) return res.status(404).json({ error: 'No index available' });

  // Simple keyword relevance scoring
  const taskWords = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const scored = robloxIndex.scripts.map((s) => {
    const text = `${s.name} ${s.summary} ${s.category}`.toLowerCase();
    let score = 0;
    for (const word of taskWords) {
      if (text.includes(word)) score += 1;
    }
    // Boost exact category matches
    if (taskWords.some((w) => s.category.toLowerCase().includes(w))) score += 3;
    return { ...s, score };
  });

  const top = scored.sort((a, b) => b.score - a.score).slice(0, 10);
  res.json({ task, count: top.length, results: top });
});

// ─── Server Startup ───
server.listen(PORT, async () => {
  console.log(`AI Orchestrator backend running on port ${PORT}`);
  console.log(`WebSocket server ready for connections`);

  // Start local agent
  await localAgent.start();

  // Startup API tests
  console.log('Running startup API tests...');

  const testModel = async (model) => {
    const url = model === 'kimi' ? KIMI_BASE_URL : CLAUDE_BASE_URL;
    const apiKey = model === 'kimi' ? process.env.KIMI_CODE_API_KEY : process.env.ANTHROPIC_API_KEY;
    const modelName = model === 'kimi' ? KIMI_MODEL : CLAUDE_MODEL;

    if (!apiKey) {
      console.log(`  ${model}: SKIPPED (no API key)`);
      return;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...(model === 'kimi' ? { 'User-Agent': 'KimiCLI/1.5' } : {}),
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Say "test ok" and nothing else.' },
          ],
          max_tokens: 100,
          stream: false,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.log(`  ${model}: FAILED (${response.status}) - ${text.slice(0, 200)}`);
        return;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim() || '';
      console.log(`  ${model}: OK (${content})`);
    } catch (err) {
      console.log(`  ${model}: ERROR - ${err.message}`);
    }
  };

  await testModel('kimi');
  await testModel('claude');
  console.log('Startup tests complete.');
});
