// Captures dashboard screenshots for the slides: node scripts/screenshots.js http://localhost:8000 docs/slides/img
const { chromium } = require("playwright");
(async () => {
  const [url = "http://localhost:8000", dir = "docs/slides/img"] = process.argv.slice(2);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.5 });
  await page.goto(url);
  await page.waitForTimeout(3000);
  // fill a few hours of history, then stage the demo: hidden wear on A2 and a robot failure on W3
  await page.selectOption("#speed", "900");
  await page.waitForTimeout(12000);
  await page.selectOption("#speed", "60");
  await page.click("[data-sc=wear]");
  await page.click("[data-sc=robot_failure]");
  await page.waitForTimeout(15000);
  await page.click("#pause");
  for (const lang of ["ru", "ko"]) {
    await page.click(`[data-lang=${lang}]`);
    for (const tab of ["plant", "exec", "incidents", "ai", "data"]) {
      await page.click(`[data-tab=${tab}]`);
      await page.waitForTimeout(2500);
      const clip = tab === "incidents" ? { x: 0, y: 0, width: 1600, height: 640 } : undefined;
      await page.screenshot({ path: `${dir}/${tab}_${lang}.png`, clip });
    }
  }
  await browser.close();
})();
