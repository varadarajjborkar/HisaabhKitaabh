import { Fragment, type ReactNode } from 'react'
import { parseMarkdown, safeHref, type Align, type Block, type Inline } from '@/lib/util/markdown'

/**
 * Formatted assistant text.
 *
 * The transcript used to print the source: a total came out as "**₹19,185**"
 * with the asterisks showing. The model was already writing Markdown, so this
 * is the half that was missing rather than a new capability.
 *
 * Type sizes are inherited from the caller and set in `em` here, so the same
 * component reads correctly in the 14.5px phone transcript and the 13px desktop
 * one without either being told about the other.
 */
export function Markdown({ text, className = '', streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  const blocks = parseMarkdown(text)
  return (
    <div className={`md ${streaming ? 'md-streaming' : ''} ${className}`}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
}

const HEADING_SIZE = ['text-[1.25em]', 'text-[1.15em]', 'text-[1.05em]', 'text-[1em]', 'text-[1em]', 'text-[.95em]']

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case 'p':
      // Soft line breaks are kept. A model writing "Books ₹250\nLunch ₹100"
      // means those to be two lines, and reflowing them into one would be
      // rewriting the answer rather than rendering it.
      return <p className="whitespace-pre-wrap break-words">{inlines(block.kids)}</p>

    case 'h': {
      const Tag = (`h${Math.min(block.level + 2, 6)}`) as 'h3'
      return <Tag className={`font-semibold text-ink ${HEADING_SIZE[block.level - 1]}`}>{inlines(block.kids)}</Tag>
    }

    case 'pre':
      return (
        <pre className="bg-raised border border-line rounded-lg px-2.5 py-2 overflow-x-auto overscroll-contain">
          <code className="font-mono text-[.85em] leading-relaxed">{block.v}</code>
        </pre>
      )

    case 'quote':
      return (
        <blockquote className="border-l-2 border-line pl-3 text-muted space-y-1.5">
          {block.kids.map((b, i) => <BlockView key={i} block={b} />)}
        </blockquote>
      )

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={`${block.ordered ? 'list-decimal' : 'list-disc'} pl-[1.35em] ${block.tight ? 'space-y-0.5' : 'space-y-2'} marker:text-faint`}
        >
          {block.items.map((item, i) => (
            <li key={i} className="break-words">
              {/* A tight item is one paragraph and should not open a block of
                  its own, or every bullet would sit in its own gap. */}
              {item.length === 1 && item[0].t === 'p'
                ? <span className="whitespace-pre-wrap">{inlines(item[0].kids)}</span>
                : <div className="space-y-1.5">{item.map((b, j) => <BlockView key={j} block={b} />)}</div>}
            </li>
          ))}
        </Tag>
      )
    }

    case 'table':
      return (
        <div className="overflow-x-auto overscroll-contain rounded-lg border border-line">
          <table className="w-full text-[.92em] border-collapse">
            <thead>
              <tr className="bg-raised">
                {block.head.map((cell, i) => (
                  <th key={i} className={`px-2 py-1.5 font-medium text-muted whitespace-nowrap ${cellAlign(block.align[i])}`}>
                    {inlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-t border-line">
                  {row.map((cell, j) => (
                    <td key={j} className={`px-2 py-1.5 align-top ${cellAlign(block.align[j])}`}>{inlines(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'rule':
      return <hr className="border-line" />
  }
}

function cellAlign(align: Align | undefined): string {
  return align === 'right' ? 'text-right tnum' : align === 'center' ? 'text-center' : 'text-left'
}

function inlines(kids: Inline[]): ReactNode {
  return kids.map((k, i) => <Fragment key={i}>{inline(k)}</Fragment>)
}

function inline(node: Inline): ReactNode {
  switch (node.t) {
    case 'text':
      return node.v
    case 'strong':
      return <strong className="font-semibold text-ink">{inlines(node.kids)}</strong>
    case 'em':
      return <em className="italic">{inlines(node.kids)}</em>
    case 'del':
      return <s className="opacity-70">{inlines(node.kids)}</s>
    case 'code':
      return <code className="font-mono text-[.88em] px-1 py-px rounded bg-raised border border-line">{node.v}</code>
    case 'link': {
      const href = safeHref(node.href)
      // An unsafe target is not a link. The text still reads, so nothing is
      // lost except the ability to click something the model invented.
      if (!href) return inlines(node.kids)
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2 break-all">
          {inlines(node.kids)}
        </a>
      )
    }
  }
}
