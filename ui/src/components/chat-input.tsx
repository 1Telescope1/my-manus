'use client'

import {useState, useRef, forwardRef, useImperativeHandle} from 'react'
import {cn, formatFileSize} from '@/lib/utils'
import {ScrollArea, ScrollBar} from '@/components/ui/scroll-area'
import {Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle} from '@/components/ui/item'
import {Avatar, AvatarGroupCount} from '@/components/ui/avatar'
import {ArrowUp, FileText, Paperclip, XCircle, Loader2, Pause} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {fileApi} from '@/lib/api/file'
import type {FileInfo} from '@/lib/api/types'
import {toast} from 'sonner'

interface ChatInputProps {
  className?: string
  onInputValueChange?: (value: string) => void
  onSend?: (message: string, files: FileInfo[]) => Promise<void>
  disabled?: boolean
  /** 当前会话 ID，上传附件时会关联到该会话 */
  sessionId?: string | null
  /** 任务是否正在运行中 */
  isRunning?: boolean
  /** 点击暂停按钮的回调 */
  onStop?: () => void
  /** 会话详情页使用更紧凑的输入器 */
  compact?: boolean
}

export interface ChatInputRef {
  setInputText: (text: string) => void
  getInputValue: () => string
  getFiles: () => FileInfo[]
}

export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(
  ({ className, onInputValueChange, onSend, disabled = false, sessionId, isRunning = false, onStop, compact = false }, ref) => {
    const [files, setFiles] = useState<FileInfo[]>([])
    const [uploading, setUploading] = useState(false)
    const [sending, setSending] = useState(false)
    const [inputValue, setInputValue] = useState('')
    const fileInputRef = useRef<HTMLInputElement>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      setInputValue(value)
      onInputValueChange?.(value)
    }

    useImperativeHandle(ref, () => ({
      setInputText: (text: string) => {
        setInputValue(text)
        onInputValueChange?.(text)
        // 聚焦到输入框
        textareaRef.current?.focus()
      },
      getInputValue: () => inputValue,
      getFiles: () => files,
    }))

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = event.target.files
      if (!selectedFiles || selectedFiles.length === 0) {
        return
      }

      setUploading(true)

      try {
        const uploadPromises = Array.from(selectedFiles).map(async (file) => {
          try {
            const fileInfo = await fileApi.uploadFile({
              file,
              ...(sessionId && { session_id: sessionId }),
            })
            return fileInfo
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '上传失败'
            toast.error(`文件「${file.name}」上传失败: ${errorMessage}`)
            return null
          }
        })

        const uploadedFiles = (await Promise.all(uploadPromises)).filter(
          (file): file is FileInfo => file !== null
        )

        if (uploadedFiles.length > 0) {
          setFiles((prev) => [...prev, ...uploadedFiles])
          toast.success(`成功上传 ${uploadedFiles.length} 个文件`)
        }
      } catch {
        toast.error('文件上传过程中发生错误')
      } finally {
        setUploading(false)
        // 重置input，以便可以重复选择同一文件
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
      }
    }

    const handleUploadClick = () => {
      fileInputRef.current?.click()
    }

    const handleRemoveFile = (fileId: string) => {
      setFiles((prev) => prev.filter((file) => file.id !== fileId))
    }

    const handleSend = async () => {
      const trimmedMessage = inputValue.trim()
      
      // 验证消息不为空
      if (!trimmedMessage) {
        toast.error('请输入消息内容')
        textareaRef.current?.focus()
        return
      }

      // 如果提供了 onSend 回调，使用它
      if (onSend) {
        setSending(true)
        try {
          await onSend(trimmedMessage, files)
          // 发送成功后清空输入框和文件列表
          setInputValue('')
          setFiles([])
          onInputValueChange?.('')
        } catch (error) {
          // 错误处理由 onSend 内部处理
          console.error('发送消息失败:', error)
        } finally {
          setSending(false)
        }
      }
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // 支持 Ctrl/Cmd + Enter 发送
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        handleSend()
      }
    }

    return (
    <div className={cn('paper-surface flex w-full flex-col rounded-xl border transition-shadow focus-within:border-primary/45 focus-within:shadow-[0_12px_34px_rgb(83_59_39/10%)]', compact ? 'py-2' : 'py-3', className)}>
      {/* 顶部的文件列表 */}
      {files.length > 0 && (
        <div className="w-full px-4 mb-1">
          <ScrollArea className="w-full whitespace-nowrap">
            <div className="flex w-max space-x-4 pb-4">
              {files.map((file) => (
                <Item
                  key={file.id}
                  variant="muted"
                  className="p-2 flex-shrink-0 gap-2"
                >
                  {/* 左侧文件图标 */}
                  <ItemMedia>
                    <Avatar className="size-8">
                      <AvatarGroupCount>
                        <FileText/>
                      </AvatarGroupCount>
                    </Avatar>
                  </ItemMedia>
                  {/* 文件信息 */}
                  <ItemContent className="gap-0">
                    <ItemTitle className="text-sm text-foreground">{file.filename}</ItemTitle>
                    <ItemDescription className="text-xs">
                      {file.extension} · {formatFileSize(file.size)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="cursor-pointer"
                      onClick={() => handleRemoveFile(file.id)}
                      disabled={uploading}
                      aria-label={`移除文件 ${file.filename}`}
                    >
                      <XCircle/>
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </div>
            <ScrollBar orientation="horizontal"/>
          </ScrollArea>
        </div>
      )}
      {/* 中间输入框 */}
      <div className={cn('px-4', compact ? 'mb-1' : 'mb-2')}>
        <textarea
          ref={textareaRef}
          rows={compact ? 1 : 2}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="分配一个任务或提问任何问题..."
          className={cn(
            'scrollbar-hide w-full resize-none bg-transparent text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/75',
            compact ? 'h-9 min-h-9' : 'h-[52px] min-h-[44px]'
          )}
          disabled={sending || disabled}
        />
      </div>
      {/* 底部上传&发送按钮 */}
      <footer className="flex w-full flex-row items-center justify-between px-3">
        {/* 上传按钮 */}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            disabled={uploading}
          />
          <Button
            type="button"
            variant="ghost"
            className="size-9 cursor-pointer rounded-full text-muted-foreground hover:text-foreground"
            onClick={handleUploadClick}
            disabled={uploading}
            aria-label="上传附件"
          >
            {uploading ? (
              <Loader2 className="size-4 animate-spin"/>
            ) : (
              <Paperclip/>
            )}
          </Button>
        </div>
        {/* 发送/暂停按钮 */}
        <div className="flex gap-2">
          {isRunning ? (
            // 任务运行中时显示暂停按钮
            <Button
              type="button"
              variant="outline"
              className="h-9 cursor-pointer rounded-lg border-destructive/30 px-4 text-destructive"
              onClick={onStop}
              disabled={!onStop}
              aria-label="停止任务"
            >
              <Pause className="size-4" />
              <span className="hidden sm:inline">停止</span>
            </Button>
          ) : (
            // 任务未运行时显示发送按钮
            <Button
              type="button"
              className="h-9 min-w-10 cursor-pointer rounded-lg px-3 shadow-[0_7px_16px_rgb(160_77_43/18%)] sm:min-w-[92px]"
              onClick={handleSend}
              disabled={sending || disabled || !inputValue.trim()}
              aria-label="发送消息"
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin"/>
              ) : (
                <>
                  <span className="hidden sm:inline">发送</span>
                  <ArrowUp/>
                </>
              )}
            </Button>
          )}
        </div>
      </footer>
    </div>
    )
  }
)

ChatInput.displayName = 'ChatInput'
