import { useCallback, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { chatQueryKeys } from '../chat-queries'
import { readError } from '../utils'

export type MoveSessionToFolderResult = {
  /** Move a session into a folder; pass null to move it back to top level. */
  moveSessionToFolder: (
    sessionKey: string,
    friendlyId: string | null,
    folderPath: string | null,
  ) => Promise<void>
  moving: boolean
  error: string | null
}

type MovePayload = {
  sessionKey: string
  friendlyId?: string | null
  folderPath: string | null
}

export function useMoveSessionToFolder(): MoveSessionToFolderResult {
  const queryClient = useQueryClient()
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async function moveSessionRequest(payload: MovePayload) {
      const res = await fetch('/api/sessions', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionKey: payload.sessionKey,
          friendlyId: payload.friendlyId ?? undefined,
          folderPath: payload.folderPath,
        }),
      })
      if (!res.ok) throw new Error(await readError(res))
      return payload
    },
    onMutate: async function onMutate(payload) {
      setError(null)
      await queryClient.cancelQueries({ queryKey: chatQueryKeys.sessions })
      const previousSessions = queryClient.getQueryData(chatQueryKeys.sessions)

      const targetId = payload.friendlyId || payload.sessionKey
      queryClient.setQueryData(
        chatQueryKeys.sessions,
        function update(sessions: unknown) {
          if (!Array.isArray(sessions)) return sessions
          return (sessions as Array<Record<string, unknown>>).map((session) => {
            const key = typeof session.key === 'string' ? session.key : ''
            const friendlyId =
              typeof session.friendlyId === 'string' ? session.friendlyId : ''
            if (key !== payload.sessionKey && friendlyId !== targetId)
              return session
            return {
              ...session,
              folderPath: payload.folderPath ?? undefined,
            }
          })
        },
      )

      return { previousSessions }
    },
    onError: function onError(err, _payload, context) {
      if (context?.previousSessions) {
        queryClient.setQueryData(
          chatQueryKeys.sessions,
          context.previousSessions,
        )
      }
      setError(err instanceof Error ? err.message : String(err))
    },
    onSuccess: function onSuccess() {
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.sessions })
    },
    onSettled: function onSettled() {
      setMoving(false)
    },
  })

  const moveSessionToFolder = useCallback(
    async (
      sessionKey: string,
      friendlyId: string | null,
      folderPath: string | null,
    ) => {
      if (!sessionKey) return
      setMoving(true)
      await mutation.mutateAsync({
        sessionKey,
        friendlyId: friendlyId ?? undefined,
        folderPath,
      })
    },
    [mutation],
  )

  return { moveSessionToFolder, moving, error }
}
