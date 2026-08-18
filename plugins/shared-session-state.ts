/** Sessions that hit the build read cap — bash cat/head/sleep will not help. */
export const dumpCapSessions = new Set<string>()

/** Consecutive blocked tool calls — abort child sessions before vLLM is hammered. */
export const consecutiveToolBlocks = new Map<string, number>()
export const abortedSessions = new Set<string>()
const sessionParent = new Map<string, string | undefined>()

/** vLLM is served with max-num-seqs=2. A looping child plus parent streaming OOMs EngineCore. */
export const ABORT_AFTER_BLOCKS = 6

export function clearToolBlock(sessionID: string) {
  consecutiveToolBlocks.set(sessionID, 0)
}

export function rememberSession(sessionID: string, parentID?: string) {
  sessionParent.set(sessionID, parentID)
}

export function isChildSession(sessionID: string): boolean {
  return Boolean(sessionParent.get(sessionID))
}

type AbortClient = {
  session: {
    abort: (opts: { path: { id: string } }) => Promise<unknown>
    get?: (opts: { path: { sessionID: string; id?: string } }) => Promise<{
      data?: { parentID?: string }
      parentID?: string
    }>
  }
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

async function isSubagent(client: AbortClient, sessionID: string): Promise<boolean> {
  if (sessionParent.has(sessionID)) return Boolean(sessionParent.get(sessionID))
  if (!client.session.get) {
    sessionParent.set(sessionID, undefined)
    return false
  }
  try {
    const result = await client.session.get({
      path: { sessionID, id: sessionID },
    })
    const parent = result?.data?.parentID ?? result?.parentID
    sessionParent.set(sessionID, parent)
    return Boolean(parent)
  } catch {
    sessionParent.set(sessionID, undefined)
    return false
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

  // Dump-cap / cat retries on the primary apply look like a user interrupt.
  // Only abort looping @explore children — those are what crash vLLM.
  if (!(await isSubagent(client, sessionID))) {
    try {
      await client.app.log({
        body: {
          service: "tool-loop-abort",
          level: "info",
          message: "skip abort on primary session",
          extra: { sessionID, n, reason },
        },
      })
    } catch {
      // Logging must never throw back into the tool hook.
    }
    return n
  }

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
