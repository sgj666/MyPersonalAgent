import { BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'

export interface PdfExportOptions {
  htmlPath: string
  outPath?: string
}

export interface ImageExportOptions extends PdfExportOptions {
  width: number
  height: number
  selector?: string
}

export type ExportResult<T> = ({ ok: true } & T) | { ok: false; error: string }

// A single queue also prevents different HTML files writing the same output together.
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<ExportResult<T>> {
  const result = queue.then(async (): Promise<ExportResult<T>> => {
    try {
      return { ok: true, ...await task() }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      const reason = code === 'ENOENT' ? 'HTML 文件不存在或输出目录不可用'
        : code === 'EACCES' || code === 'EPERM' ? '没有权限读取 HTML 或保存文件'
          : error instanceof Error ? `页面渲染或文件保存失败（${error.message}）` : '无法完成导出'
      return { ok: false, error: `导出失败：${reason}` }
    }
  })
  queue = result
  return result
}

async function render<T>(
  options: PdfExportOptions,
  width: number,
  height: number,
  capture: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
  if (!options || typeof options.htmlPath !== 'string' || !path.isAbsolute(options.htmlPath)) {
    throw new Error('请提供 HTML 文件的绝对路径')
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('图片宽高必须为正整数')
  }
  if (options.outPath !== undefined && (typeof options.outPath !== 'string' || !path.isAbsolute(options.outPath))) {
    throw new Error('请提供保存文件的绝对路径')
  }
  if (options.outPath && path.resolve(options.outPath) === path.resolve(options.htmlPath)) {
    throw new Error('保存路径不能覆盖 HTML 源文件')
  }
  if (!(await fs.stat(options.htmlPath)).isFile()) throw new Error('HTML 路径不是文件')

  let win: BrowserWindow | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        javascript: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    const window = win
    return await Promise.race([
      (async () => {
        // loadFile resolves after did-finish-load.
        await window.loadFile(options.htmlPath)
        window.setContentSize(width, height)
        await window.webContents.executeJavaScript(`(async () => {
          await document.fonts.ready
          await new Promise(resolve => requestAnimationFrame(resolve))
        })()`)
        return capture(window)
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('页面渲染超时，请检查 HTML 和字体资源')), 30_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (win && !win.isDestroyed()) win.destroy()
  }
}

async function save(options: PdfExportOptions, extension: string, data: Buffer): Promise<string> {
  const output = options.outPath || path.join(path.dirname(options.htmlPath), `${path.parse(options.htmlPath).name}.${extension}`)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, data)
  return output
}

export function exportImage(options: ImageExportOptions): Promise<ExportResult<{ path: string; width: number; height: number }>> {
  return enqueue(async () => {
    const result = await render(options, options?.width, options?.height, async (win) => {
      let rect: Electron.Rectangle | undefined
      if (options.selector !== undefined) {
        rect = await win.webContents.executeJavaScript(`(async () => {
          let element
          try { element = document.querySelector(${JSON.stringify(options.selector)}) }
          catch { throw new Error('截图选择器无效') }
          if (!element) throw new Error('未找到需要截图的元素')
          element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          await new Promise(resolve => requestAnimationFrame(resolve))
          const box = element.getBoundingClientRect()
          const x = Math.floor(box.left), y = Math.floor(box.top)
          const width = Math.ceil(box.right) - x, height = Math.ceil(box.bottom) - y
          if (width <= 0 || height <= 0) throw new Error('截图元素没有可见尺寸')
          if (x < 0 || y < 0 || x + width > innerWidth || y + height > innerHeight)
            throw new Error('截图元素超出画布，请增大导出宽高')
          return { x, y, width, height }
        })()`)
      }
      const width = rect?.width ?? options.width
      const height = rect?.height ?? options.height
      const image = await win.webContents.capturePage(rect)
      if (image.isEmpty()) throw new Error('页面截图为空')
      // Keep shared cards at the requested pixel dimensions on Retina displays too.
      return { data: image.resize({ width, height }).toPNG(), width, height }
    })
    const output = await save(options, 'png', result.data)
    return { path: output, width: result.width, height: result.height }
  })
}

export function exportPdf(options: PdfExportOptions): Promise<ExportResult<{ path: string }>> {
  return enqueue(async () => {
    const data = await render(options, 1080, 1440, (win) =>
      win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' }),
    )
    return { path: await save(options, 'pdf', data) }
  })
}
