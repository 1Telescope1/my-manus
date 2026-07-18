'use client'

import Link from 'next/link'
import {SidebarTrigger, useSidebar} from '@/components/ui/sidebar'
import {ManusSettings} from '@/components/manus-settings'
import {Feather} from 'lucide-react'

export function ChatHeader() {
  const {open, isMobile} = useSidebar()

  return (
    <header className="flex h-16 justify-between items-center w-full px-4 sm:px-6 z-50">
      {/* 左侧操作&logo */}
      <div className="flex items-center gap-2">
        {/* 面板操作按钮: 关闭面板&移动端下会显示 */}
        {(!open || isMobile) && <SidebarTrigger className="cursor-pointer"/>}
        {(!open || isMobile) && (
          <Link href="/" className="flex items-center gap-2 text-foreground">
            <Feather className="size-5 text-primary" strokeWidth={1.8}/>
            <span className="font-editorial text-lg">Manus</span>
          </Link>
        )}
      </div>
      {/* 右侧设置模态窗 */}
      <ManusSettings/>
    </header>
  )
}
