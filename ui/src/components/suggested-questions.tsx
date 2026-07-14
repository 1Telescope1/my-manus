'use client'

import {cn} from '@/lib/utils'
import {Button} from '@/components/ui/button'
import {suggestedQuestions} from '@/config/app.config'

interface SuggestedQuestionsProps {
  className?: string
  onQuestionClick?: (question: string) => void
}

export function SuggestedQuestions({className, onQuestionClick}: SuggestedQuestionsProps) {
  const handleClick = (question: string) => {
    onQuestionClick?.(question)
  }

  return (
    <div className={cn('flex flex-wrap gap-2 sm:gap-3', className)}>
      {suggestedQuestions.map((question) => (
        <Button
          key={question}
          variant="outline"
          className="h-auto cursor-pointer whitespace-normal break-words rounded-full border-border bg-card/70 px-4 py-2 text-left text-xs text-muted-foreground shadow-none hover:border-primary/25 hover:bg-accent hover:text-foreground sm:text-sm"
          onClick={() => handleClick(question)}
        >
          {question}
        </Button>
      ))}
    </div>
  )
}
