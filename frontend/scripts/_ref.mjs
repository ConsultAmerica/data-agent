import { chromium } from "playwright";
const [S] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" });
for (const [name, url] of [["sirion", "https://www.sirion.ai/platform/store/contract-insights-search/"], ["floqast", "https://www.floqast.com/lp/ai-agents"]]) {
  const p = await ctx.newPage();
  try {
    await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForTimeout(6000);
    for (const sel of ["#onetrust-accept-btn-handler", "button:has-text('Accept')", "button:has-text('Accept All')"]) { await p.click(sel, { timeout: 1500 }).catch(() => {}); }
    const h = await p.evaluate(() => document.body.scrollHeight);
    console.log(name, "height", h, "title", await p.title());
    for (let i = 0, y = 0; y < Math.min(h, 9000); i++, y += 900) {
      await p.evaluate(yy => window.scrollTo(0, yy), y);
      await p.waitForTimeout(900);
      await p.screenshot({ path: `${S}/${name}-${i}.png` });
    }
    const text = await p.evaluate(() => document.body.innerText.slice(0, 5000));
    console.log("----", name, "\n", text.replace(/\n{2,}/g, "\n").slice(0, 3500));
  } catch (e) { console.log(name, "ERR", e.message); }
}
await b.close();
