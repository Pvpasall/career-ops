# Ollama Integration

career-ops supports local LLMs via [Ollama](https://ollama.com) as an alternative to Claude for **batch job evaluation**. This lets you process offers with no API costs and full data privacy — everything runs on your own machine.

## When to use Ollama vs Claude

| | Claude (`claude -p`) | Ollama |
|--|--|--|
| Cost | Claude Max subscription | Free (runs locally) |
| Privacy | Data sent to Anthropic | Fully local |
| Quality | Best-in-class | Good — depends on model |
| PDF generation | ✅ | ❌ |
| Real-time web search | ✅ | ❌ (training data only) |
| Speed | Fast API | Depends on hardware |
| Interactive mode (`claude`) | ✅ | ❌ |

> **Note:** Ollama integration only covers **batch processing** (`batch-runner.sh --provider ollama`).
> Interactive sessions (`claude`, `/career-ops scan`, etc.) always use Claude Code.

## Prerequisites

- [Ollama](https://ollama.com/download) installed and running
- A model pulled locally (see recommendations below)
- Node.js 18+ (already required by career-ops)

## Quick Start

### 1. Install and start Ollama

```bash
# macOS
brew install ollama
ollama serve

# Linux
curl -fsSL https://ollama.com/install.sh | sh
ollama serve
```

### 2. Pull a model

```bash
# Recommended: good balance of quality and speed on most hardware
ollama pull llama3.1:8b

# Better quality, needs more RAM (16 GB+)
ollama pull llama3.1:70b

# Fastest, lower quality (good for quick filtering)
ollama pull qwen2.5:7b

# Excellent coding/reasoning, 8 GB RAM
ollama pull mistral:7b
```

### 3. Verify Ollama is reachable

```bash
npm run ollama:check
```

### 4. Configure career-ops (optional)

By default the worker connects to `http://localhost:11434` and uses `llama3.1:8b`.
You can override this via environment variables or by editing `config/profile.yml`.

**Option A — environment variables (recommended for quick tests):**

```bash
export OLLAMA_BASE_URL=http://localhost:11434
export OLLAMA_MODEL=llama3.1:8b
export OLLAMA_TEMPERATURE=0.7
```

**Option B — `config/profile.yml`:**

Uncomment and fill in the `llm` section:

```yaml
llm:
  provider: ollama
  ollama:
    base_url: "http://localhost:11434"
    model: "llama3.1:8b"
    temperature: 0.7
```

When `provider: ollama` is set in `profile.yml`, `npm run doctor` will also check Ollama connectivity.

### 5. Run batch with Ollama

```bash
# Add offers to batch/batch-input.tsv first, then:
./batch/batch-runner.sh --provider ollama

# Or use the env var
CAREER_OPS_PROVIDER=ollama ./batch/batch-runner.sh

# Dry run to preview what will be processed
./batch/batch-runner.sh --provider ollama --dry-run

# Use a different model for this run
OLLAMA_MODEL=mistral:7b ./batch/batch-runner.sh --provider ollama
```

## Model Recommendations

| Model | RAM | Speed | Quality | Best for |
|---|---|---|---|---|
| `llama3.1:8b` | 8 GB | Fast | Good | Daily use, quick filtering |
| `llama3.1:70b` | 40 GB | Slow | Excellent | Final evaluations |
| `mistral:7b` | 6 GB | Fast | Good | Quick scans |
| `qwen2.5:7b` | 6 GB | Fast | Good | Low RAM machines |
| `deepseek-r1:8b` | 8 GB | Medium | Very good | Reasoning-heavy evaluation |

Run `ollama list` to see your locally installed models.

## What Works in Ollama Mode

- ✅ Job offer evaluation (all 6 blocks: A–F)
- ✅ Scoring (1–5 scale)
- ✅ Report generation (`reports/*.md`)
- ✅ Tracker line generation (TSV)
- ✅ Resumable batch processing (state file)
- ✅ Parallel workers (`--parallel N`)
- ❌ PDF generation (requires Claude's HTML generation capability)
- ❌ Real-time comp/salary research (uses model training data instead)
- ❌ Offer liveness verification (Playwright still works, but the worker doesn't call it)

## Troubleshooting

### "Ollama not reachable at http://localhost:11434"

Make sure Ollama is running:

```bash
ollama serve
# or check if it's already running
curl http://localhost:11434/api/tags
```

### "Model 'llama3.1:8b' not found"

Pull the model first:

```bash
ollama pull llama3.1:8b
```

Or use a different model:

```bash
OLLAMA_MODEL=mistral:7b ./batch/batch-runner.sh --provider ollama
```

### Response quality is poor

Try a larger model or lower temperature:

```bash
OLLAMA_MODEL=llama3.1:70b OLLAMA_TEMPERATURE=0.3 ./batch/batch-runner.sh --provider ollama
```

### Worker times out

Large models on CPU can be slow. The worker waits up to 10 minutes per offer.
For very slow hardware, process offers sequentially (default `--parallel 1`).

### JD cannot be fetched

Some job boards block automated requests. Pre-fetch the JD manually:

```bash
curl -sL "https://example.com/job/123" > /tmp/batch-jd-1.txt
```

Then add the offer to `batch/batch-input.tsv` — the worker will read the local file automatically.
