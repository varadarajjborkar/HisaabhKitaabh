'use client'

import type { SheetDoc } from '@/lib/model/types'
import { toCsv, toEmail, toPlainText, toPrintableHtml, type ExportOptions } from '@/lib/util/export'
import { toast } from '@/components/ui/Toast'

/**
 * Export actions, all client-side.
 *
 * Nothing here round-trips to the server: the document is already in memory,
 * and rendering it locally means export works instantly and offline. PDF is
 * produced by handing the browser a print stylesheet rather than shipping a
 * PDF library - a few hundred bytes of CSS against ~300KB of jsPDF, and the
 * output honours the user's own paper size and margins.
 */

export function downloadCsv(doc: SheetDoc): void {
  const blob = new Blob(['﻿' + toCsv(doc)], { type: 'text/csv;charset=utf-8' })
  triggerDownload(blob, `${safeFileName(doc.name)}.csv`)
  toast.success('CSV downloaded')
}

export function downloadPdf(doc: SheetDoc): void {
  const html = toPrintableHtml(doc)
  // A hidden iframe rather than a popup: no blocker, and the parent page keeps
  // its scroll position and focus.
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)

  const cleanup = () => setTimeout(() => frame.remove(), 1000)

  frame.onload = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
    } catch {
      toast.error('Could not open the print dialog', 'Try the browser’s own Print command.')
    } finally {
      cleanup()
    }
  }

  const blob = new Blob([html], { type: 'text/html' })
  frame.src = URL.createObjectURL(blob)
  toast.info('Choose "Save as PDF" in the print dialog')
}

export async function copyToClipboard(doc: SheetDoc, options: ExportOptions = {}): Promise<void> {
  // A clipboard destination is usually wider than a mail window: a note, a
  // code block, a spreadsheet paste. 100 columns keeps captions on one line
  // where the mail budget of 72 would have wrapped them.
  const text = toPlainText(doc, { maxWidth: 100, ...options })
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied', 'Columns are space-aligned, ready to paste.')
  } catch {
    // Clipboard API needs a secure context and permission; fall back to a
    // hidden textarea, which works everywhere including older mobile browsers.
    const area = document.createElement('textarea')
    area.value = text
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    ok ? toast.success('Copied') : toast.error('Could not copy', 'Select the table and copy manually.')
  }
}

export function openMailDraft(doc: SheetDoc, options: ExportOptions = {}): void {
  const { subject, body } = toEmail(doc, options)

  // mailto: has a practical length ceiling of a couple of thousand characters
  // in most clients. Beyond that the body silently truncates mid-line, which
  // would cut the table in half. Cut it at a line boundary instead, keeping
  // whole rows, and put the complete table on the clipboard to paste in.
  const MAILTO_LIMIT = 1800
  let finalBody = body

  if (body.length > MAILTO_LIMIT) {
    void copyToClipboard(doc, options)
    const lines = body.split('\n')
    const kept: string[] = []
    let used = 0
    for (const line of lines) {
      if (used + line.length + 1 > MAILTO_LIMIT - 160) break
      kept.push(line)
      used += line.length + 1
    }
    finalBody = [
      ...kept,
      '',
      `(This file has ${doc.rows.filter((r) => !r.deleted).length} rows and the draft could not hold all of them.`,
      'The complete table is on your clipboard. Paste it here.)',
    ].join('\n')
  }

  window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(finalBody)}`
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function safeFileName(name: string): string {
  return name.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').slice(0, 60) || 'hisaabkitaab'
}
