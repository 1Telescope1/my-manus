'use client'

import { cn } from '@/lib/utils'
import { useState } from 'react'
import { Check, ChevronDown, ChevronUp, CircleX, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PlanStep } from '@/lib/api/types'

export interface PlanPanelProps {
  className?: string
  /** 计划步骤列表（来自事件列表中的 plan 事件） */
  steps?: PlanStep[]
}

export function PlanPanel({ className, steps: stepsProp = [] }: PlanPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const togglePanel = () => setIsExpanded(!isExpanded)
  const steps = stepsProp

  if (steps.length === 0) return null

  // failed 与 completed 分开统计，避免失败步骤被展示成已完成进度。
  const completedCount = steps.filter((s) => s.status === 'completed').length
  const failedCount = steps.filter((s) => s.status === 'failed').length
  const totalCount = steps.length
  const stepDescription = (step: PlanStep, index: number) =>
    step.description?.trim() || `步骤 ${index + 1}`

  return (
    <div className={cn('rounded-xl border border-border bg-card shadow-[0_6px_20px_rgb(83_59_39/5%)]', className)}>
      {/* 折叠状态 */}
      {!isExpanded && <button
        type="button"
        className="relative flex w-full cursor-pointer flex-row items-start justify-between rounded-xl pr-3 text-left"
        onClick={togglePanel}
        aria-expanded={false}
      >
        {/* 左侧的最新计划 */}
        <div className="flex-1 min-w-0 relative overflow-hidden">
          <div className="w-full h-9">
            <div className="flex w-full items-center justify-center gap-2.5 truncate px-4 py-2 text-muted-foreground">
              <Clock size={16} className="text-primary" />
              <div className="flex flex-col w-full gap-0.5 truncate">
                <div className="text-sm truncate">
                  {steps[0] ? stepDescription(steps[0], 0) : '暂无步骤'}
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* 右侧操作按钮&步骤信息 */}
        <div className="flex h-full justify-center gap-2 flex-shrink-0 items-center py-2.5">
          <span className="text-xs text-muted-foreground">
            {completedCount} / {totalCount}
          </span>
          {failedCount > 0 && (
            <span className="text-xs text-red-600">{failedCount} 失败</span>
          )}
          <ChevronUp className="text-muted-foreground" size={16} />
        </div>
      </button>}
      {/* 展开状态 */}
      {isExpanded && (
        <div className="flex flex-col py-4 rounded-xl">
          <div className="flex px-4 mb-4 w-full">
            <div className="flex items-start ml-auto">
              <div className="flex items-center justify-center gap-2">
                <Button
                  onClick={togglePanel}
                  variant="ghost"
                  size="icon-xs"
                  className="cursor-pointer"
                >
                  <ChevronDown className="text-muted-foreground" size={16} />
                </Button>
              </div>
            </div>
          </div>
          <div className="px-4">
            <div className="rounded-lg bg-secondary/55 px-2 py-3">
              <div className="flex justify-between w-full px-4">
                <span className="font-editorial text-base text-foreground">任务进度</span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {completedCount} / {totalCount}
                  </span>
                  {failedCount > 0 && (
                    <span className="text-xs text-red-600">{failedCount} 失败</span>
                  )}
                </div>
              </div>
              <div className="max-h-[min(calc(100vh-360px),400px)] overflow-y-auto">
                {steps.map((step, index) => (
                <div
                  key={step.id}
                  className="flex w-full items-center gap-2.5 truncate px-4 py-2 text-sm text-muted-foreground"
                >
                  {step.status === 'completed' ? (
                    <Check size={16} className="relative top-0.5 flex-shrink-0 text-success" />
                  ) : step.status === 'failed' ? (
                    <CircleX size={16} className="relative top-0.5 flex-shrink-0 text-red-600" />
                  ) : (
                    <Clock size={16} className="relative top-0.5 flex-shrink-0" />
                  )}
                  <div className="flex flex-col w-full truncate">
                    <div className="text-sm truncate">{stepDescription(step, index)}</div>
                  </div>
                </div>
              ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
