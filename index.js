// index.js
// QA Wolf "go further" edition:
// - Validates EXACTLY the first N (default 100) HN /newest items are newest->oldest
// - Collects across pagination ("More")
// - Rich failure reporting (first violation details)
// - Artifacts on failure (and optional always-on): screenshot, HTML, JSON, summary.md
// - Optional Playwright trace on failure (zip)
//
//
// Run:
//   npm i
//   node index.js
//
// Optional env vars:
//   COUNT=100
//   HEADLESS=false
//   TIMEOUT_MS=30000
//   ARTIFACTS=on_fail   (default) | always | off
//   TRACE=on_fail       (default) | always | off

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://news.ycombinator.com';
const START_URL = `${BASE}/newest`;

const COUNT = Number(process.env.COUNT || 100);
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);

const ARTIFACTS = (process.env.ARTIFACTS || 'on_fail').toLowerCase(); // on_fail | always | off
const TRACE = (process.env.TRACE || 'on_fail').toLowerCase(); // on_fail | always | off

const ART_DIR = path.join(process.cwd(), 'artifacts');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function parseAgeToSeconds(ageText) {
  // Examples: "3 minutes ago", "1 hour ago", "2 days ago"
  const m = (ageText || '').trim().match(/^(\d+)\s+(minute|minutes|hour|hours|day|days)\s+ago$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('minute')) return n * 60;
  if (unit.startsWith('hour')) return n * 60 * 60;
  if (unit.startsWith('day')) return n * 24 * 60 * 60;
  return null;
}

async function getItemsOnPage(page) {
  await page.waitForSelector('tr.athing', { timeout: TIMEOUT_MS });

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.athing'));
    return rows.map((row) => {
      const id = row.getAttribute('id') || '';
      const title = row.querySelector('span.titleline > a')?.textContent?.trim() || '';
      const sub = row.nextElementSibling;
      const age = sub?.querySelector('span.age')?.textContent?.trim() || '';
      return { id, title, age };
    });
  });
}

function validateSortedNewestToOldest(items) {
  // Newest first => ages should be NON-DECREASING down the list (e.g., 1m,2m,3m...)
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const curr = items[i];

    if (prev.ageSeconds == null || curr.ageSeconds == null) {
      return {
        ok: false,
        kind: 'PARSE_ERROR',
        index: i,
        message:
          `Could not parse age string(s).\n` +
          `prev: "${prev.age}" (id=${prev.id})\n` +
          `curr: "${curr.age}" (id=${curr.id})`,
        prev,
        curr,
      };
    }

    if (curr.ageSeconds < prev.ageSeconds) {
      return {
        ok: false,
        kind: 'SORT_VIOLATION',
        index: i,
        message:
          `Sorting violation at position ${i + 1}.\n` +
          `prev: "${prev.title}" | ${prev.age} (${prev.ageSeconds}s) | id=${prev.id}\n` +
          `curr: "${curr.title}" | ${curr.age} (${curr.ageSeconds}s) | id=${curr.id}`,
        prev,
        curr,
      };
    }
  }

  return { ok: true };
}

function writeSummary({ stamp, url, count, pagesVisited, durationMs, status, detail }) {
  ensureDir(ART_DIR);
  const lines = [];
  lines.push(`# Hacker News /newest Validation Summary`);
  lines.push('');
  lines.push(`- **Timestamp:** ${stamp}`);
  lines.push(`- **URL:** ${url}`);
  lines.push(`- **Count Requested:** ${count}`);
  lines.push(`- **Pages Visited:** ${pagesVisited}`);
  lines.push(`- **Duration:** ${durationMs} ms`);
  lines.push(`- **Result:** ${status}`);
  if (detail) {
    lines.push('');
    lines.push('## Detail');
    lines.push('');
    lines.push('```');
    lines.push(detail);
    lines.push('```');
  }
  fs.writeFileSync(path.join(ART_DIR, `summary-${stamp}.md`), lines.join('\n'), 'utf8');
}

