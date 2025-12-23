// index.js
const { chromium } = require('playwright');

const BASE = 'https://news.ycombinator.com';
const START_URL = `${BASE}/newest`;
const TARGET = 100;

function parseAgeToSeconds(text) {
  const m = text.trim().match(/^(\d+)\s+(minute|minutes|hour|hours|day|days)\s+ago$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('minute')) return n * 60;
  if (unit.startsWith('hour')) return n * 3600;
  if (unit.startsWith('day')) return n * 86400;
  return null;
}

async function getItemsOnPage(page) {
  await page.waitForSelector('tr.athing', { timeout: 15000 });

  const items = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.athing'));
    return rows.map(row => {
      const id = row.getAttribute('id') || '';
      const title = row.querySelector('span.titleline > a')?.textContent?.trim() || '';
      const sub = row.nextElementSibling;
      const age = sub?.querySelector('span.age')?.textContent?.trim() || '';
      return { id, title, age };
    });
  });

  return items;
}

function assertSortedNewestToOldest(items) {
  // Newest first => ages should be NON-DECREASING down the list (e.g., 1m,2m,3m...)
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const curr = items[i];

    if (prev.ageSeconds == null || curr.ageSeconds == null) {
      throw new Error(
        `Age parse failed.\nPrev: "${prev.age}" (id=${prev.id})\nCurr: "${curr.age}" (id=${curr.id})`
      );
    }

    if (curr.ageSeconds < prev.ageSeconds) {
      throw new Error(
        `Sorting violation at position ${i + 1}.\n` +
          `#${i}: "${prev.title}" age="${prev.age}" sec=${prev.ageSeconds}\n` +
          `#${i + 1}: "${curr.title}" age="${curr.age}" sec=${curr.ageSeconds}`
      );
    }
  }
}

(async () => {
  const headless = (process.env.HEADLESS || 'true').toLowerCase() !== 'false';

  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const collected = [];
    const seen = new Set();

    while (collected.length < TARGET) {
      const pageItems = await getItemsOnPage(page);

      for (const it of pageItems) {
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        collected.push({
          ...it,
          ageSeconds: parseAgeToSeconds(it.age),
        });
        if (collected.length === TARGET) break;
      }

      if (collected.length < TARGET) {
        // Click "More" reliably
        const more = page.locator('a.morelink');
        await more.waitFor({ state: 'visible', timeout: 15000 });
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          more.click(),
        ]);
      }
    }

    if (collected.length !== TARGET) {
      throw new Error(`Expected EXACTLY ${TARGET} items, got ${collected.length}.`);
    }

    assertSortedNewestToOldest(collected);

    console.log(`✅ PASS: First ${TARGET} items on /newest are sorted newest -> oldest.`);
    process.exitCode = 0;
  } catch (e) {
    console.error(`❌ FAIL: ${e.message || e}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

