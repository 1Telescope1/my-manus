'use client'

import {useEffect} from 'react'
import {useRouter} from 'next/navigation'
import {Sidebar, SidebarContent, SidebarHeader, SidebarTrigger} from '@/components/ui/sidebar'
import {Button} from '@/components/ui/button'
import {Feather, ListTodo, Plus} from 'lucide-react'
import {Kbd, KbdGroup} from '@/components/ui/kbd'
import {SessionList} from '@/components/session-list'

export function LeftPanel() {
  const router = useRouter()

  useEffect(() => {
    const handleNewTask = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        router.push('/')
      }
    }

    window.addEventListener('keydown', handleNewTask)
    return () => window.removeEventListener('keydown', handleNewTask)
  }, [router])

  return (
    <Sidebar className="border-sidebar-border">
      <SidebarHeader className="px-4 pt-5 pb-3">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2.5 text-left"
            onClick={() => router.push('/')}
            aria-label="返回首页"
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Feather className="size-[18px]" strokeWidth={1.8}/>
            </span>
            <span className="font-editorial truncate text-[22px] leading-none text-foreground">MoocManus</span>
          </button>
          <SidebarTrigger className="cursor-pointer text-muted-foreground hover:text-foreground"/>
        </div>
      </SidebarHeader>
      <SidebarContent className="px-3 pb-4">
        <Button
          className="mb-5 h-11 w-full cursor-pointer justify-start rounded-lg px-4 text-[15px] shadow-[0_8px_18px_rgb(160_77_43/14%)]"
          onClick={() => router.push('/')}
        >
          <Plus/>
          <span className="flex-1 text-left">新建任务</span>
          <KbdGroup className="opacity-75">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Button>
        <div className="mb-2 flex items-center gap-2 border-b border-sidebar-border px-2 pb-3 text-sm font-medium text-muted-foreground">
          <ListTodo className="size-4"/>
          <span>任务</span>
        </div>
        <SessionList/>
      </SidebarContent>
    </Sidebar>
  )
}
