/**
 * RC2-08 browser certification — screenshots + interaction smoke.
 * Run: npx --yes playwright install chromium && node scripts/rc2-08-browser-certify.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.env.RC2_BASE ?? "http://localhost:3000";
const API = process.env.RC2_API ?? "http://localhost:8001";
const OUT = process.env.RC2_SHOTS ?? join(process.cwd(), "..", "docs", "rc2-08-browser-evidence");

mkdirSync(OUT, { recursive: true });

async function pickDocument() {
  const queries = [
    "profile_id=xml_document&limit=5",
    "family=far_regulation&limit=5",
    "family=invoice&limit=5",
    "limit=20",
  ];
  for (const q of queries) {
    const res = await fetch(`${API}/api/documents/search?${q}`);
    if (!res.ok) continue;
    const body = await res.json();
    const staged =
      body.documents.find((d) => d.staging_status === "staged") ||
      body.documents[0];
    if (staged) return staged;
  }
  throw new Error("no documents available for browser certification");
}

async function shot(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function main() {
  const results = [];
  const doc = await pickDocument();
  results.push({
    step: "fixture_pick",
    ok: true,
    document_id: doc.document_id,
    filename: doc.original_filename,
    profile_id: doc.profile_id ?? null,
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60_000);

  async function visit(name, url, selector) {
    try {
      await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
      if (selector) await page.waitForSelector(selector, { timeout: 45_000 });
      await page.waitForTimeout(800);
      const path = await shot(page, name);
      results.push({ step: name, ok: true, url, path });
    } catch (err) {
      results.push({
        step: name,
        ok: false,
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await visit("01-marketing-home", "/", "h1, main");
  await visit("02-documents-repository", "/documents", '[data-testid="documents-home"]');
  await visit(
    "03-extraction-workspace",
    `/documents/${doc.document_id}`,
    '[data-testid="document-workspace"]',
  );

  // Staging workbook / grid
  try {
    await page.goto(
      `${BASE}/documents/${doc.document_id}?view=staging`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForSelector('[data-testid="document-workspace"]');
    const tabs = page.getByRole("tab");
    const n = await tabs.count();
    for (let i = 0; i < Math.min(n, 10); i += 1) {
      await tabs.nth(i).click();
      await page.waitForTimeout(250);
      if ((await page.locator('[data-testid="data-grid"], [data-testid="grid-toolbar"]').count()) > 0)
        break;
    }
    await shot(page, "04-staging-workbook");
    results.push({
      step: "04-staging-workbook",
      ok: (await page.locator('[data-testid="data-grid"], [data-testid="grid-toolbar"]').count()) > 0,
    });
  } catch (err) {
    results.push({
      step: "04-staging-workbook",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Export menu
  try {
    const exportBtn = page.getByRole("button", { name: /Export/i }).first();
    if ((await exportBtn.count()) > 0) {
      await exportBtn.click();
      await page.waitForTimeout(400);
      await shot(page, "05-export-menu");
      results.push({ step: "05-export-menu", ok: true });
      await page.keyboard.press("Escape");
    } else {
      results.push({ step: "05-export-menu", ok: false, error: "Export button not found" });
    }
  } catch (err) {
    results.push({
      step: "05-export-menu",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Oracle panel via Integrations or workspace toggle
  try {
    await page.goto(`${BASE}/integrations`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    const input = page.locator('input[placeholder*="document" i], input[name*="document" i]').first();
    if ((await input.count()) > 0) {
      await input.fill(doc.document_id);
      await page.waitForTimeout(300);
      const load = page.getByRole("button", { name: /Load|Open|Preview|Generate/i }).first();
      if ((await load.count()) > 0) await load.click();
      await page.waitForTimeout(1200);
    }
    await shot(page, "06-oracle-preview");
    results.push({
      step: "06-oracle-preview",
      ok: true,
      note: "Integrations page; live send not invoked",
    });
  } catch (err) {
    results.push({
      step: "06-oracle-preview",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await visit(
    "07-metadata-review",
    `/documents/${doc.document_id}/review`,
    "h1, [data-testid='review-field-list'], main",
  );
  await visit("08-governance-dashboard", "/governance", "h1, main");
  await visit("09-audit-explorer", "/audit-log", '[data-testid="audit-filters"], h1');

  // Mobile navigation
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/documents`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const menu = page.getByRole("button", { name: /menu|open navigation|navigation/i }).first();
    if ((await menu.count()) > 0) {
      await menu.click();
      await page.waitForTimeout(400);
    }
    await shot(page, "10-mobile-navigation");
    results.push({ step: "10-mobile-navigation", ok: true });
  } catch (err) {
    results.push({
      step: "10-mobile-navigation",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ out: OUT, passed, failed, results }, null, 2));
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
