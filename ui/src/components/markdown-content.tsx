'use client'

import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

export interface MarkdownContentProps {
  content: unknown
  className?: string
}

/**
 * remark-gfm autolink 对紧跟 CJK 字符的 URL 边界检测不准确，
 * 会将 `https://example.com，后续中文` 整段识别为链接。
 * 在 URL 与相邻 CJK 字符/标点之间插入空格修正边界。
 */
const CJK_RANGES = '\u3000-\u303F\u4E00-\u9FFF\uFF01-\uFF60'
const URL_FOLLOWED_BY_CJK = new RegExp(
  `(https?:\\/\\/[^\\s${CJK_RANGES}]+)([${CJK_RANGES}])`,
  'g',
)

function normalizeAutolinks(value: unknown): string {
  let text: string

  if (typeof value === 'string') {
    text = value
  } else if (value == null) {
    text = ''
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }

  return text.replace(URL_FOLLOWED_BY_CJK, '$1 $2')
}

const headingClasses: Record<string, string> = {
  h1: 'font-editorial text-2xl mt-7 mb-3 first:mt-0 text-foreground',
  h2: 'font-editorial text-xl mt-7 mb-3 first:mt-0 text-foreground border-l-2 border-primary pl-3',
  h3: 'font-editorial text-lg mt-5 mb-2 first:mt-0 text-foreground',
  h4: 'text-base font-semibold mt-4 mb-2 first:mt-0 text-foreground',
  h5: 'text-sm font-semibold mt-3 mb-1 first:mt-0 text-foreground',
  h6: 'text-sm font-medium mt-2 mb-1 first:mt-0 text-muted-foreground',
}

const components: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h1: ({ node, className, ...props }) => (
    <h1 className={cn(headingClasses.h1, className)} {...props} />
  ),
  h2: ({ node, className, ...props }) => (
    <h2 className={cn(headingClasses.h2, className)} {...props} />
  ),
  h3: ({ node, className, ...props }) => (
    <h3 className={cn(headingClasses.h3, className)} {...props} />
  ),
  h4: ({ node, className, ...props }) => (
    <h4 className={cn(headingClasses.h4, className)} {...props} />
  ),
  h5: ({ node, className, ...props }) => (
    <h5 className={cn(headingClasses.h5, className)} {...props} />
  ),
  h6: ({ node, className, ...props }) => (
    <h6 className={cn(headingClasses.h6, className)} {...props} />
  ),
  p: ({ node, className, ...props }) => (
    <p className={cn('mb-3 text-[15px] leading-7 text-foreground/88 last:mb-0', className)} {...props} />
  ),
  ul: ({ node, className, ...props }) => (
    <ul className={cn('mb-3 list-disc space-y-1.5 pl-5 text-[15px] text-foreground/88 marker:text-primary', className)} {...props} />
  ),
  ol: ({ node, className, ...props }) => (
    <ol className={cn('mb-3 list-decimal space-y-1.5 pl-5 text-[15px] text-foreground/88 marker:text-primary', className)} {...props} />
  ),
  li: ({ node, className, ...props }) => (
    <li className={cn('leading-7', className)} {...props} />
  ),
  strong: ({ node, className, ...props }) => (
    <strong className={cn('font-semibold text-foreground', className)} {...props} />
  ),
  code: ({ node, className, children, ...props }) => {
    const text = typeof children === 'string' ? children : ''
    const isBlock = text.includes('\n')
    return (
      <code
        className={cn(
          isBlock
            ? 'my-3 block overflow-x-auto rounded-lg border border-border bg-secondary/65 p-4 font-mono text-sm text-foreground'
            : 'inline rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.8125em] text-foreground',
          className
        )}
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ node, className, ...props }) => (
    <pre className={cn('my-3 overflow-x-auto', className)} {...props} />
  ),
  blockquote: ({ node, className, ...props }) => (
    <blockquote
      className={cn(
        'my-4 rounded-r-lg border-l-2 border-primary bg-accent/45 px-4 py-3 text-sm text-foreground/75',
        className
      )}
      {...props}
    />
  ),
  a: ({ node, className, href, children, ...props }) => {
    // 安全兜底：如果 href 包含 CJK 字符，说明 autolink 仍然误判，降级为纯文本
    if (href && /[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(href)) {
      return <span className="text-sm text-foreground/80">{children}</span>
    }
    return (
      <a
        className={cn('text-sm font-medium text-primary underline-offset-4 hover:underline', className)}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    )
  },
  table: ({ node, className, ...props }) => (
    <div className="my-5 overflow-x-auto rounded-xl border border-border bg-card">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  ),
  th: ({ node, className, ...props }) => (
    <th className={cn('border-b border-border bg-secondary/65 px-4 py-3 text-left font-semibold text-foreground', className)} {...props} />
  ),
  td: ({ node, className, ...props }) => (
    <td className={cn('border-b border-border/70 px-4 py-3 align-top text-foreground/80 last:border-r-0', className)} {...props} />
  ),
  hr: ({ node, className, ...props }) => (
    <hr className={cn('my-7 border-border', className)} {...props} />
  ),
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  const normalized = useMemo(() => normalizeAutolinks(content), [content])

  return (
    <div className={cn('markdown-content break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {normalized}
      </ReactMarkdown>
    </div>
  )
}
