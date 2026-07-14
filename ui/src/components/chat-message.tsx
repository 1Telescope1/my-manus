'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { CheckIcon, ChevronDown, Languages } from 'lucide-react'
import { ToolUse } from '@/components/tool-use'
import { AttachmentsMessage } from '@/components/attachments-message'
import { MarkdownContent } from '@/components/markdown-content'
import type { ToolEvent } from '@/lib/api/types'
import { type TimelineItem, type AttachmentFile, getToolTimeLabel } from '@/lib/session-events'

export interface ChatMessageProps {
  className?: string
  item: TimelineItem
  onViewAllFiles?: () => void
  onFileClick?: (file: AttachmentFile) => void
  onToolClick?: (tool: ToolEvent) => void
}

function ToolRow({
  className,
  timeLabel,
  children,
}: {
  className?: string
  timeLabel?: string
  children: React.ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 mt-3 w-full min-w-0',
        className
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      <span
        className={cn(
          'flex-shrink-0 text-xs text-muted-foreground min-w-[2.5rem] text-right transition-opacity duration-150',
          hovered ? 'opacity-100' : 'opacity-0'
        )}
      >
        {timeLabel ?? '刚刚'}
      </span>
    </div>
  )
}

export function ChatMessage({
  className,
  item,
  onViewAllFiles,
  onFileClick,
  onToolClick,
}: ChatMessageProps) {
  if (item.kind === 'user') {
    return (
      <div
        className={cn(
          'flex w-full flex-col items-end justify-end gap-1 group mt-3',
          className
        )}
      >
        <div className="relative flex max-w-[90%] flex-col items-end gap-2 sm:max-w-[78%]">
          <div className="paper-surface relative flex items-center overflow-hidden rounded-xl border px-4 py-3 text-[15px] leading-6 text-foreground">
            {item.data.message ?? ''}
          </div>
        </div>
      </div>
    )
  }

  if (item.kind === 'assistant') {
    return (
      <div
        className={cn('flex flex-col gap-2 w-full group mt-3', className)}
      >
        <div className="flex h-7 items-center justify-between group">
          <div className="flex items-center justify-center gap-2 text-foreground">
            <Languages size={17} className="text-primary" />
            <span className="font-editorial text-base">manus</span>
          </div>
        </div>
        <div className="m-0 max-w-none p-0 text-foreground">
          <MarkdownContent content={item.data.message ?? ''} />
        </div>
      </div>
    )
  }

  if (item.kind === 'tool') {
    return (
      <ToolRow
        className={className}
        timeLabel={item.timeLabel}
      >
        <ToolUse data={item.data} onClick={onToolClick ? () => onToolClick(item.data) : undefined} />
      </ToolRow>
    )
  }

  if (item.kind === 'step') {
    return (
      <StepBlock stepItem={item} className={className} onToolClick={onToolClick} />
    )
  }

  if (item.kind === 'attachments') {
    return (
      <div className={cn('mt-3', className)}>
        <AttachmentsMessage
          role={item.role}
          files={item.files}
          onViewAllFiles={item.role === 'assistant' ? onViewAllFiles : undefined}
          onFileClick={onFileClick}
        />
      </div>
    )
  }

  if (item.kind === 'error') {
    return (
      <div
        className={cn('flex flex-col gap-2 w-full group mt-3', className)}
      >
        <div className="flex items-center justify-between h-7 group">
          <div className="flex items-center justify-center gap-1 text-red-600">
            <Languages size={18} />
            <span className="font-editorial text-base">manus</span>
          </div>
        </div>
        <div className="max-w-none p-0 m-0 text-red-600">
          <MarkdownContent content={item.error} />
        </div>
      </div>
    )
  }

  return null
}

function StepBlock({
  stepItem,
  className,
  onToolClick,
}: {
  stepItem: Extract<TimelineItem, { kind: 'step' }>
  className?: string
  onToolClick?: (tool: ToolEvent) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const { data, tools } = stepItem
  const isCompleted = data.status === 'completed'

  return (
    <div className={cn('mt-3 flex flex-col', className)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="group/header flex w-full cursor-pointer justify-between gap-2 rounded-lg px-1 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-ring/35"
      >
        <div className="flex flex-row gap-2 justify-start items-center truncate min-w-0 flex-1">
          <div
            className={cn(
              'flex size-[18px] flex-shrink-0 items-center justify-center rounded-full border',
              isCompleted ? 'border-success bg-success' : 'border-primary/30 bg-primary/10'
            )}
          >
            <CheckIcon className={isCompleted ? 'text-success-foreground' : 'text-primary'} size={11} />
          </div>
          <div className="truncate font-medium markdown-content min-w-0">
            {data.description}
          </div>
          <ChevronDown
            className={cn('flex-shrink-0 transition-transform text-muted-foreground', expanded && 'rotate-180')}
          />
        </div>
      </button>
      {expanded && tools.length > 0 && (
        <div className="flex">
          <div className="w-6 relative flex-shrink-0">
            <div className="absolute bottom-0 left-[8px] top-2 w-px border-l border-dashed border-success/35" />
          </div>
          <div className="flex flex-col gap-3 flex-1 min-w-0 overflow-hidden pt-2 transition-[max-height,opacity] duration-150 ease-in-out">
            {tools.map((tool, idx) => (
              <ToolRow key={`${data.id}-tool-${idx}`} timeLabel={getToolTimeLabel(tool)}>
                <ToolUse data={tool} onClick={onToolClick ? () => onToolClick(tool) : undefined} />
              </ToolRow>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
