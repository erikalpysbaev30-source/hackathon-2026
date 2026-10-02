// Renders docs/slides/out/slides_{ru,ko}.html to PDF. Needs: npm i playwright (Chromium).
const path = require("path");
const { chromium } = require("playwright");
(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  for (const lang of ["ru", "ko"]) {
    await page.goto("file://" + path.join(out, `slides_${lang}.html`));
    await page.waitForTimeout(500);
    await page.pdf({ path: path.join(out, `Allur_Digital_Twin_${lang.toUpperCase()}.pdf`), width: "1280px", height: "720px", printBackground: true });
  }
  await browser.close();
})();
