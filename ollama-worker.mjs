#!/usr/bin/env node

/**
 * ollama-worker.mjs — Ollama-based batch worker for career-ops
 *
 * Replaces `claude -p` workers when using a local Ollama instance.
 * Uses Ollama's OpenAI-compatible API to evaluate job offers.
 *
 * Usage (called by batch-runner.sh with --provider ollama):
 *   node ollama-worker.mjs --id 1 --url https://... --report-num 001 --date 2026-04-07
 *   node ollama-worker.mjs --id 1 --url https://... --report-num 001 --date 2026-04-07 --jd-file /tmp/jd.txt
 *
 * Environment variables:
 *   OLLAMA_BASE_URL      Base URL of Ollama instance (default: http://localhost:11434)
 *   OLLAMA_MODEL         Model to use (default: llama3.1:8b)
 *   OLLAMA_TEMPERATURE   Sampling temperature (default: 0.7)
 *
 * Limitations vs claude -p workers:
 *   - No PDF generation (requires Playwright + HTML generation from Claude)
 *   - JD must be publicly accessible or pre-fetched to --jd-file
 *   - No real-time comp research (model uses training data only)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const OLLAMA_TEMPERATURE = parseFloat(process.env.OLLAMA_TEMPERATURE || '0.7');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      result[key] = args[i + 1] ?? true;
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function readFile(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JD fetching
// ---------------------------------------------------------------------------

async function fetchJD(url, jdFile) {
  // 1. Try pre-fetched local file first
  if (jdFile && existsSync(jdFile)) {
    const content = readFileSync(jdFile, 'utf8').trim();
    if (content.length > 100) return content;
  }

  // 2. Fetch from URL
  if (!url || url === 'N/A') return null;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)',
        Accept: 'text/html,text/plain',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) return null;

    const html = await resp.text();

    // Strip scripts, styles and tags for a plain-text approximation
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, 12000); // cap at 12 K chars to stay within context
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ollama API
// ---------------------------------------------------------------------------

async function callOllama(systemPrompt, userMessage) {
  const url = `${OLLAMA_BASE_URL}/v1/chat/completions`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: OLLAMA_TEMPERATURE,
      stream: false,
    }),
    signal: AbortSignal.timeout(600000), // 10 min — local models can be slow
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ollama API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function extractJSON(text) {
  // Find the last occurrence of a JSON object containing "company" and "score".
  // Walk backwards through all '{' positions to find a balanced match that
  // parses cleanly — this handles nested objects in the model output.
  let lastIdx = -1;
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf('{', searchFrom);
    if (idx === -1) break;
    if (/"company"/.test(text.slice(idx)) && /"score"/.test(text.slice(idx))) {
      lastIdx = idx;
    }
    searchFrom = idx + 1;
  }
  if (lastIdx === -1) return null;

  // Find the matching closing brace (balanced)
  let depth = 0;
  let end = -1;
  for (let i = lastIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  try {
    return JSON.parse(text.slice(lastIdx, end + 1));
  } catch {
    return null;
  }
}

function extractScore(text) {
  // Match "| **Global** | **4.2/5** |" or similar table rows
  const patterns = [
    /\*\*Global\*\*[^|\n]*\|\s*\*?\*?(\d+(?:\.\d+)?)\*?\*?/i,
    /Global[^|\n]*\|\s*\*?\*?(\d+(?:\.\d+)?)\/5/i,
    /"score"\s*:\s*(\d+(?:\.\d+)?)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function calcNextTrackerNum() {
  const appPath = join(projectRoot, 'data', 'applications.md');
  if (!existsSync(appPath)) return 1;

  const lines = readFileSync(appPath, 'utf8').split('\n');
  let max = 0;
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1]?.trim();
    const n = parseInt(cell, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// Error output helper
// ---------------------------------------------------------------------------

function failWith(id, reportNum, message) {
  process.stderr.write(
    JSON.stringify({
      status: 'failed',
      id: id ?? 'unknown',
      report_num: reportNum ?? 'unknown',
      company: 'unknown',
      role: 'unknown',
      score: null,
      pdf: null,
      report: null,
      error: message,
    }) + '\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const { id, url, reportNum, date, jdFile } = args;

  if (!id || !reportNum || !date) {
    failWith(id, reportNum, 'Missing required args: --id, --url, --report-num, --date');
  }

  // Read context files
  const cvContent = readFile(join(projectRoot, 'cv.md'));
  if (!cvContent) failWith(id, reportNum, 'cv.md not found in project root');

  const profileYml = readFile(join(projectRoot, 'config', 'profile.yml')) ?? '';
  const articleDigest = readFile(join(projectRoot, 'article-digest.md')) ?? '';
  const sharedMd = readFile(join(projectRoot, 'modes', '_shared.md')) ?? '';
  const profileMd = readFile(join(projectRoot, 'modes', '_profile.md')) ?? '';

  // Fetch job description
  const jdContent = await fetchJD(url, jdFile);
  if (!jdContent) failWith(id, reportNum, `Could not obtain JD from url=${url} jdFile=${jdFile}`);

  // Build system prompt
  const systemPrompt = `You are a job offer evaluator working on behalf of a software engineering candidate.
Your goal is to produce a thorough, honest evaluation of a job offer against the candidate's CV and profile.

## Scoring Dimensions (each 1–5, higher = better fit)

| Dimension            | Description |
|----------------------|-------------|
| Match con CV         | Skills, experience and proof-point alignment |
| North Star alignment | Fit with candidate's target archetypes |
| Comp                 | Salary vs market (5 = top quartile) |
| Cultural signals     | Company culture, stability, remote policy |
| Red flags            | Blockers / warnings (apply as negative adjustment) |
| **Global**           | Weighted composite (report as X.X / 5) |

## Scoring Guidance
- 4.5+ → Strong match — recommend applying immediately
- 4.0–4.4 → Good match — worth applying
- 3.5–3.9 → Decent but not ideal — apply only if specific reason
- Below 3.5 → Recommend against applying

## Required Output Format

Produce a complete markdown evaluation report with this structure (fill in all sections):

\`\`\`markdown
# Evaluación: {Company} — {Role}

**Fecha:** ${date}
**Arquetipo:** {detected archetype}
**Score:** {X.X}/5
**URL:** ${url ?? 'N/A'}
**PDF:** ❌ (Ollama mode — PDF generation not available)
**Batch ID:** ${id}

---

## A) Role Summary

[Table with: Archetype, Domain, Function, Seniority, Remote policy, Team size, TL;DR]

## B) CV Match

[Table mapping each JD requirement to exact CV lines. Include gaps section.]

## C) Level & Strategy

[Detected JD level vs candidate level, positioning strategy, how to frame experience.]

## D) Comp & Demand

[Use your training data for salary benchmarks. Score comp 1–5 and explain.]

## E) Personalization Plan

[Top 5 CV changes + Top 5 LinkedIn changes tailored to this offer.]

## F) Interview Plan

[6–10 STAR stories mapped to JD requirements, 1 recommended case study.]

## Global Score

| Dimension            | Score |
|----------------------|-------|
| Match con CV         | X/5   |
| North Star Alignment | X/5   |
| Comp                 | X/5   |
| Cultural Signals     | X/5   |
| Red Flags            | -X    |
| **Global**           | **X.X/5** |

## Keywords

[15–20 ATS keywords extracted from the JD]
\`\`\`

After the markdown report, output ONLY the following JSON block (no extra text):

{"company": "CompanyName", "role": "Job Title", "score": 4.2, "note": "One-sentence fit summary"}`;

  const contextParts = [
    `## Candidate CV\n\n${cvContent}`,
    articleDigest ? `## Proof Points (article-digest.md)\n\n${articleDigest}` : null,
    profileYml ? `## Profile Config (profile.yml)\n\n${profileYml}` : null,
    profileMd ? `## User Archetypes & Narrative (_profile.md)\n\n${profileMd}` : null,
    `## Job Description\n\nURL: ${url ?? 'N/A'}\n\n${jdContent}`,
    'Evaluate the job offer above for the candidate. Cite exact CV lines when matching. Be direct and specific.',
  ];

  const userMessage = contextParts.filter(Boolean).join('\n\n---\n\n');

  // Call Ollama
  let rawResponse;
  try {
    rawResponse = await callOllama(systemPrompt, userMessage);
  } catch (err) {
    failWith(id, reportNum, `Ollama API error: ${err.message}`);
  }

  // Split report from trailing JSON
  // The model may or may not include the marker; try both
  const markerIdx = rawResponse.lastIndexOf('{"company"');
  const reportSection = markerIdx > 0 ? rawResponse.slice(0, markerIdx).trim() : rawResponse.trim();
  const jsonSection = markerIdx > 0 ? rawResponse.slice(markerIdx) : rawResponse;

  const meta = extractJSON(jsonSection) ?? extractJSON(rawResponse);

  const company = meta?.company ?? 'Unknown Company';
  const role = meta?.role ?? 'Unknown Role';
  const score = meta?.score ?? extractScore(reportSection);
  const note = meta?.note ?? (score ? `Score ${score}/5` : 'Evaluation complete');

  const companySlug = slugify(company);
  const reportFileName = `${reportNum}-${companySlug}-${date}.md`;
  const reportPath = join(projectRoot, 'reports', reportFileName);

  // Ensure report starts with a proper header (model may skip it)
  let finalReport = reportSection;
  // Accept both Spanish "Evaluación" and English "Evaluation" headers
  if (!finalReport.match(/^#\s+Evaluaci[oó]n|^#\s+Evaluation/i)) {
    finalReport =
      `# Evaluación: ${company} — ${role}\n\n` +
      `**Fecha:** ${date}\n` +
      `**Score:** ${score ?? 'N/A'}/5\n` +
      `**URL:** ${url ?? 'N/A'}\n` +
      `**PDF:** ❌ (Ollama mode)\n` +
      `**Batch ID:** ${id}\n\n---\n\n` +
      finalReport;
  }

  // Write report
  mkdirSync(join(projectRoot, 'reports'), { recursive: true });
  writeFileSync(reportPath, finalReport, 'utf8');

  // Write tracker TSV
  const trackerDir = join(projectRoot, 'batch', 'tracker-additions');
  mkdirSync(trackerDir, { recursive: true });

  const nextNum = calcNextTrackerNum();
  const tsvLine = [
    nextNum,
    date,
    company,
    role,
    'Evaluated',
    score != null ? `${score}/5` : 'N/A',
    '❌',
    `[${reportNum}](reports/${reportFileName})`,
    note,
  ].join('\t');

  writeFileSync(join(trackerDir, `${id}.tsv`), tsvLine + '\n', 'utf8');

  // Output JSON for the batch orchestrator to parse
  process.stdout.write(
    JSON.stringify({
      status: 'completed',
      id,
      report_num: reportNum,
      company,
      role,
      score,
      pdf: null,
      report: `reports/${reportFileName}`,
      error: null,
    }) + '\n',
  );
}

main().catch((err) => {
  const args = parseArgs();
  failWith(args.id, args.reportNum, err.message);
});
