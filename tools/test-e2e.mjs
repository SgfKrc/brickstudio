// 端到端冒烟测试:手机视口打开应用,放置零件、切换模式、导出 .ldr,截图。
// 用法: node tools/test-e2e.mjs <url> <截图前缀>
import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';

const url = process.argv[2] || 'http://localhost:8000';
const prefix = process.argv[3] || '/tmp/shot';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 1,
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGE: ' + e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${prefix}-1-loaded.png` });

// 视图中心点几下:放置模式下应放置 2x4 砖
const vp = await page.locator('.viewport').boundingBox();
const cx = vp.x + vp.width / 2, cy = vp.y + vp.height / 2;
await page.touchscreen.tap(cx, cy);
await page.waitForTimeout(800);
await page.touchscreen.tap(cx + 60, cy - 40);
await page.waitForTimeout(800);
await page.touchscreen.tap(cx - 70, cy + 50);
await page.waitForTimeout(1000);
await page.screenshot({ path: `${prefix}-2-placed.png` });

// 顶栏应显示计数
const title = await page.locator('.title').textContent();
console.log('标题栏:', title.trim());

// 切换零件(选第二个分类的一个零件)后再放一个
await page.locator('.cat-btn').nth(3).tap();   // 斜面
await page.waitForTimeout(1500);
await page.locator('.part-btn').first().tap();
await page.waitForTimeout(500);
await page.touchscreen.tap(cx + 10, cy + 90);
await page.waitForTimeout(1000);
await page.screenshot({ path: `${prefix}-3-slope.png` });

// 撤销一次
await page.locator('.tb-btn').nth(1).tap();
await page.waitForTimeout(800);

// 导出 .ldr
await page.locator('.tb-btn').first().tap(); // 菜单
await page.waitForTimeout(300);
const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
await page.getByText('导出 .ldr').tap();
const download = await dl;
if (download) {
  const path = `${prefix}-model.ldr`;
  await download.saveAs(path);
  console.log('导出成功 ->', path);
} else {
  console.log('未捕获到下载事件');
}
await page.waitForTimeout(500);
await page.screenshot({ path: `${prefix}-4-final.png` });

const count = await page.evaluate(() => document.querySelectorAll('.part-btn img').length);
console.log('已生成缩略图数量:', count);
console.log('控制台错误:', errors.length ? errors.slice(0, 10) : '无');
await browser.close();
