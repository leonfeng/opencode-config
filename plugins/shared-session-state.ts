/** Sessions that hit the build read cap — bash cat/head/sleep will not help. */
export const dumpCapSessions = new Set<string>()

/** Consecutive blocked tool calls — abort child sessions before vLLM is hammered. */
export const consecutiveToolBlocks = new Map<string, number>()
export const abortedSessions = new Set<string>()

type SessionInfo = {
  parentID?: string
  agent?: string
  title?: string
  modelID?: string
}

const sessionInfo = new Map<string, SessionInfo>()
/** /opsx-explore, @explore children, or chat that entered explore mode. */
export const exploreSessions = new Set<string>()

/** vLLM is served with max-num-seqs=2. A looping child plus parent streaming OOMs EngineCore. */
export const ABORT_AFTER_BLOCKS = 6

export function clearToolBlock(sessionID: string) {
  consecutiveToolBlocks.set(sessionID, 0)
}

function looksLikeExplore(info: SessionInfo): boolean {
  return /explore/i.test(info.agent ?? "") || /explore/i.test(info.title ?? "")
}

export function rememberSession(
  sessionID: string,
  info: SessionInfo = {},
) {
  const prev = sessionInfo.get(sessionID) ?? {}
  const merged: SessionInfo = { ...prev, ...info }
  sessionInfo.set(sessionID, merged)
  if (looksLikeExplore(merged)) exploreSessions.add(sessionID)
}

/** Record the active chat model so loop guards can use model-specific thresholds. */
export function rememberSessionModel(sessionID: string, modelID: string) {
  if (!sessionID || !modelID) return
  rememberSession(sessionID, { modelID })
}

export function getSessionModelID(sessionID: string): string | undefined {
  return sessionInfo.get(sessionID)?.modelID
}

/** Nemotron rarely runaway-loops like BigBang/KAT; use looser caps to cut false blocks. */
export function isNemotronSession(sessionID: string): boolean {
  return /nemotron/i.test(getSessionModelID(sessionID) ?? "")
}

export function markExploreSession(sessionID: string) {
  exploreSessions.add(sessionID)
}

export function isChildSession(sessionID: string): boolean {
  return Boolean(sessionInfo.get(sessionID)?.parentID)
}

export function isExploreSession(sessionID: string): boolean {
  if (exploreSessions.has(sessionID)) return true
  const info = sessionInfo.get(sessionID)
  return Boolean(info && looksLikeExplore(info))
}

type AbortClient = {
  session: {
    abort: (opts: { path: { id: string } }) => Promise<unknown>
    get?: (opts: { path: { sessionID: string; id?: string } }) => Promise<{
      data?: { parentID?: string; agent?: string; title?: string }
      parentID?: string
      agent?: string
      title?: string
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
  if (sessionInfo.has(sessionID)) return Boolean(sessionInfo.get(sessionID)?.parentID)
  if (!client.session.get) {
    sessionInfo.set(sessionID, {})
    return false
  }
  try {
    const result = await client.session.get({
      path: { sessionID, id: sessionID },
    })
    const parent = result?.data?.parentID ?? result?.parentID
    const agent = result?.data?.agent ?? result?.agent
    const title = result?.data?.title ?? result?.title
    rememberSession(sessionID, { parentID: parent, agent, title })
    return Boolean(parent)
  } catch {
    sessionInfo.set(sessionID, {})
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
