'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = ''; // Relative paths — Next.js rewrites proxy to Railway backend
const WS_URL = process.env.NEXT_PUBLIC_AI_GATEWAY_WS_URL || 'ws://localhost:3001';

function formatDuration(ms) {
  if (!ms || ms < 0) return '0.0s';
  return (ms / 1000).toFixed(1) + 's';
}

/* ───────── Tooltip ───────── */
function Tooltip({ text, children }) {
  return (
    <span className="tooltip-wrapper">
      {children}
      <span className="tooltip-box">{text}</span>
    </span>
  );
}

/* ───────── Status Badge ───────── */
function StatusBadge({ type, children }) {
  const map = {
    success: 'badge-success',
    warning: 'badge-warning',
    error: 'badge-error',
    info: 'badge-info',
    neutral: 'badge-neutral',
  };
  return <span className={`badge ${map[type] || 'badge-neutral'}`}>{children}</span>;
}

/* ───────── Collapsible Section ───────── */
function CollapsibleSection({ title, icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <div className="section-header">
        <div className="section-title">
          <span>{icon}</span>
          {title}
        </div>
        <button className="collapse-btn" onClick={() => setOpen(!open)}>
          {open ? '− Collapse' : '+ Expand'}
        </button>
      </div>
      <div className={`collapsible-content ${open ? '' : 'collapsed'}`}>{children}</div>
    </div>
  );
}

/* ───────── Typewriter ───────── */
function TypewriterText({ text, speed = 10 }) {
  const [displayed, setDisplayed] = useState('');
  const idx = useRef(0);
  useEffect(() => {
    setDisplayed('');
    idx.current = 0;
    if (!text) return;
    const interval = setInterval(() => {
      idx.current += 1;
      setDisplayed(text.slice(0, idx.current));
      if (idx.current >= text.length) clearInterval(interval);
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed]);
  return <span>{displayed}</span>;
}

/* ───────── Agent Card ───────── */
function AgentCard({ agentKey, agent, taskId }) {
  const outputRef = useRef(null);
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [agent.output]);

  const isKimi = agentKey === 'kimi';
  const status = agent.status || 'thinking';

  const statusType =
    status === 'complete' ? 'success' :
    status === 'error' ? 'error' :
    status === 'streaming' ? 'info' :
    'warning';

  return (
    <div className={`agent-card ${isKimi ? 'kimi' : 'claude'} ${status === 'streaming' ? 'streaming' : ''}`}>
      <div className="agent-header">
        <div className="agent-name">
          <div className="agent-icon">{isKimi ? '🌙' : '⚡'}</div>
          {isKimi ? 'Kimi' : 'Claude'}
        </div>
        <StatusBadge type={statusType}>
          {status === 'thinking' && '⏳ '}
          {status === 'streaming' && '● '}
          {status === 'complete' && '✓ '}
          {status === 'error' && '✕ '}
          {status}
        </StatusBadge>
      </div>
      <div className="agent-meta">
        <div className="meta-item">🆔 <span>{taskId.slice(0, 16)}...</span></div>
        <div className="meta-item">🎭 <span>{agent.role || '—'}</span></div>
        <div className="meta-item">🤖 <span>{agent.model || '—'}</span></div>
        {agent.round !== undefined && <div className="meta-item">🔄 <span>{agent.round}</span></div>}
        <div className="meta-item">⏱️ <span>{formatDuration(agent.duration)}</span></div>
        <div className="meta-item">📝 <span>{(agent.output || '').length.toLocaleString()}</span></div>
      </div>
      <div className="agent-output" ref={outputRef}>
        {agent.output || <span style={{ color: 'var(--text-muted)' }}>Waiting for output...</span>}
      </div>
    </div>
  );
}

/* ───────── Dashboard Page ───────── */
function DashboardPage({
  task, setTask, mode, setMode, primaryOverride, setPrimaryOverride,
  planningMode, setPlanningMode, confidence, currentRound, loading,
  agents, compiledOutput, showTypewriter, isCompiling,
  finalOutput, showFinalOutput,
  handleOrchestrate, handleDebate, handleCompilePlan, handleFinalize, handleRemember,
  planCardRef, compiledBoxRef
}) {
  const agentList = Object.values(agents);
  const hasPlan = agentList.some((a) => a.role === 'synthesizer' && a.status === 'complete');
  const synthOut = agentList.find((a) => a.role === 'synthesizer')?.output || '';

  return (
    <>
      <div className="task-section card">
        <div className="section-header">
          <div className="section-title">
            <span>📝</span>
            Task Description
            <Tooltip text="Describe the coding task, design problem, or question you want the AIs to tackle.">
              <button className="tooltip-trigger">?</button>
            </Tooltip>
          </div>
        </div>
        <textarea
          className="task-input"
          placeholder="e.g., Build a React authentication hook with JWT refresh tokens..."
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />

        <div className="controls-grid">
          <div className="control-card">
            <label className="control-label">
              Workflow Mode
              <Tooltip text="Determines which AI is primary and the pipeline structure. Code=Kimi primary, Planning=Claude primary, Content=Claude primary, Research=parallel, Debate=opposing sides.">
                <button className="tooltip-trigger">?</button>
              </Tooltip>
            </label>
            <select className="control-select" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="code">💻 Code — Kimi drafts, Claude reviews</option>
              <option value="planning">🏗️ Planning — Claude architects, Kimi stress-tests</option>
              <option value="content">📝 Content — Claude writes, Kimi edits</option>
              <option value="research">🔬 Research — Both investigate, then synthesize</option>
              <option value="debate">⚔️ Debate — Opposing sides forced</option>
            </select>
          </div>

          <div className="control-card">
            <label className="control-label">
              Primary Model
              <Tooltip text="Override which AI leads the session. Auto picks based on task type and workflow mode.">
                <button className="tooltip-trigger">?</button>
              </Tooltip>
            </label>
            <select className="control-select" value={primaryOverride} onChange={(e) => setPrimaryOverride(e.target.value)}>
              <option value="auto">🎯 Auto-detect</option>
              <option value="kimi">🌙 Kimi (always primary)</option>
              <option value="claude">⚡ Claude (always primary)</option>
            </select>
          </div>

          <div className="control-card">
            <label className="control-label">
              Planning Mode
              <Tooltip text="Forces multi-round debate (3–5 rounds) with devil's advocate. Output is a structured plan: Objective, Stack, Steps, Constraints, Success Criteria.">
                <button className="tooltip-trigger">?</button>
              </Tooltip>
            </label>
            <label className="toggle-row">
              <div className="toggle-switch">
                <input type="checkbox" checked={planningMode} onChange={(e) => setPlanningMode(e.target.checked)} />
                <span className="toggle-slider" />
              </div>
              <span className="toggle-label-text">{planningMode ? 'On' : 'Off'}</span>
            </label>
          </div>
        </div>

        {(confidence !== null || currentRound > 0) && (
          <div className="pipeline-bar">
            {currentRound > 0 && (
              <StatusBadge type="info">🔄 Round {currentRound}</StatusBadge>
            )}
            {confidence !== null && (
              <StatusBadge type={confidence >= 8 ? 'success' : confidence >= 6 ? 'warning' : 'error'}>
                🎯 Confidence: {confidence}/10
                <Tooltip text="The critic rates the solution 1–10. Below 6 triggers an extra revision round. Above 8 skips synthesis and uses the solver output directly.">
                  <button className="tooltip-trigger">?</button>
                </Tooltip>
              </StatusBadge>
            )}
            {planningMode && <StatusBadge type="info">🗺️ Planning Pipeline</StatusBadge>}
          </div>
        )}

        <div className="button-group" style={{ marginTop: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleOrchestrate} disabled={loading || !task.trim()}>
            {loading ? '⏳ Running...' : '🚀 Orchestrate'}
          </button>
          <button className="btn btn-secondary" onClick={handleDebate} disabled={loading || !task.trim()}>
            {loading ? '⏳ Running...' : '⚔️ Debate Mode'}
          </button>
          {Object.values(agents).some((a) => a.status === 'complete') && (
            <button className="btn btn-ghost" onClick={handleFinalize} disabled={loading}>
              {loading ? '⏳ Finalizing...' : '🔒 Finalize Joint Output'}
            </button>
          )}
        </div>
      </div>

      <div className="agents-section">
        <CollapsibleSection title="Live Agents" icon="🤖" defaultOpen={true}>
          {agentList.length === 0 ? (
            <div className="empty-state">
              <h3>No active agents</h3>
              <p>Enter a task and click a button to start the orchestration.</p>
            </div>
          ) : (
            <div className="agents-grid">
              {agentList.map((agent) => (
                <AgentCard key={`${agent.taskId}-${agent.agent}`} agentKey={agent.agent} agent={agent} taskId={agent.taskId} />
              ))}
            </div>
          )}
        </CollapsibleSection>
      </div>

      {(mode === 'planning' || planningMode) && hasPlan && (
        <div className="plan-section">
          <CollapsibleSection title="Structured Plan" icon="🗺️" defaultOpen={true}>
            <div className="plan-pipeline">
              <div className="plan-card" ref={planCardRef}>
                <div className="plan-header">
                  <span>📋</span>
                  Synthesized Plan
                </div>
                <div className="plan-body">
                  <pre>{synthOut}</pre>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={handleCompilePlan} disabled={isCompiling || !synthOut.trim()}>
                    {isCompiling ? '⏳ Compiling...' : '🔨 Compile Plan'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => handleRemember(synthOut, 'decision')}>
                    💾 Remember
                  </button>
                </div>
              </div>

              <div className="plan-arrow">
                <div className="arrow-line" />
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>▼</div>
              </div>

              <div className="compiled-box" ref={compiledBoxRef}>
                <div className="compiled-header">
                  <span>📄</span>
                  Compiled Markdown
                </div>
                <div className="compiled-body">
                  {showTypewriter ? (
                    <TypewriterText text={compiledOutput} speed={8} />
                  ) : compiledOutput ? (
                    <pre>{compiledOutput}</pre>
                  ) : (
                    <span className="compiled-placeholder">Compiled plan will appear here after clicking Compile Plan...</span>
                  )}
                </div>
              </div>
            </div>
          </CollapsibleSection>
        </div>
      )}

      {showFinalOutput && finalOutput && (
        <div className="plan-section">
          <CollapsibleSection title="Final Joint Output" icon="🔒" defaultOpen={true}>
            <div className="plan-card">
              <div className="plan-header">
                <span>🔒</span>
                Both AIs Collaborated
                <Tooltip text="This output was produced by having both Kimi and Claude refine their individual results, then synthesizing one definitive final version.">
                  <button className="tooltip-trigger">?</button>
                </Tooltip>
              </div>
              <div className="plan-body">
                <pre>{finalOutput}</pre>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(finalOutput); }}>
                  📋 Copy
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => handleRemember(finalOutput, 'decision')}>
                  💾 Remember
                </button>
              </div>
            </div>
          </CollapsibleSection>
        </div>
      )}
    </>
  );
}

