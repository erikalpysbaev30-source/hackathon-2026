// Captures dashboard screenshots for the slides: node scripts/screenshots.js http://localhost:8000 docs/slides/img
const { chromium } = require("playwright");
(async () => {
  const [url = "http://localhost:8000", dir = "docs/slides/img"] = process.argv.slice(2);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5 });
  await page.goto(url);
  await page.waitForTimeout(3000);
  for (const lang of ["ru", "ko"]) {
    await page.click(`[data-lang=${lang}]`);
    for (const tab of ["plant", "exec", "incidents", "ai"]) {
      await page.click(`[data-tab=${tab}]`);
      await page.waitForTimeout(2500);
      const clip = tab === "incidents" ? { x: 0, y: 0, width: 1600, height: 640 } : undefined;
      await page.screenshot({ path: `${dir}/${tab}_${lang}.png`, clip });
    }
  }
  await browser.close();
})();
