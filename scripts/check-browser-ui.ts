import { chromium } from "playwright";
import { strict as assert } from "node:assert";
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage();
  const errors:string[] = [];page.on('pageerror',error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4317/');
  await page.locator('#job-list .card').first().waitFor();
  assert.equal(await page.locator('#browser-source,#browse-headless,#browse-computer').count(),0);
  assert.equal(await page.getByRole('button',{name:'Search now'}).isVisible(),true);
  assert.match(await page.locator('#next-search').textContent() ?? '',/Next automatic search/);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Automatic-search dashboard passed: one search button, no scraping controls, daily schedule, no page errors.');
} finally {await browser.close();}