/* ───────── API Config Page ───────── */
function ApiConfigPage() {
  const [kimiUrl, setKimiUrl] = useState('https://api.kimi.com/coding/v1/chat/completions');
  const [kimiModel, setKimiModel] = useState('kimi-for-coding');
  const [kimiKey, setKimiKey] = useState('');
  const [claudeUrl, setClaudeUrl] = useState('https://api.anthropic.com/v1/chat/completions');
  const [claudeModel, setClaudeModel] = useState('claude-sonnet-4-5');
  const [claudeKey, setClaudeKey] = useState('');
  const [kimiTest, setKimiTest] = useState(null);
  const [claudeTest, setClaudeTest] = useState(null);
  const [testing, setTesting] = useState({ kimi: false, claude: false });

  const runTest = async (model) => {
    setTesting((t) => ({ ...t, [model]: true }));
    setKimiTest(null);
    setClaudeTest(null);
    try {
      const res = await fetch(`${API_BASE}/api/test-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const data = await res.json();
      if (res.ok) {
        if (model === 'kimi') setKimiTest({ ok: true, msg: data.response || 'Connected' });
        else setClaudeTest({ ok: true, msg: data.response || 'Connected' });
      } else {
        if (model === 'kimi') setKimiTest({ ok: false, msg: data.error || 'Failed' });
        else setClaudeTest({ ok: false, msg: data.error || 'Failed' });
      }
    } catch (err) {
      if (model === 'kimi') setKimiTest({ ok: false, msg: err.message });
      else setClaudeTest({ ok: false, msg: err.message });
    }
    setTesting((t) => ({ ...t, [model]: false }));
  };

  return (
    <div className="config-grid">
      <div className="card">
        <div className="section-header">
          <div className="section-title">
            <span>🌙</span>
            Kimi Configuration
          </div>
        </div>
        <div className="config-field">
          <label>Base URL <Tooltip text="The OpenAI-compatible chat completions endpoint for Kimi Code."><button className="tooltip-trigger">?</button></Tooltip></label>
          <input className="config-input" value={kimiUrl} onChange={(e) => setKimiUrl(e.target.value)} />
        </div>
        <div className="config-field">
          <label>Model Name <Tooltip text="The model identifier sent to the API. For Kimi Code, this is typically 'kimi-for-coding'."><button className="tooltip-trigger">?</button></Tooltip></label>
          <input className="config-input" value={kimiModel} onChange={(e) => setKimiModel(e.target.value)} />
        </div>
        <div className="config-field">
          <label>API Key <Tooltip text="Your Kimi Code API key. Stored in the backend .env file as KIMI_CODE_API_KEY."><button className="tooltip-trigger">?</button></Tooltip></label>
          <input className="config-input" type="password" placeholder="sk-kimi-..." value={kimiKey} onChange={(e) => setKimiKey(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => runTest('kimi')} disabled={testing.kimi}>
          {testing.kimi ? '⏳ Testing...' : '🔌 Test Connection'}
        </button>
        {kimiTest && (
          <div className={`test-result ${kimiTest.ok ? 'success' : 'error'}`}>
            {kimiTest.ok ? '✓' : '✕'} {kimiTest.msg}
          </div>
        )}
      </div>

      <div className="card">
        <div className="section-header">
          <div className="section-title">
            <span>⚡</span>
            Claude Configuration
          </div>
        </div>
        <div className="config-field">
          <label>Base URL <Tooltip text="The OpenAI-compatible chat completions endpoint for Anthropic."><button className="tooltip-trigger">?</button></Tooltip></label>
          <input className="config-input" value={claudeUrl} onChange={(e) => setClaudeUrl(e.target.value)} />
        </div>
        <div className="config-field">
          <label>Model Name <Tooltip text="The model identifier. For Claude Sonnet 4.5, this is 'claude-sonnet-4-5'."><button className="tooltip-trigger">?</button></Tooltip></label>
          <input className="config-input" value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)} />
        </div>
        <div className="config-field">
          <label>API Key <Tooltip text="Your Anthropic API key. Stored in the backend .env file as ANTHROPIC_API_KEY."><button className="tooltip-trigger">?</button></Tooltip></label>
          <input className="config-input" type="password" placeholder="sk-ant-..." value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => runTest('claude')} disabled={testing.claude}>
          {testing.claude ? '⏳ Testing...' : '🔌 Test Connection'}
        </button>
        {claudeTest && (
          <div className={`test-result ${claudeTest.ok ? 'success' : 'error'}`}>
            {claudeTest.ok ? '✓' : '✕'} {claudeTest.msg}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────── Help Page ───────── */
function HelpPage() {
  return (
    <div className="help-page">
      <div className="help-card">
        <h3>🎯 Pipeline Modes</h3>
        <table className="help-table">
          <thead>
            <tr><th>Mode</th><th>Primary</th><th>Secondary</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td>💻 Code</td><td>Kimi</td><td>Claude</td><td>Kimi drafts code, Claude reviews for bugs and style.</td></tr>
            <tr><td>🏗️ Planning</td><td>Claude</td><td>Kimi</td><td>Claude architects the solution, Kimi stress-tests the plan.</td></tr>
            <tr><td>📝 Content</td><td>Claude</td><td>Kimi</td><td>Claude writes content, Kimi edits for clarity and tone.</td></tr>
            <tr><td>🔬 Research</td><td>Both</td><td>—</td><td>Both AIs investigate independently, then results are synthesized.</td></tr>
            <tr><td>⚔️ Debate</td><td>Both</td><td>—</td><td>AIs take opposing sides and argue back and forth.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="help-card">
        <h3>🎭 Agent Roles</h3>
        <table className="help-table">
          <thead>
            <tr><th>Role</th><th>Token Cap</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td>Solver / Architect</td><td>2,000</td><td>Generates the initial solution or structured plan.</td></tr>
            <tr><td>Critic / Devil's Advocate</td><td>800</td><td>Reviews the output, identifies flaws, assigns a confidence score.</td></tr>
            <tr><td>Synthesizer</td><td>600</td><td>Merges the best ideas from primary and secondary into a final output.</td></tr>
            <tr><td>Compiler</td><td>600</td><td>Condenses a plan into token-efficient markdown.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="help-card">
        <h3>📊 Confidence Score</h3>
        <p>The critic outputs a self-assessed confidence rating from 1–10.</p>
        <table className="help-table">
          <thead>
            <tr><th>Score</th><th>Behavior</th></tr>
          </thead>
          <tbody>
            <tr><td>≥ 8</td><td>High confidence — synthesis step is skipped to save tokens.</td></tr>
            <tr><td>6 – 7</td><td>Medium confidence — normal synthesis proceeds.</td></tr>
            <tr><td>&lt; 6</td><td>Low confidence — an extra revision round is triggered automatically.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="help-card">
        <h3>🗺️ Planning Mode</h3>
        <p>When enabled, the pipeline forces 3–5 rounds and includes a dedicated devil's advocate round.</p>
        <p>The final plan is structured into five sections:</p>
        <ul style={{ marginLeft: 20, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          <li><strong>Objective</strong> — What the plan aims to achieve</li>
          <li><strong>Stack</strong> — Technologies and tools recommended</li>
          <li><strong>Steps</strong> — Ordered implementation steps</li>
          <li><strong>Constraints</strong> — Limitations, risks, and boundaries</li>
          <li><strong>Success Criteria</strong> — How to measure completion</li>
        </ul>
      </div>

      <div className="help-card">
        <h3>🚀 Getting Started</h3>
        <p>1. Enter a task in the <strong>Task Description</strong> box.</p>
        <p>2. Choose a <strong>Workflow Mode</strong> (or leave on Auto).</p>
        <p>3. Click <strong>Orchestrate</strong> to run the full pipeline, or <strong>Debate</strong> for opposing viewpoints.</p>
        <p>4. Watch the <strong>Live Agents</strong> panel for real-time output.</p>
        <p>5. In Planning Mode, click <strong>Compile Plan</strong> to condense the plan into markdown.</p>
        <p>6. Go to <strong>API Config</strong> to test your API keys if a model fails.</p>
      </div>
    </div>
  );
}

/* ───────── Memory Page ───────── */
function MemoryPage({ memory, localAgentStatus, onRemember }) {
  const [rememberText, setRememberText] = useState('');
  const [rememberType, setRememberType] = useState('decision');

  return (
    <div className="help-page">
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">
            <span>💾</span>
            Remember This
            <Tooltip text="Manually save a decision, bug, or preference to the persistent memory store.">
              <button className="tooltip-trigger">?</button>
            </Tooltip>
          </div>
        </div>
        <textarea
          className="task-input"
          style={{ minHeight: 60 }}
          placeholder="e.g., Use React Query for all server state..."
          value={rememberText}
          onChange={(e) => setRememberText(e.target.value)}
        />
        <div className="controls-grid" style={{ marginTop: 10 }}>
          <select className="control-select" value={rememberType} onChange={(e) => setRememberType(e.target.value)}>
            <option value="decision">📋 Project Decision</option>
            <option value="bug">🐛 Known Bug</option>
            <option value="global">🌍 Global Preference</option>
          </select>
          <button className="btn btn-primary btn-sm" onClick={() => { onRemember(rememberText, rememberType); setRememberText(''); }} disabled={!rememberText.trim()}>
            💾 Save to Memory
          </button>
        </div>
      </div>

      <div className="config-grid">
        <div className="card">
          <div className="section-header">
            <div className="section-title"><span>🌍</span> Global Memory</div>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            <p><strong>Coding Style:</strong> {memory.global?.codingStyle || '—'}</p>
            <p><strong>Preferences:</strong></p>
            <ul style={{ marginLeft: 20 }}>
              {memory.global?.preferences?.length ? memory.global.preferences.map((p, i) => (
                <li key={i}>{p}</li>
              )) : <li style={{ color: 'var(--text-muted)' }}>None saved yet</li>}
            </ul>
            <p><strong>Active Systems:</strong> {memory.global?.activeSystems?.join(', ') || '—'}</p>
          </div>
        </div>

        <div className="card">
          <div className="section-header">
            <div className="section-title"><span>📁</span> Project Memory</div>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
            <p><strong>Project:</strong> {memory.project?.name || '—'}</p>
            <p><strong>Stack:</strong> {memory.project?.stack || '—'}</p>
            <p><strong>Decisions:</strong></p>
            <ul style={{ marginLeft: 20 }}>
              {memory.project?.decisions?.length ? memory.project.decisions.slice(-5).map((d, i) => (
                <li key={i}>{d.text} <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>({new Date(d.created).toLocaleDateString()})</span></li>
              )) : <li style={{ color: 'var(--text-muted)' }}>None saved yet</li>}
            </ul>
            <p><strong>Known Bugs:</strong></p>
            <ul style={{ marginLeft: 20 }}>
              {memory.project?.knownBugs?.length ? memory.project.knownBugs.slice(-5).map((b, i) => (
                <li key={i}>{b.text} <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>({new Date(b.created).toLocaleDateString()})</span></li>
              )) : <li style={{ color: 'var(--text-muted)' }}>None recorded</li>}
            </ul>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="section-header">
          <div className="section-title"><span>🤖</span> Local AI Agent Status</div>
        </div>
        <div className="pipeline-bar">
          <StatusBadge type={localAgentStatus.available ? 'success' : 'error'}>
            {localAgentStatus.available ? '🟢 Online' : '🔴 Offline'}
          </StatusBadge>
          {localAgentStatus.available && (
            <>
              <StatusBadge type="info">📁 {localAgentStatus.watchedFiles || 0} files watched</StatusBadge>
              <StatusBadge type="warning">📝 {localAgentStatus.todoCount || 0} TODOs</StatusBadge>
              <StatusBadge type="success">📊 {localAgentStatus.progress || 0}% progress</StatusBadge>
              {localAgentStatus.model && <StatusBadge type="neutral">🧠 {localAgentStatus.model}</StatusBadge>}
            </>
          )}
        </div>
        {!localAgentStatus.available && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: 10 }}>
            Local agent requires <a href="https://ollama.com" target="_blank" rel="noreferrer" style={{ color: 'var(--info)' }}>Ollama</a> running with <code>qwen2.5:3b</code> or <code>llama3.2:3b</code>.
          </p>
        )}
      </div>
    </div>
  );
}

/* ───────── Settings Page ───────── */
function SettingsPage({ theme, setTheme }) {
  return (
    <div className="config-grid">
      <div className="card">
        <div className="section-header">
          <div className="section-title">
            <span>🎨</span>
            Appearance
          </div>
        </div>
        <div className="config-field">
          <label>Theme</label>
          <div className="toggle-row">
            <div className="toggle-switch">
              <input type="checkbox" checked={theme === 'light'} onChange={(e) => setTheme(e.target.checked ? 'light' : 'dark')} />
              <span className="toggle-slider" />
            </div>
            <span className="toggle-label-text">{theme === 'light' ? '☀️ Light Mode' : '🌙 Dark Mode'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Board Page ───────── */
function BoardPage({ todos, stats, autoMode, activeTodoId, userRole, onRefresh, wsStatus }) {
  const [menuOpen, setMenuOpen] = useState(null);
  const [newText, setNewText] = useState('');
  const [newType, setNewType] = useState('TODO');
  const [draggedTodo, setDraggedTodo] = useState(null);
  const menuRef = useRef(null);

  const isOwner = userRole === 'owner';

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleDragStart = (e, todo) => {
    e.dataTransfer.setData('text/plain', todo.id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggedTodo(todo);
  };

  const handleDragEnd = () => {
    setDraggedTodo(null);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e, targetId) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    setDraggedTodo(null);
    if (!draggedId || draggedId === targetId) return;
    const currentIds = todos.map((t) => t.id);
    const fromIdx = currentIds.indexOf(draggedId);
    const toIdx = currentIds.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...currentIds];
    reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, draggedId);
    try {
      const res = await fetch(`${API_BASE}/api/todos/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: reordered }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefresh();
    } catch (err) {
      console.error('Reorder failed:', err);
      alert('Failed to reorder. Backend may be down.');
    }
  };

  const createTodo = async () => {
    if (!newText.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/api/todos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: newType, text: newText, priority: 'medium' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNewText('');
      onRefresh();
    } catch (err) {
      console.error('Create failed:', err);
      alert('Failed to create card. Backend may be down.');
    }
  };

  const updateTodo = async (id, updates) => {
    try {
      const res = await fetch(`${API_BASE}/api/todos/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefresh();
    } catch (err) {
      console.error('Update failed:', err);
      alert('Failed to update card. Backend may be down.');
    }
    setMenuOpen(null);
  };

  const deleteTodo = async (id) => {
    if (!window.confirm('Delete this card?')) return;
    try {
      const res = await fetch(`${API_BASE}/api/todos/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefresh();
    } catch (err) {
      console.error('Delete failed:', err);
      alert('Failed to delete card. Backend may be down.');
    }
    setMenuOpen(null);
  };

  const resolveTodo = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/todos/${id}/resolve`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefresh();
    } catch (err) {
      console.error('Resolve failed:', err);
      alert('Failed to resolve card. Backend may be down.');
    }
    setMenuOpen(null);
  };

  const toggleAuto = async () => {
    try {
      const endpoint = autoMode
        ? `${API_BASE}/api/todos/auto/stop`
        : `${API_BASE}/api/todos/auto/start`;
      const res = await fetch(endpoint, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefresh();
    } catch (err) {
      console.error('Auto mode toggle failed:', err);
      alert('Failed to toggle auto mode. Backend may be down.');
    }
  };

  const priorityColor = (p) => ({ high: 'var(--error)', medium: 'var(--warning)', low: 'var(--text-muted)' }[p] || 'var(--text-muted)');

  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">
            <span>📋</span>
            Todo & Fixme Board
            <Tooltip text="Drag cards to reorder the AI work queue. FIXMEs are red, TODOs are blue.">
              <button className="tooltip-trigger">?</button>
            </Tooltip>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <StatusBadge type="error">🔴 {stats.fixme || 0} FIXME</StatusBadge>
            <StatusBadge type="info">🔵 {stats.todo || 0} TODO</StatusBadge>
            <StatusBadge type="success">✓ {stats.resolved || 0} Done</StatusBadge>
            {isOwner && (
              <button className={`btn btn-sm ${autoMode ? 'btn-primary' : 'btn-secondary'}`} onClick={toggleAuto}>
                {autoMode ? '⏸ Pause Auto' : '▶ Auto Mode'}
              </button>
            )}
          </div>
        </div>

        {autoMode && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ height: 6, backgroundColor: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${stats.total > 0 ? Math.round(((stats.active + stats.resolved) / stats.total) * 100) : 0}%`, height: '100%', backgroundColor: 'var(--success)', transition: 'width 0.5s' }} />
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Auto mode active — working through queue
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <input
            className="config-input"
            style={{ flex: 1 }}
            placeholder="Add new task..."
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
          />
          <select className="control-select" value={newType} onChange={(e) => setNewType(e.target.value)}>
            <option value="TODO">TODO</option>
            <option value="FIXME">FIXME</option>
          </select>
          <button className="btn btn-primary btn-sm" onClick={createTodo} disabled={!newText.trim()}>Add</button>
        </div>

        <div className="board-grid">
          {todos.length === 0 && (
            <div className="empty-state" style={{ padding: '32px' }}>
              <p>No cards yet. Add one above or let the local AI scan your files.</p>
            </div>
          )}
          {todos.map((todo) => (
            <div
              key={todo.id}
              className={`todo-card ${(todo.type || '').toLowerCase()} ${todo.status === 'active' ? 'active-card' : ''} ${draggedTodo?.id === todo.id ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => handleDragStart(e, todo)}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, todo.id)}
            >
              <div className="todo-card-header">
                <span className="todo-badge" style={{ backgroundColor: todo.type === 'FIXME' ? 'var(--error-bg)' : 'var(--info-bg)', color: todo.type === 'FIXME' ? 'var(--error)' : 'var(--info)' }}>
                  {todo.type}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {todo.file ? `${todo.file}${todo.line ? `:${todo.line}` : ''}` : 'Manual'}
                </span>
                <div style={{ position: 'relative' }} ref={menuOpen === todo.id ? menuRef : null}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setMenuOpen(menuOpen === todo.id ? null : todo.id)}>⋮</button>
                  {menuOpen === todo.id && (
                    <div className="dropdown-menu">
                      {isOwner && todo.status !== 'resolved' && (
                        <button onClick={() => { setMenuOpen(null); }}>🤖 Fix with AI</button>
                      )}
                      <button onClick={() => updateTodo(todo.id, { priority: (todo.priority || 'medium') === 'high' ? 'medium' : 'high' })}>
                        {(todo.priority || 'medium') === 'high' ? '↓ Lower Priority' : '↑ Raise Priority'}
                      </button>
                      {todo.status !== 'resolved' && (
                        <button onClick={() => resolveTodo(todo.id)}>✓ Mark Resolved</button>
                      )}
                      <button onClick={() => deleteTodo(todo.id)}>🗑 Delete</button>
                    </div>
                  )}
                </div>
              </div>
              <div className="todo-card-body">{todo.text}</div>
              <div className="todo-card-footer">
                <span style={{ color: priorityColor(todo.priority || 'medium'), fontSize: '0.75rem', fontWeight: 600 }}>
                  {(todo.priority || 'medium').toUpperCase()}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                  {new Date(todo.timestamp).toLocaleDateString()}
                </span>
                {todo.assignee && (
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>👤 {todo.assignee}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────── Feed Page ───────── */
function FeedPage({ posts, onRefresh, userRole }) {
  const [newPost, setNewPost] = useState('');
  const [replyText, setReplyText] = useState('');
  const [replyingTo, setReplyingTo] = useState(null);

  const isDev = userRole === 'owner' || userRole === 'dev';

  const createPost = async () => {
    if (!newPost.trim()) return;
    await fetch(`${API_BASE}/api/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newPost, author: userRole }),
    });
    setNewPost('');
    onRefresh();
  };

  const addReply = async (postId) => {
    if (!replyText.trim()) return;
    await fetch(`${API_BASE}/api/feed/${postId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: replyText, author: userRole }),
    });
    setReplyText('');
    setReplyingTo(null);
    onRefresh();
  };

  const react = async (postId, emoji) => {
    await fetch(`${API_BASE}/api/feed/${postId}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji, user: userRole }),
    });
    onRefresh();
  };

  return (
    <div>
      {isDev && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <div className="section-title"><span>📝</span> New Post</div>
          </div>
          <textarea className="task-input" style={{ minHeight: 60 }} placeholder="Share an update, question, or note..." value={newPost} onChange={(e) => setNewPost(e.target.value)} />
          <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={createPost} disabled={!newPost.trim()}>Post</button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {posts.length === 0 && (
          <div className="empty-state">
            <p>No posts yet. Start the conversation!</p>
          </div>
        )}
        {posts.map((post) => (
          <div key={post.id} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="agent-icon" style={{ width: 28, height: 28, fontSize: '0.9rem' }}>
                  {post.author === 'system' ? '🤖' : '👤'}
                </span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{post.author}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{new Date(post.timestamp).toLocaleString()}</div>
                </div>
              </div>
              {post.type !== 'manual' && (
                <StatusBadge type={post.type === 'fixme_resolved' ? 'success' : post.type === 'todo_detected' ? 'warning' : 'info'}>
                  {post.type.replace(/_/g, ' ')}
                </StatusBadge>
              )}
            </div>
            <div style={{ color: 'var(--text-primary)', fontSize: '0.95rem', lineHeight: 1.5, marginBottom: 10 }}>
              {post.content}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['👍', '🔥', '👏', '💡'].map((emoji) => {
                const count = post.reactions?.[emoji]?.length || 0;
                return (
                  <button key={emoji} className="btn btn-ghost btn-sm" onClick={() => react(post.id, emoji)}>
                    {emoji} {count > 0 ? count : ''}
                  </button>
                );
              })}
              {isDev && (
                <button className="btn btn-ghost btn-sm" onClick={() => setReplyingTo(replyingTo === post.id ? null : post.id)}>
                  💬 Reply
                </button>
              )}
            </div>

            {post.replies?.length > 0 && (
              <div style={{ marginTop: 12, paddingLeft: 16, borderLeft: '2px solid var(--border-color)' }}>
                {post.replies.map((reply) => (
                  <div key={reply.id} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <strong>{reply.author}</strong> · {new Date(reply.timestamp).toLocaleString()}
                    </div>
                    <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{reply.content}</div>
                  </div>
                ))}
              </div>
            )}

            {replyingTo === post.id && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <input className="config-input" style={{ flex: 1 }} placeholder="Write a reply..." value={replyText} onChange={(e) => setReplyText(e.target.value)} />
                <button className="btn btn-primary btn-sm" onClick={() => addReply(post.id)} disabled={!replyText.trim()}>Reply</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── Public Page ───────── */
function PublicPage({ publicView }) {
  if (!publicView) {
    return (
      <div className="empty-state">
        <p>Loading public view...</p>
      </div>
    );
  }

  return (
    <div className="help-page">
      <div className="card">
        <div className="section-header">
          <div className="section-title"><span>🎮</span> {publicView.gameName || 'Project'}</div>
          <StatusBadge type="info">v{publicView.version}</StatusBadge>
        </div>
        <div className="pipeline-bar">
          <StatusBadge type="success">✓ {publicView.stats?.resolved || 0} Issues Resolved</StatusBadge>
          <StatusBadge type="warning">📝 {publicView.stats?.totalTodos || 0} Open Items</StatusBadge>
          <StatusBadge type="info">🏗️ {publicView.stats?.planningSessions || 0} Planning Sessions</StatusBadge>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 10 }}>
          Last updated: {new Date(publicView.lastUpdated).toLocaleString()}
        </p>
      </div>

      <div className="help-card">
        <h3>🗺️ Roadmap</h3>
        {publicView.roadmap?.length ? (
          <table className="help-table">
            <thead><tr><th>Feature</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              {publicView.roadmap.map((item, i) => (
                <tr key={i}><td>{item.title}</td><td>{item.status}</td><td>{new Date(item.date).toLocaleDateString()}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <p style={{ color: 'var(--text-muted)' }}>No roadmap items yet.</p>}
      </div>

      <div className="help-card">
        <h3>📝 Patch Notes</h3>
        {publicView.patchNotes?.length ? (
          <ul style={{ marginLeft: 20, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            {publicView.patchNotes.map((note, i) => (
              <li key={i}><strong>{new Date(note.date).toLocaleDateString()}</strong> — {note.text}</li>
            ))}
          </ul>
        ) : <p style={{ color: 'var(--text-muted)' }}>No patch notes yet.</p>}
      </div>

      <div className="help-card">
        <h3>🐛 Known Issues</h3>
        {publicView.knownIssues?.length ? (
          <ul style={{ marginLeft: 20, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            {publicView.knownIssues.map((issue, i) => (
              <li key={i}>{issue.text} <StatusBadge type="warning">{issue.severity}</StatusBadge></li>
            ))}
          </ul>
        ) : <p style={{ color: 'var(--text-muted)' }}>No known issues. Great job!</p>}
      </div>
    </div>
  );
}

/* ───────── Main App ───────── */
export default function Dashboard() {
  const [theme, setTheme] = useState('dark');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [task, setTask] = useState('');
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [agents, setAgents] = useState({});
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [primaryOverride, setPrimaryOverride] = useState('auto');
  const [mode, setMode] = useState('code');
  const [planningMode, setPlanningMode] = useState(false);
  const [confidence, setConfidence] = useState(null);
  const [currentRound, setCurrentRound] = useState(0);
  const [compiledOutput, setCompiledOutput] = useState('');
  const [isCompiling, setIsCompiling] = useState(false);
  const [showTypewriter, setShowTypewriter] = useState(false);
  const [memory, setMemory] = useState({ global: {}, project: {}, session: '' });
  const [localAgentStatus, setLocalAgentStatus] = useState({ available: false, watchedFiles: 0, todoCount: 0, progress: 0 });
  const [finalOutput, setFinalOutput] = useState('');
  const [showFinalOutput, setShowFinalOutput] = useState(false);
  const [todos, setTodos] = useState([]);
  const [todoStats, setTodoStats] = useState({ total: 0, open: 0, active: 0, resolved: 0 });
  const [autoMode, setAutoMode] = useState(false);
  const [activeTodoId, setActiveTodoId] = useState(null);
  const [feedPosts, setFeedPosts] = useState([]);
  const [publicView, setPublicView] = useState(null);
  const [userRole, setUserRole] = useState('owner'); // owner | dev | viewer

  const wsRef = useRef(null);
  const logsRef = useRef(null);
  const planCardRef = useRef(null);
  const compiledBoxRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Poll memory and local agent status
  useEffect(() => {
    const fetchMemory = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/memory`);
        if (res.ok) setMemory(await res.json());
      } catch { /* ignore */ }
    };
    const fetchLocalStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/local-agent/status`);
        if (res.ok) setLocalAgentStatus(await res.json());
      } catch { /* ignore */ }
    };
    fetchMemory();
    fetchLocalStatus();
    const interval = setInterval(() => {
      fetchMemory();
      fetchLocalStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const addLog = useCallback((event, data, timestamp) => {
    setLogs((prev) => [
      ...prev,
      { id: Date.now() + Math.random(), event, data, time: timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString() },
    ]);
  }, []);

  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setWsStatus('connected');
      ws.onmessage = (message) => {
        try {
          const { event, data, timestamp } = JSON.parse(message.data);
          addLog(event, data, timestamp);

          if (event === 'agent_start') {
            const key = `${data.taskId}-${data.agent}`;
            setAgents((prev) => ({
              ...prev,
              [key]: { ...prev[key], taskId: data.taskId, agent: data.agent, role: data.role, model: data.model || prev[key]?.model, round: data.round, status: 'streaming', output: prev[key]?.output || '', startTime: prev[key]?.startTime || Date.now() },
            }));
            if (data.round) setCurrentRound(data.round);
          }
          if (event === 'agent_stream') {
            const key = `${data.taskId}-${data.agent}`;
            setAgents((prev) => ({
              ...prev,
              [key]: { ...prev[key], taskId: data.taskId, agent: data.agent, role: data.role, round: data.round, status: 'streaming', output: data.fullText || '', duration: data.duration },
            }));
          }
          if (event === 'agent_complete') {
            const key = `${data.taskId}-${data.agent}`;
            setAgents((prev) => ({
              ...prev,
              [key]: { ...prev[key], taskId: data.taskId, agent: data.agent, role: data.role, round: data.round, status: 'complete', output: data.fullText || prev[key]?.output || '', duration: data.duration },
            }));
          }
          if (event === 'confidence_update') {
            setConfidence(data.confidence);
            setCurrentRound(data.round);
          }
          if (event === 'pipeline_complete' || event === 'debate_complete' || event === 'final_output') {
            setLoading(false);
          }
          if (event === 'compile_complete') {
            setIsCompiling(false);
            setCompiledOutput(data.output);
            setShowTypewriter(true);
          }
          if (event === 'finalize_complete') {
            setLoading(false);
            setFinalOutput(data.jointOutput);
            setShowFinalOutput(true);
          }
          if (event === 'local_agent_status') {
            setLocalAgentStatus((prev) => ({ ...prev, ...data }));
          }
          if (event.startsWith('todo_')) {
            fetchTodos();
          }
          if (event === 'feed_post' || event === 'feed_reply' || event === 'feed_reaction') {
            fetchFeed();
          }
          if (event === 'auto_mode') {
            setAutoMode(data.active);
            setActiveTodoId(data.currentId || null);
          }
          if (event === 'error') {
            setLoading(false);
            setIsCompiling(false);
          }
        } catch {
          // ignore
        }
      };
      ws.onclose = () => {
        setWsStatus('disconnected');
        setTimeout(connect, 3000);
      };
      ws.onerror = () => setWsStatus('disconnected');
    }
    connect();
    return () => { if (wsRef.current) wsRef.current.close(); };
  }, [addLog]);

  const fetchTodos = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/todos`);
      if (res.ok) {
        const data = await res.json();
        setTodos(data.todos);
        setTodoStats(data.stats);
        setAutoMode(data.autoMode);
      }
    } catch { /* ignore */ }
  };

  const fetchFeed = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/feed`);
      if (res.ok) {
        const data = await res.json();
        setFeedPosts(data.posts);
      }
    } catch { /* ignore */ }
  };

  const fetchPublicView = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/public`);
      if (res.ok) setPublicView(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchTodos();
    fetchFeed();
    fetchPublicView();
    const interval = setInterval(() => {
      fetchTodos();
      fetchFeed();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleOrchestrate = async () => {
    if (!task.trim()) return;
    setLoading(true);
    setConfidence(null);
    setCurrentRound(0);
    setCompiledOutput('');
    setShowTypewriter(false);
    try {
      await fetch(`${API_BASE}/api/orchestrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, mode, primaryOverride, planningMode, rounds: planningMode ? 4 : 2 }),
      });
    } catch (err) {
      addLog('error', { message: err.message });
      setLoading(false);
    }
  };

  const handleDebate = async () => {
    if (!task.trim()) return;
    setLoading(true);
    setConfidence(null);
    setCurrentRound(0);
    setCompiledOutput('');
    setShowTypewriter(false);
    try {
      await fetch(`${API_BASE}/api/debate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task, rounds: 2, primaryOverride }),
      });
    } catch (err) {
      addLog('error', { message: err.message });
      setLoading(false);
    }
  };

  const handleFinalize = async () => {
    const agentList = Object.values(agents);
    const kimiAgent = agentList.find((a) => a.agent === 'kimi' && a.status === 'complete');
    const claudeAgent = agentList.find((a) => a.agent === 'claude' && a.status === 'complete');
    if (!kimiAgent && !claudeAgent) return;

    setLoading(true);
    try {
      await fetch(`${API_BASE}/api/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          kimiOutput: kimiAgent?.output || '',
          claudeOutput: claudeAgent?.output || '',
          mode,
        }),
      });
    } catch (err) {
      addLog('error', { message: err.message });
      setLoading(false);
    }
  };

  const handleRemember = async (text, type = 'decision') => {
    if (!text.trim()) return;
    try {
      await fetch(`${API_BASE}/api/memory/remember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, type }),
      });
      // Refresh memory
      const res = await fetch(`${API_BASE}/api/memory`);
      if (res.ok) setMemory(await res.json());
    } catch (err) {
      addLog('error', { message: err.message });
    }
  };

  const handleCompilePlan = async () => {
    const agentList = Object.values(agents);
    const synthesizer = agentList.find((a) => a.role === 'synthesizer');
    const planText = synthesizer?.output || '';
    if (!planText.trim()) return;
    setIsCompiling(true);
    setShowTypewriter(false);
    setCompiledOutput('');

    // Animation
    const planEl = planCardRef.current;
    const boxEl = compiledBoxRef.current;
    if (planEl && boxEl) {
      const planRect = planEl.getBoundingClientRect();
      const boxRect = boxEl.getBoundingClientRect();
      const sx = window.scrollX;
      const sy = window.scrollY;
      const clone = planEl.cloneNode(true);
      clone.classList.add('flying-plan-card');
      clone.style.left = `${planRect.left + sx}px`;
      clone.style.top = `${planRect.top + sy}px`;
      clone.style.width = `${planRect.width}px`;
      clone.style.height = `${planRect.height}px`;
      document.body.appendChild(clone);
      clone.getBoundingClientRect();
      requestAnimationFrame(() => {
        const dx = boxRect.left + sx - (planRect.left + sx);
        const dy = boxRect.top + sy - (planRect.top + sy);
        const scX = boxRect.width / planRect.width;
        const scY = boxRect.height / planRect.height;
        clone.style.transform = `translate(${dx}px, ${dy}px) scale(${scX}, ${scY})`;
        clone.style.opacity = '0.3';
      });
      setTimeout(() => {
        clone.remove();
        if (boxEl) {
          boxEl.classList.add('pulse-box');
          setTimeout(() => boxEl.classList.remove('pulse-box'), 1200);
        }
      }, 800);
    }

    try {
      await fetch(`${API_BASE}/api/compile-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planText, model: mode === 'planning' ? 'claude' : 'kimi' }),
      });
    } catch (err) {
      addLog('error', { message: err.message });
      setIsCompiling(false);
    }
  };

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'board', label: 'Board', icon: '📋' },
    { id: 'feed', label: 'Feed', icon: '💬' },
    { id: 'memory', label: 'Memory', icon: '🧠' },
    { id: 'api', label: 'API Config', icon: '🔌' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
    { id: 'help', label: 'Help', icon: '❓' },
  ];

  return (
    <div className="app-container">
      <nav className="top-nav">
        <div className="nav-brand">
          <span className="nav-brand-icon">🧠</span>
          <span>Multi-AI Orchestrator</span>
        </div>
        <div className="nav-links">
          {tabs.map((t) => (
            <button key={t.id} className={`nav-link ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="nav-actions">
          {localAgentStatus.available && (
            <Tooltip text={`Local AI watching ${localAgentStatus.watchedFiles || 0} files • ${localAgentStatus.todoCount || 0} TODOs`}>
              <span className="badge badge-success" style={{ cursor: 'default' }}>🤖 Local AI</span>
            </Tooltip>
          )}
          <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <div className={`conn-status ${wsStatus === 'connected' ? 'online' : 'offline'}`}>
            <span className="status-dot" />
            {wsStatus === 'connected' ? 'Connected' : 'Disconnected'}
          </div>
        </div>
      </nav>

      <div className="main-layout">
        <aside className="sidebar">
          {tabs.map((t) => (
            <button key={t.id} className={`sidebar-item ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
              <span className="sidebar-item-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </aside>

        <main className="content-area">
          {activeTab === 'dashboard' && (
            <DashboardPage
              task={task} setTask={setTask}
              mode={mode} setMode={setMode}
              primaryOverride={primaryOverride} setPrimaryOverride={setPrimaryOverride}
              planningMode={planningMode} setPlanningMode={setPlanningMode}
              confidence={confidence} currentRound={currentRound}
              loading={loading} agents={agents}
              compiledOutput={compiledOutput} showTypewriter={showTypewriter}
              isCompiling={isCompiling}
              finalOutput={finalOutput} showFinalOutput={showFinalOutput}
              handleOrchestrate={handleOrchestrate}
              handleDebate={handleDebate}
              handleCompilePlan={handleCompilePlan}
              handleFinalize={handleFinalize}
              handleRemember={handleRemember}
              planCardRef={planCardRef}
              compiledBoxRef={compiledBoxRef}
            />
          )}
          {activeTab === 'memory' && <MemoryPage memory={memory} localAgentStatus={localAgentStatus} onRemember={handleRemember} />}
          {activeTab === 'board' && (
            <BoardPage
              todos={todos}
              stats={todoStats}
              autoMode={autoMode}
              activeTodoId={activeTodoId}
              userRole={userRole}
              onRefresh={fetchTodos}
              wsStatus={wsStatus}
            />
          )}
          {activeTab === 'feed' && (
            <FeedPage posts={feedPosts} onRefresh={fetchFeed} userRole={userRole} />
          )}
          {activeTab === 'public' && <PublicPage publicView={publicView} />}
          {activeTab === 'api' && <ApiConfigPage />}
          {activeTab === 'settings' && <SettingsPage theme={theme} setTheme={setTheme} />}
          {activeTab === 'help' && <HelpPage />}

          {/* Event Log — shown on all tabs */}
          <div className="logs-section">
            <CollapsibleSection title="Event Log" icon="📡" defaultOpen={false}>
              <div className="log-list" ref={logsRef}>
                {logs.length === 0 ? (
                  <div className="empty-state" style={{ padding: '20px' }}>
                    <p>Waiting for events...</p>
                  </div>
                ) : (
                  logs.map((log) => (
                    <div className="log-entry" key={log.id}>
                      <span className="log-time">{log.time}</span>
                      <span className={`log-event ${log.event}`}>{log.event}</span>
                      <span className="log-message">
                        {log.data?.agent && `[${log.data.agent}] `}
                        {log.data?.role && `{${log.data.role}} `}
                        {log.data?.round !== undefined && `(R${log.data.round}) `}
                        {log.data?.confidence !== undefined && `C:${log.data.confidence} `}
                        {log.data?.message || log.data?.error || JSON.stringify(log.data).slice(0, 120)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </CollapsibleSection>
          </div>
        </main>
      </div>
    </div>
  );
}


