#!/usr/bin/env node

/**
 * check-ollama.mjs — Quick connectivity check for Ollama
 *
 * Verifies that Ollama is running and the configured model is available.
 *
 * Usage:
 *   npm run ollama:check
 *   OLLAMA_BASE_URL=http://host:11434 OLLAMA_MODEL=mistral:7b npm run ollama:check
 */

const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const model = process.env.OLLAMA_MODEL || 'llama3.1:8b';

async function main() {
  console.log(`Checking Ollama at ${baseUrl} (model: ${model})...\n`);

  let data;
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.error(`✗ Ollama returned HTTP ${resp.status}. Is it running?`);
      console.error(`  Start with: ollama serve`);
      process.exit(1);
    }
    data = await resp.json();
  } catch (err) {
    console.error(`✗ Ollama not reachable at ${baseUrl}: ${err.message}`);
    console.error(`  Start with: ollama serve`);
    console.error(`  Override URL: OLLAMA_BASE_URL=http://... npm run ollama:check`);
    process.exit(1);
  }

  const models = (data.models || []).map((m) => m.name);
  console.log(`✓ Ollama is running. Available models: ${models.join(', ') || '(none)'}\n`);

  const hasModel = models.some((m) => m === model || m === `${model}:latest`);
  if (!hasModel) {
    console.error(`✗ Model '${model}' not found locally.`);
    console.error(`  Pull it with: ollama pull ${model}`);
    process.exit(1);
  }

  console.log(`✓ Model '${model}' is available. You're ready to run:`);
  console.log(`  ./batch/batch-runner.sh --provider ollama`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
