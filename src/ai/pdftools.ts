/**
 * ghostHR PDF → raster helper for CV OCR.
 *
 * Candidates upload a PDF; we extract embedded text when available, and when
 * the PDF has no text layer (scanned/photo CV), rasterize the first pages to
 * images and hand them to the vision provider. Uses pdfjs-dist, which ships a
 * worker we load from a bundled asset.
 */

import * as pdfjs from 'pdfjs-dist'

// pdfjs needs a worker; in a Vite build we point at the bundled worker asset.
let workerReady = false
function ensureWorker() {
  if (workerReady) return
  const workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
  workerReady = true
}

/** Extract raw text from every page of a PDF (best-effort). */
export async function extractPdfText(file: Blob): Promise<string> {
  ensureWorker()
  const data = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data } as any).promise
  const parts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) parts.push(text)
    page.cleanup()
  }
  doc.destroy()
  return parts.join('\n')
}

/** Rasterize up to maxPages pages to PNG data URLs (for vision OCR). */
export async function rasterizePdf(
  file: Blob,
  maxPages = 3,
  scale = 2,
): Promise<string[]> {
  ensureWorker()
  const data = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data } as any).promise
  const pages = Math.min(doc.numPages, maxPages)
  const urls: string[] = []
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale })
    const canvas = new OffscreenCanvas(viewport.width, viewport.height)
    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, viewport } as any).promise
    urls.push(await canvasToDataUrl(canvas))
    page.cleanup()
  }
  doc.destroy()
  return urls.filter(Boolean)
}

async function canvasToDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await blobToDataUrl(blob)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
