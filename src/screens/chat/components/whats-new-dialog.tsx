import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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
  mode?: 'owner' | 'customer'
  current?: string
  build?: string
  versions?: Array<VersionEntry>
}

/**
 * Owner-mode inline note editor (OpenClaw version-history parity): one
 * textarea per version, one bullet per line, saved live into the slot's
 * overlay — no rebuild. Only rendered on owner-mode images (the operator's
 * dev slot); customer images never see it and the server 403s anyway.
 */
function NoteEditor({
  entry,
  onSaved,
}: {
  entry: VersionEntry
  onSaved: () => void
}) {
  const [value, setValue] = useState(entry.notes.join('\n'))
  const [published, setPublished] = useState(entry.customerRelease === true)
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: entry.version,
          date: entry.date,
          customerRelease: published,
          notes: value.split('\n'),
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(data?.error || 'Failed to save')
      }
    },
    onSuccess: () => {
      setError(null)
      onSaved()
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })
  return (
    <div className="mt-1.5">
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="패치노트 입력 — 한 줄이 한 항목"
        rows={Math.max(2, value.split('\n').length)}
        className="w-full resize-y rounded-md border border-primary-300 bg-primary-50 px-2 py-1.5 text-sm text-primary-950 outline-none focus:border-primary-500"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        {error ? <span className="text-[11px] text-red-600">{error}</span> : null}
        {/* Publishing is a separate act from writing (OpenClaw customerRelease):
            an unchecked build stays owner-only no matter what it says. */}
        <label className="mr-auto flex items-center gap-1.5 text-[11px] text-primary-600">
          <input
            type="checkbox"
            checked={published}
            onChange={(event) => setPublished(event.target.checked)}
          />
          고객에게 공개
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          저장
        </Button>
      </div>
    </div>
  )
}

export function WhatsNewDialog({ open, onOpenChange }: WhatsNewDialogProps) {
  const queryClient = useQueryClient()
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
  const isOwner = data?.mode === 'owner'

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
                  {isOwner ? (
                    <NoteEditor
                      entry={entry}
                      onSaved={() =>
                        void queryClient.invalidateQueries({
                          queryKey: ['versions'],
                        })
                      }
                    />
                  ) : entry.notes.length > 0 ? (
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