async function writeArtifacts({ page, stamp, label, collected, validation }) {
  if (ARTIFACTS === 'off') return;

  ensureDir(ART_DIR);

  const prefix = `${label}-${stamp}`;
  const screenshotPath = path.join(ART_DIR, `${prefix}-screenshot.png`);
  const htmlPath = path.join(ART_DIR, `${prefix}-page.html`);
  const jsonPath = path.join(ART_DIR, `${prefix}-data.json`);

  await page.screenshot({ path: screenshotPath, fullPage: true });

  const html = await page.content();
  fs.writeFileSync(htmlPath, html, 'utf8');

  const payload = {
    meta: {
      stamp,
      url: page.url(),
      count: collected.length,
      label,
    },
    validation,
    items: collected,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
}

(async () => {
  const stamp = nowStamp();
  const started = Date.now();
  let pagesVisited = 0;

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Optional tracing
  const traceMode = TRACE;
  const shouldTraceAlways = traceMode === 'always';
  const shouldTraceOnFail = traceMode === 'on_fail';

  if (shouldTraceAlways) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  const collected = [];
  const seen = new Set();

  let validationResult = null;
  let status = 'FAIL';
  let detail = '';

  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    pagesVisited++;

    while (collected.length < COUNT) {
      const pageItems = await getItemsOnPage(page);

      for (const it of pageItems) {
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        collected.push({
          ...it,
          ageSeconds: parseAgeToSeconds(it.age),
        });
        if (collected.length === COUNT) break;
      }

      if (collected.length < COUNT) {
        const more = page.locator('a.morelink');
        await more.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          more.click(),
        ]);
        pagesVisited++;
      }
    }

    if (collected.length !== COUNT) {
      throw new Error(`Expected EXACTLY ${COUNT} items, got ${collected.length}.`);
    }

    validationResult = validateSortedNewestToOldest(collected);
    if (!validationResult.ok) {
      throw new Error(validationResult.message);
    }

    status = 'PASS';
    console.log(`✅ PASS: First ${COUNT} items on /newest are sorted newest -> oldest.`);
    process.exitCode = 0;

    // Optional always-on artifacts
    if (ARTIFACTS === 'always') {
      await writeArtifacts({
        page,
        stamp,
        label: 'pass',
        collected,
        validation: { ok: true },
      });
    }
  } catch (e) {
    const msg = e?.message || String(e);
    detail = msg;
    console.error(`❌ FAIL: ${msg}`);
    process.exitCode = 1;

    // Start tracing only on fail if configured that way
    if (shouldTraceOnFail && !shouldTraceAlways) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {});
    }

    // Write artifacts on failure (default behavior)
    if (ARTIFACTS === 'on_fail' || ARTIFACTS === 'always') {
      await writeArtifacts({
        page,
        stamp,
        label: 'fail',
        collected,
        validation: validationResult || { ok: false, message: msg },
      }).catch(() => {});
    }

    // Stop tracing on fail if configured
    if (shouldTraceOnFail && !shouldTraceAlways) {
      const tracePath = path.join(ART_DIR, `trace-fail-${stamp}.zip`);
      await context.tracing.stop({ path: tracePath }).catch(() => {});
    }
  } finally {
    // Stop trace if always tracing
    if (shouldTraceAlways) {
      const tracePath = path.join(ART_DIR, `trace-${status.toLowerCase()}-${stamp}.zip`);
      await context.tracing.stop({ path: tracePath }).catch(() => {});
    }

    const durationMs = Date.now() - started;

    // Always write a summary file (tiny, high-signal)
    writeSummary({
      stamp,
      url: START_URL,
      count: COUNT,
      pagesVisited,
      durationMs,
      status,
      detail: detail || undefined,
    });

    await context.close();
    await browser.close();
  }
})();
