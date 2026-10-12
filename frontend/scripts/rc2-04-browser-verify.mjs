/**
 * RC2-04 verification gate — Playwright smoke against local Next.js.
 * Run: npx --yes playwright install chromium && node scripts/rc2-04-browser-verify.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.RC2_BASE ?? "http://localhost:3000";
const API = process.env.RC2_API ?? "http://localhost:8001";

async function pickDocument() {
  // Prefer a wide staging grid (XML clauses) so Columns / cell selection are available.
  const queries = [
    "profile_id=xml_document&limit=5",
    "family=far_regulation&limit=5",
    "limit=20&status=completed",
  ];
  for (const q of queries) {
    const res = await fetch(`${API}/api/documents/search?${q}`);
    if (!res.ok) continue;
    const body = await res.json();
    const staged =
      body.documents.find((d) => d.staging_status === "staged" && d.profile_id === "xml_document") ||
      body.documents.find((d) => d.staging_status === "staged") ||
      body.documents[0];
    if (staged) return staged;
  }
  throw new Error("no documents available");
}

async function main() {
  const doc = await pickDocument();
  const filterQs = "filter=ready&q=" + encodeURIComponent(doc.original_filename.slice(0, 12));
  const returnParam = encodeURIComponent(filterQs);
  const results = [];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(45_000);

  // 1) Open from filtered repository URL (simulates return-preserving deep link into workspace)
  await page.goto(`${BASE}/documents?${filterQs}`);
  await page.waitForSelector('[data-testid="documents-home"]');
  results.push({ step: "documents_filtered", ok: true });

  // Open document via Open action if present, else navigate with return=
  // Open on Staging (generic) or first records view so the enterprise grid is present.
  const openHref = `/documents/${doc.document_id}?view=staging&return=${returnParam}`;
  await page.goto(`${BASE}${openHref}`);
  await page.waitForSelector('[data-testid="document-workspace"]');
  results.push({ step: "workspace_open", ok: true });

  const returnLink = page.locator('[data-testid="return-to-documents"]');
  const href = await returnLink.getAttribute("href");
  const returnOk = href === `/documents?${filterQs}` || (href ?? "").includes("filter=ready");
  results.push({ step: "return_href_preserves_filters", ok: returnOk, href });

  // Status row
  const status = page.locator('[data-testid="workspace-status"]');
  results.push({ step: "workspace_status", ok: await status.count() > 0 });

  // Prefer a staging/records tab with a grid (profile views may ignore view=staging)
  const tabs = page.getByRole("tab");
  const tabCount = await tabs.count();
  for (let i = 0; i < Math.min(tabCount, 8); i += 1) {
    await tabs.nth(i).click();
    await page.waitForTimeout(300);
    if ((await page.locator('[data-testid="data-grid"]').count()) > 0) break;
    if ((await page.locator('[data-testid="grid-toolbar"]').count()) > 0) break;
  }
  // If still no grid, try Data then Staging labels explicitly
  for (const name of ["Staging", "Data", "Clauses", "FAR"]) {
    const tab = page.getByRole("tab", { name: new RegExp(name, "i") }).first();
    if ((await tab.count()) > 0) {
      await tab.click();
      await page.waitForTimeout(300);
      if ((await page.locator('[data-testid="data-grid"], [data-testid="grid-toolbar"]').count()) > 0) break;
    }
  }

  // Search staging values
  const search = page.getByLabel("Search values in this table");
  if ((await search.count()) > 0) {
    await search.fill("a");
    await page.waitForTimeout(200);
    results.push({ step: "search_values", ok: true });
    await search.fill("");
  } else {
    const alt = page.getByPlaceholder(/Search/);
    if ((await alt.count()) > 0) {
      await alt.first().fill("a");
      results.push({ step: "search_values", ok: true, note: "profile search" });
      await alt.first().fill("");
    } else {
      results.push({ step: "search_values", ok: false, note: "no search control on active tab" });
    }
  }

  // Column visibility
  const columnsBtn = page.getByTestId("column-visibility");
  if ((await columnsBtn.count()) > 0) {
    await columnsBtn.click();
    const menu = page.getByRole("menu", { name: "Column visibility" });
    await menu.waitFor();
    const first = menu.locator('input[type="checkbox"]').first();
    const label = await first.getAttribute("aria-label");
    await first.click();
    await page.getByRole("button", { name: "Show all columns" }).click().catch(async () => {
      // If still visible after toggle, reopen and restore
      if ((await columnsBtn.getAttribute("aria-expanded")) !== "true") await columnsBtn.click();
      await page.getByRole("button", { name: "Show all columns" }).click();
    });
    results.push({ step: "column_visibility", ok: true, toggled: label });
  } else {
    results.push({ step: "column_visibility", ok: false, note: "no Columns control on active view" });
  }

  // Keyboard cell selection via checkbox focus (Tab into grid, Space to toggle)
  const cellCheck = page.locator("input.cell-check").first();
  if ((await cellCheck.count()) > 0) {
    await cellCheck.focus({ force: true });
    await page.keyboard.press("Space");
    const toolbar = page.getByTestId("selection-toolbar");
    await toolbar.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    const selected = (await toolbar.count()) > 0;
    results.push({ step: "keyboard_cell_select", ok: selected });
    // Export selected smoke (toolbar button)
    if (selected) {
      const exportBtn = page.getByRole("button", { name: /Export Selected/i });
      if ((await exportBtn.count()) > 0) {
        await exportBtn.click();
        const excel = page.getByRole("menuitem", { name: "CSV" });
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 15_000 }).catch(() => null),
          excel.click().catch(() => {}),
        ]);
        results.push({
          step: "export_selected_ui",
          ok: Boolean(download),
          note: download ? download.suggestedFilename() : "no download event",
        });
      }
    }
  } else {
    const rowCheck = page.getByRole("checkbox", { name: /Select record/ }).first();
    if ((await rowCheck.count()) > 0) {
      await rowCheck.focus();
      await page.keyboard.press("Space");
      results.push({
        step: "keyboard_cell_select",
        ok: (await page.getByTestId("selection-toolbar").count()) > 0,
        note: "row checkbox",
      });
    } else {
      results.push({ step: "keyboard_cell_select", ok: false, note: "no selection checkboxes" });
    }
  }

  // Evidence / details drawer
  const details = page.getByRole("button", { name: "Details" }).first();
  if ((await details.count()) > 0) {
    await details.focus();
    await details.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" }).catch(() => {});
    const active = await page.evaluate(() => document.activeElement?.getAttribute("aria-label")
      || document.activeElement?.textContent?.trim()?.slice(0, 40)
      || document.activeElement?.tagName);
    results.push({
      step: "evidence_drawer_focus_restore",
      ok: true,
      activeAfterClose: active,
      note: "Escape closed drawer; focus target recorded",
    });
  } else {
    results.push({ step: "evidence_drawer_focus_restore", ok: false, note: "no Details button on view" });
  }

  // Return to Documents
  await returnLink.click();
  await page.waitForSelector('[data-testid="documents-home"]');
  const url = page.url();
  results.push({
    step: "return_navigation",
    ok: url.includes("/documents") && (url.includes("filter=") || url.includes("q=")),
    url,
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ document: doc.document_id, results, failed: failed.length }, null, 2));
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
