const fetch = require('node-fetch');

class OllamaClient {
  constructor(config) {
    this.url = config.url || 'http://localhost:11434/api/generate';
    this.model = config.model || 'qwen2.5-coder:7b';
    this.timeout = config.timeout || 30000;
  }

  async generate(prompt, maxTokens = 100) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: { num_predict: maxTokens, temperature: 0.2 },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama HTTP ${res.status}: ${text}`);
      }

      const data = await res.json();
      return (data.response || '').trim();
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error('Ollama request timed out');
      }
      throw err;
    }
  }

  async summarizeScript(scriptName, scriptContent) {
    const snippet = scriptContent.slice(0, 3000);
    const prompt = `You are a code analysis engine. Analyze this Roblox Lua script and provide:
1. A one-sentence summary of what it does
2. A category tag from this list: combat, networking, UI, utility, data, animation, physics, economy, social, admin, unknown

Respond ONLY in this format:
SUMMARY: one sentence
CATEGORY: tag

Script: ${scriptName}
\`\`\`lua
${snippet}
\`\`\``;

    const response = await this.generate(prompt, 120);
    const summaryMatch = response.match(/SUMMARY:\s*(.+)/i);
    const categoryMatch = response.match(/CATEGORY:\s*(\w+)/i);

    return {
      summary: summaryMatch?.[1]?.trim() || 'No summary generated',
      category: categoryMatch?.[1]?.trim().toLowerCase() || 'unknown',
      raw: response,
    };
  }

  async isAvailable() {
    try {
      const res = await fetch('http://localhost:11434/api/tags', { timeout: 3000 });
      if (!res.ok) return false;
      const data = await res.json();
      const models = data.models?.map((m) => m.name) || [];
      return models.includes(this.model);
    } catch {
      return false;
    }
  }
}

module.exports = { OllamaClient };
