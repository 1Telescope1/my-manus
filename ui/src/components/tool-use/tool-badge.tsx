'use client'

import type { LucideIcon } from 'lucide-react'

export interface ToolBadgeProps {
  icon: LucideIcon
  label: string
  onClick?: () => void
}

export function ToolBadge({ icon: Icon, label, onClick }: ToolBadgeProps) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
      className="inline-flex w-fit max-w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-secondary/65 px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:border-primary/20 hover:bg-accent/70"
    >
      <span className="flex shrink-0 items-center justify-center text-primary/80">
        <Icon size={16} className="shrink-0" />
      </span>
      <span className="min-w-0 flex-1 truncate sm:max-w-[480px]">{label}</span>
    </div>
  )
}
