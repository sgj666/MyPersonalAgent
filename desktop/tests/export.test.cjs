// Run after npm run build: npx electron tests/export.test.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, nativeImage } = require('electron')
const { build } = require('esbuild')
const { exportImage, exportPdf } = require('../dist/main/export')

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cow-export-'))
  const htmlPath = path.join(dir, '作业卡片.html')
  await fs.writeFile(htmlPath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <style>
      * { box-sizing: border-box } html, body { margin: 0 }
      body { width: 1080px; height: 1440px; padding: 60px; color: #fff;
        font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
        background: linear-gradient(140deg, #163b4c, #317d77, #d6b76d) }
      #card { width: 960px; height: 1320px; padding: 72px; border-radius: 44px;
        background: linear-gradient(160deg, #ffffff30, #ffffff08); border: 2px solid #ffffff50 }
      h1 { font-size: 78px } p { font-size: 36px; line-height: 1.8 }
      @page { size: A4; margin: 10mm }
      @media print { body { width: 180mm; height: 240mm; padding: 10mm }
        #card { width: 160mm; height: 220mm; padding: 10mm } h1 { font-size: 32pt } p { font-size: 16pt } }
    </style>
    <main id="card"><p>七（3）班 · 英语</p><h1>课后作业</h1>
      <p>Unit 3 · 每天进步一点点</p><p>基础巩固：复习本课词汇，完成阅读练习。</p>
      <p>今晚 20 分钟，重点是理解与表达。</p></main></html>`)

  let active = 0
  let maxActive = 0
  const nativeCaptures = []
  const pixelRatios = []
  app.on('browser-window-created', (_event, win) => {
    maxActive = Math.max(maxActive, ++active)
    win.once('closed', () => { active-- })
    const capture = win.webContents.capturePage.bind(win.webContents)
    win.webContents.capturePage = async (...args) => {
      pixelRatios.push(await win.webContents.executeJavaScript('devicePixelRatio'))
      const image = await capture(...args)
      nativeCaptures.push(image.getSize())
      return image
    }
  })

  const options = { htmlPath, width: 1080, height: 1440 }
  const [image, pdf] = await Promise.all([exportImage(options), exportPdf({ htmlPath })])
  assert.deepEqual(image, { ok: true, path: path.join(dir, '作业卡片.png'), width: 1080, height: 1440 })
  assert.deepEqual(pdf, { ok: true, path: path.join(dir, '作业卡片.pdf') })
  const png = nativeImage.createFromPath(image.path)
  assert.deepEqual(png.getSize(), { width: 1080, height: 1440 })
  const pixels = png.toBitmap()
  assert.notDeepEqual(pixels.subarray(0, 4), pixels.subarray(pixels.length - 4), 'gradient must be painted')
  assert.equal((await fs.readFile(pdf.path)).subarray(0, 5).toString(), '%PDF-')

  const cropPath = path.join(dir, 'nested', 'crop.png')
  const crop = await exportImage({ ...options, selector: '#card', outPath: cropPath })
  assert.deepEqual(crop, { ok: true, path: cropPath, width: 960, height: 1320 })
  assert.deepEqual(nativeImage.createFromPath(cropPath).getSize(), { width: 960, height: 1320 })

  const missing = await exportImage({ ...options, htmlPath: path.join(dir, 'missing.html') })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /HTML 文件不存在/)
  for (const invalid of [undefined, { ...options, width: 0 }, { ...options, selector: '#missing' }, { ...options, selector: '[' }]) {
    const result = await exportImage(invalid)
    assert.equal(result.ok, false)
    assert.match(result.error, /[\u4e00-\u9fff]/)
  }
  assert.equal((await exportPdf({ htmlPath: path.join(dir, 'missing.html') })).ok, false)
  assert.equal((await exportImage({ ...options, outPath: htmlPath })).ok, false)
  const writeFailure = await exportImage({ ...options, outPath: dir })
  assert.equal(writeFailure.ok, false)
  assert.match(writeFailure.error, /[\u4e00-\u9fff]/)
  const concurrentPath = path.join(dir, 'concurrent.png')
  const concurrent = await Promise.all([
    exportImage({ ...options, outPath: concurrentPath }),
    exportImage({ ...options, width: 540, height: 720, outPath: concurrentPath }),
  ])
  assert.ok(concurrent.every((result) => result.ok))
  assert.deepEqual(nativeImage.createFromPath(concurrentPath).getSize(), { width: 540, height: 720 })
  assert.equal(maxActive, 1, 'exports must never overlap hidden windows')
  assert.equal(BrowserWindow.getAllWindows().length, 0, 'success and failure must destroy windows')

  const rendererPath = path.join(dir, 'renderer.cjs')
  await build({ entryPoints: [path.join(__dirname, '../src/renderer/src/lib/exportImage.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: rendererPath })
  const renderer = require(rendererPath)
  global.window = {}
  for (const result of [await renderer.saveCardImage(htmlPath), await renderer.saveCardPdf(htmlPath)]) {
    assert.deepEqual(result, { ok: false, error: '当前环境不支持导出' })
  }
  const calls = []
  window.electronAPI = {
    exportImage: async (opts) => { calls.push(opts); return image },
    exportPdf: async (opts) => { calls.push(opts); return pdf },
    openPath: async (target) => { calls.push(target); return '' },
    revealPath: async (target) => { calls.push(target) },
  }
  assert.deepEqual(await renderer.saveCardImage(htmlPath), image)
  assert.deepEqual(await renderer.saveCardPdf(htmlPath), pdf)
  assert.equal(await renderer.openImage(image.path), '')
  await renderer.revealInFolder(image.path)
  assert.deepEqual(calls, [{ ...options, outPath: undefined }, { htmlPath }, image.path, image.path])

  const report = { image, pdf, crop, missing, maxActive, pixelRatios, nativeCaptures, concurrent, checks: 'passed' }
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
