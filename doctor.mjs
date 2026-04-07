#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for career-ops
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

// ANSI colors (only on TTY)
const isTTY = process.stdout.isTTY;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0]);
  if (major >= 18) {
    return { pass: true, label: `Node.js >= 18 (v${process.versions.node})` };
  }
  return {
    pass: false,
    label: `Node.js >= 18 (found v${process.versions.node})`,
    fix: 'Install Node.js 18 or later from https://nodejs.org',
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, label: 'Dependencies installed' };
  }
  return {
    pass: false,
    label: 'Dependencies not installed',
    fix: 'Run: npm install',
  };
}

async function checkPlaywright() {
  try {
    const { chromium } = await import('playwright');
    const execPath = chromium.executablePath();
    if (existsSync(execPath)) {
      return { pass: true, label: 'Playwright chromium installed' };
    }
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  } catch {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx playwright install chromium',
    };
  }
}

function checkCv() {
  if (existsSync(join(projectRoot, 'cv.md'))) {
    return { pass: true, label: 'cv.md found' };
  }
  return {
    pass: false,
    label: 'cv.md not found',
    fix: [
      'Create cv.md in the project root with your CV in markdown',
      'See examples/ for reference CVs',
    ],
  };
}

function checkProfile() {
  if (existsSync(join(projectRoot, 'config', 'profile.yml'))) {
    return { pass: true, label: 'config/profile.yml found' };
  }
  return {
    pass: false,
    label: 'config/profile.yml not found',
    fix: [
      'Run: cp config/profile.example.yml config/profile.yml',
      'Then edit it with your details',
    ],
  };
}

function checkPortals() {
  if (existsSync(join(projectRoot, 'portals.yml'))) {
    return { pass: true, label: 'portals.yml found' };
  }
  return {
    pass: false,
    label: 'portals.yml not found',
    fix: [
      'Run: cp templates/portals.example.yml portals.yml',
      'Then customize with your target companies',
    ],
  };
}

function checkFonts() {
  const fontsDir = join(projectRoot, 'fonts');
  if (!existsSync(fontsDir)) {
    return {
      pass: false,
      label: 'fonts/ directory not found',
      fix: 'The fonts/ directory is required for PDF generation',
    };
  }
  try {
    const files = readdirSync(fontsDir);
    if (files.length === 0) {
      return {
        pass: false,
        label: 'fonts/ directory is empty',
        fix: 'The fonts/ directory must contain font files for PDF generation',
      };
    }
  } catch {
    return {
      pass: false,
      label: 'fonts/ directory not readable',
      fix: 'Check permissions on the fonts/ directory',
    };
  }
  return { pass: true, label: 'Fonts directory ready' };
}

function checkAutoDir(name) {
  const dirPath = join(projectRoot, name);
  if (existsSync(dirPath)) {
    return { pass: true, label: `${name}/ directory ready` };
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    return { pass: true, label: `${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${name}/ directory could not be created`,
      fix: `Run: mkdir ${name}`,
    };
  }
}

/**
 * Detect the configured LLM provider from config/profile.yml.
 * Returns 'ollama' if llm.provider is set to ollama, otherwise 'claude'.
 */
function detectLLMProvider() {
  const profilePath = join(projectRoot, 'config', 'profile.yml');
  if (!existsSync(profilePath)) return 'claude';
  try {
    const content = readFileSync(profilePath, 'utf8');
    const match = content.match(/^\s*provider\s*:\s*["']?(\w+)["']?\s*$/m);
    return match?.[1] === 'ollama' ? 'ollama' : 'claude';
  } catch {
    return 'claude';
  }
}

async function checkOllama() {
  const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.1:8b';

  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      return {
        pass: false,
        label: `Ollama not reachable at ${baseUrl}`,
        fix: ['Start Ollama: ollama serve', `Override URL: OLLAMA_BASE_URL=http://... npm run doctor`],
      };
    }

    const data = await resp.json();
    const models = (data.models || []).map((m) => m.name);
    const hasModel = models.some((m) => m === model || m === `${model}:latest`);

    if (!hasModel) {
      return {
        pass: false,
        label: `Ollama running but model '${model}' not found`,
        fix: [
          `Pull the model: ollama pull ${model}`,
          `Or set OLLAMA_MODEL=<other-model> — available: ${models.slice(0, 5).join(', ') || '(none)'}`,
        ],
      };
    }

    return { pass: true, label: `Ollama running at ${baseUrl}, model '${model}' available` };
  } catch {
    return {
      pass: false,
      label: `Ollama not reachable at ${baseUrl}`,
      fix: ['Start Ollama: ollama serve', `Override URL: OLLAMA_BASE_URL=http://... npm run doctor`],
    };
  }
}

async function main() {
  console.log('\ncareer-ops doctor');
  console.log('================\n');

  const llmProvider = detectLLMProvider();

  const checks = [
    checkNodeVersion(),
    checkDependencies(),
    await checkPlaywright(),
    checkCv(),
    checkProfile(),
    checkPortals(),
    checkFonts(),
    checkAutoDir('data'),
    checkAutoDir('output'),
    checkAutoDir('reports'),
  ];

  // Ollama check — only when configured as the LLM provider
  if (llmProvider === 'ollama') {
    console.log(`LLM provider: ollama\n`);
    checks.push(await checkOllama());
  }

  let failures = 0;

  for (const result of checks) {
    if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
    } else {
      failures++;
      console.log(`${red('✗')} ${result.label}`);
      const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else {
    const startHint = llmProvider === 'ollama'
      ? 'Run `./batch/batch-runner.sh --provider ollama` to process offers.'
      : 'Run `claude` to start.';
    console.log(`Result: All checks passed. You're ready to go! ${startHint}`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('doctor.mjs failed:', err.message);
  process.exit(1);
});
