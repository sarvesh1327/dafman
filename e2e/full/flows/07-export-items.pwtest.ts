/// F7 — Conversation export captures session items.
///
/// Bug class from MANUAL_TESTS: user exported a session and the
/// resulting JSON had `items: []`. Likely caused by the cwd cascade
/// (no events flowed) or by the export being clicked before history
/// arrived. This test sends a real message via the UI, exports the
/// JSON, parses it back, and asserts items.length > 0 with the
/// expected user/assistant pair.

import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnBunHarness, type BunHarness } from '../harness/bunHarness';
import { openDetailsRail } from '../harness/pageHarness';

let harness: BunHarness;

test.beforeEach(async () => {
  harness = await spawnBunHarness();
});

test.afterEach(async () => {
  await harness.teardown();
});

test('Export JSON contains user + assistant items after a turn', async ({ page }) => {
  await page.goto(`/?testBridge=${encodeURIComponent(harness.wsUrl)}&autosession=1`);
  const composer = page.locator('.lex-composer-input').first();
  await composer.waitFor({ state: 'visible', timeout: 15_000 });
  await composer.click();
  await page.keyboard.type('hello world');
  // Default submit keybinding is 'enter' (plain Enter sends; #88).
  await page.keyboard.press('Enter');
  // Wait for assistant reply to render so we know events have flowed
  // into the store (and therefore into rec.events).
  await expect(page.locator('text=ok: hello world').first()).toBeVisible({ timeout: 5_000 });

  // The details rail no longer auto-opens (commit 6343902) — open it
  // via the cog. The JSON export button lives in the rail (Phase 18b+
  // shortened the label from "Export JSON" to "JSON" with a tooltip).
  await openDetailsRail(page);
  await page.getByRole('button', { name: /^JSON$/ }).click();

  // Read the file from the test-server's userData exports dir.
  const exportsDir = join(harness.userData, 'exports');
  // Small polling loop — saveExportFile is async and reveals after.
  let parsed: { items: unknown[] } | null = null;
  for (let i = 0; i < 30; i++) {
    try {
      const files = readdirSync(exportsDir).filter((f) => f.endsWith('.json'));
      if (files.length > 0) {
        const raw = readFileSync(join(exportsDir, files[0]!), 'utf8');
        parsed = JSON.parse(raw) as { items: unknown[] };
        break;
      }
    } catch {
      /* not ready yet */
    }
    await page.waitForTimeout(150);
  }
  expect(parsed).not.toBeNull();
  expect(parsed!.items.length).toBeGreaterThan(0);
  // Sanity: should include at least one user item with our prompt
  // and one assistant item with the response.
  const json = JSON.stringify(parsed!.items);
  expect(json).toContain('hello world');
  expect(json).toContain('ok: hello world');
});
