'use client'

import {useCallback, useSyncExternalStore} from 'react'
import {CheckCircle2, Circle, Loader2, MoreHorizontal, Trash} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {Item, ItemActions, ItemContent, ItemDescription, ItemMedia} from '@/components/ui/item'
import {formatRelativeDate} from '@/lib/utils'
import type {Session} from '@/lib/api'

type SessionItemProps = {
  session: Session
  isActive: boolean
  onClick: (sessionId: string) => void
  onDelete: (session: Session) => void
}

/**
 * 单个会话列表项
 * 展示会话标题、描述、时间及操作菜单
 */
export function SessionItem({session, isActive, onClick, onDelete}: SessionItemProps) {
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  )

  const handleClick = useCallback(() => {
    onClick(session.session_id)
  }, [onClick, session.session_id])

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(session)
  }, [onDelete, session])

  const dateLabel = formatRelativeDate(session.latest_message_at)
  const isRunning = session.status === 'running' || session.status === 'waiting'
  const statusLabel = session.status === 'completed'
    ? '任务完成'
    : session.status === 'running'
      ? '执行中'
      : session.status === 'waiting'
        ? '等待回复'
        : (session.latest_message || '草稿')

  return (
    <Item
      className={`group rounded-lg border border-transparent px-3 py-2.5 hover:bg-sidebar-accent/70 cursor-pointer gap-2.5 items-start transition-colors ${isActive ? 'bg-sidebar-accent border-primary/10' : ''}`}
      onClick={handleClick}
    >
      {/* 左侧图标 */}
      <ItemMedia>
        <span className={`mt-0.5 flex size-5 items-center justify-center ${session.status === 'completed' ? 'text-success' : 'text-muted-foreground'}`}>
          {isRunning
            ? <Loader2 className="size-4 animate-spin"/>
            : session.status === 'completed'
              ? <CheckCircle2 className="size-4"/>
              : <Circle className="size-4"/>
          }
        </span>
      </ItemMedia>
      {/* 中间内容 */}
      <ItemContent className="gap-0 min-w-0">
        <p className="text-sm font-medium leading-5 text-foreground truncate">
          {session.title || '新任务'}
        </p>
        <p className={`text-xs leading-5 truncate ${session.status === 'completed' ? 'text-success' : 'text-muted-foreground'}`}>
          {statusLabel}
        </p>
      </ItemContent>
      {/* 右侧操作区 */}
      <ItemActions className="flex flex-col pt-0.5 gap-0 self-start">
        <ItemDescription className="text-[11px] whitespace-nowrap text-muted-foreground">{dateLabel}</ItemDescription>
        {mounted && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                className="cursor-pointer"
                onClick={(e) => e.stopPropagation()}
                aria-label={`管理任务：${session.title || '新任务'}`}
              >
                <MoreHorizontal/>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="bottom">
              <DropdownMenuItem
                variant="destructive"
                className="cursor-pointer"
                onClick={handleDelete}
              >
                <Trash/>
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </ItemActions>
    </Item>
  )
}
