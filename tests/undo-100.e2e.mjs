import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://127.0.0.1:5188/')
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 50; canvas.height = 50
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 50, 50); ctx.strokeStyle = 'black'; ctx.lineWidth = 2; ctx.strokeRect(5, 5, 40, 40)
    return canvas.toDataURL().split(',')[1]
  })
  await page.locator('input[type=file]').first().setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') })
  await page.waitForFunction(() => document.querySelector('.region-status')?.textContent.includes('1 个区域'))
  const canvas = page.getByLabel('线稿填色画布')
  const swatches = page.getByRole('group', { name: '快捷黑白灰' }).getByRole('button')
  for (let i = 0; i < 100; i++) { await swatches.nth(i % 2).click(); await canvas.click() }
  const undo = page.getByRole('button', { name: '撤销', exact: true })
  for (let i = 0; i < 100; i++) { assert.equal(await undo.isEnabled(), true, `undo ${i + 1} is available`); await undo.click() }
  assert.equal(await undo.isEnabled(), false)
  assert.equal(await page.getByRole('button', { name: '重做', exact: true }).isEnabled(), true)
  console.log('PASS: 100 edits can be undone and redone')
} finally { await browser.close() }
