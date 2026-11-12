import type { ExportResult } from '../types'

const unsupported = (): { ok: false; error: string } => ({ ok: false, error: '当前环境不支持导出' })

export function saveCardImage(
  htmlPath: string,
  { width = 1080, height = 1440, outPath }: { width?: number; height?: number; outPath?: string } = {},
): Promise<ExportResult<{ path: string; width: number; height: number }>> {
  return window.electronAPI?.exportImage?.({ htmlPath, width, height, outPath }) ?? Promise.resolve(unsupported())
}

export function saveCardPdf(htmlPath: string): Promise<ExportResult<{ path: string }>> {
  return window.electronAPI?.exportPdf?.({ htmlPath }) ?? Promise.resolve(unsupported())
}

export function openImage(path: string): Promise<string> {
  return window.electronAPI?.openPath(path) ?? Promise.resolve('当前环境不支持打开文件')
}

export function revealInFolder(path: string): Promise<void> {
  return window.electronAPI?.revealPath?.(path) ?? Promise.resolve()
}
