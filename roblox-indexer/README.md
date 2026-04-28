# Roblox Indexer Service

Indexes your Roblox Studio game via MCP, summarizes every script with Ollama, and syncs to your Railway backend.

## Setup

### 1. Install Ollama + Model

```bash
# Install Ollama from https://ollama.ai

# Pull the coder model
ollama pull qwen2.5-coder:7b
```

### 2. Install Dependencies

```bash
cd roblox-indexer
npm install
```

### 3. Configure

Edit `config.json`:

```json
{
  "gameName": "Chisld",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@anthropic-ai/mcp-proxy"]
  },
  "ollama": {
    "url": "http://localhost:11434/api/generate",
    "model": "qwen2.5-coder:7b"
  },
  "railway": {
    "backendUrl": "https://your-railway-app.up.railway.app",
    "apiKey": "",
    "autoSync": true
  }
}
```

### 4. Start the Service

```bash
# Start the REST API (default port 3002)
npm start

# One-shot index and exit
npm run index

# Auto-rescan every 5 minutes
npm run dev
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service status |
| `GET /index` | Full current index |
| `GET /search?q=query` | Search scripts by name/summary/category |
| `GET /relevant?task=...` | AI-ranked relevance to a task |
| `POST /rescan` | Trigger full re-index |
| `POST /sync` | Manually sync to Railway |
| `POST /import` | Import index manually (testing) |

## How It Works

1. **Connects to Roblox Studio MCP** — Queries the full game hierarchy and all Script/LocalScript/ModuleScript instances
2. **Reads each script** — Pulls the full source code via MCP
3. **Summarizes with Ollama** — Sends each script to `qwen2.5-coder:7b` for a one-sentence summary + category tag
4. **Saves locally** — Persists as JSON to `./indexes/Chisld-latest.json`
5. **Syncs to Railway** — POSTs the full index to your backend's `/api/roblox-index`
6. **Injects into AI context** — Before every orchestration, the backend finds relevant scripts and injects them into Kimi & Claude's system prompts
