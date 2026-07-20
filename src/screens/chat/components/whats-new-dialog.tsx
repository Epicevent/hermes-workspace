import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useQuery } from '@tanstack/react-query'
import type { VersionEntry } from '@/versions'
import { Button } from '@/components/ui/button'
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog'

type WhatsNewDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type VersionsResponse = {
  ok?: boolean
  current?: string
  build?: string
  versions?: Array<VersionEntry>
}

export function WhatsNewDialog({ open, onOpenChange }: WhatsNewDialogProps) {
  const { data } = useQuery({
    queryKey: ['versions'],
    queryFn: async (): Promise<VersionsResponse> => {
      const res = await fetch('/api/versions')
      if (!res.ok) throw new Error('Failed to load versions')
      return (await res.json()) as VersionsResponse
    },
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })
  const versions = data?.versions ?? []

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(70dvh,560px)] w-[min(480px,92vw)] flex-col overflow-hidden p-0">
        <div className="flex items-start justify-between border-b border-primary-200 p-4 pb-3">
          <div>
            <DialogTitle className="mb-1 text-balance">What's new</DialogTitle>
            <DialogDescription className="text-pretty">
              {data?.current ? `현재 버전 ${data.current}` : ''}
            </DialogDescription>
          </div>
          <DialogClose
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-primary-500 hover:bg-primary-100 dark:hover:bg-primary-800 hover:text-primary-700"
                aria-label="Close"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={20} strokeWidth={1.5} />
              </Button>
            }
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 pt-3">
          {versions.length === 0 ? (
            <div className="py-6 text-center text-sm text-primary-500">
              업데이트 내역이 없습니다
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {versions.map((entry) => (
                <div key={entry.version}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-primary-950">
                      {entry.version}
                    </span>
                    <span className="text-[11px] text-primary-500">
                      {entry.date}
                    </span>
                  </div>
                  {entry.notes.length > 0 ? (
                    <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5">
                      {entry.notes.map((note) => (
                        <li key={note} className="text-sm text-primary-800">
                          {note}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {data?.build ? (
          <div className="border-t border-primary-200 px-4 py-2 text-right text-[11px] text-primary-400">
            build {data.build}
          </div>
        ) : null}
      </DialogContent>
    </DialogRoot>
  )
}
