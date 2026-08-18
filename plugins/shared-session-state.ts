/** Sessions that hit the build read cap — bash cat/head/sleep will not help. */
export const dumpCapSessions = new Set<string>()

/** Consecutive blocked tool calls — abort before vLLM is hammered. */
export const consecutiveToolBlocks = new Map<string, number>()
export const abortedSessions = new Set<string>()

/** vLLM is served with max-num-seqs=2. A looping child plus parent streaming OOMs EngineCore. */
export const ABORT_AFTER_BLOCKS = 6

export function clearToolBlock(sessionID: string) {
  consecutiveToolBlocks.set(sessionID, 0)
}

type AbortClient = {
  session: { abort: (opts: { path: { id: string } }) => Promise<unknown> }
  app: {
    log: (opts: {
      body: {
        service: string
        level: string
        message: string
        extra?: Record<string, unknown>
      }
    }) => Promise<unknown>
  }
}

export async function recordToolBlock(
  client: AbortClient,
  sessionID: string,
  reason: string,
): Promise<number> {
  const n = (consecutiveToolBlocks.get(sessionID) ?? 0) + 1
  consecutiveToolBlocks.set(sessionID, n)
  if (n < ABORT_AFTER_BLOCKS || abortedSessions.has(sessionID)) return n

  abortedSessions.add(sessionID)
  try {
    await client.app.log({
      body: {
        service: "tool-loop-abort",
        level: "info",
        message: "aborting session after blocked-tool loop",
        extra: { sessionID, n, reason },
      },
    })
    await client.session.abort({ path: { id: sessionID } })
  } catch {
    // Abort must never throw back into the tool hook.
  }
  return n
}
