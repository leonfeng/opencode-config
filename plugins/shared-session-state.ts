/** Sessions that hit the build read cap — bash cat/head/sleep will not help. */
export const dumpCapSessions = new Set<string>()

/** Dump-cap recovery already injected for this session. */
export const dumpCapRecoverySent = new Set<string>()

/** Prevent concurrent stand-in recovery prompts per session. */
export const standInRecoveryInFlight = new Set<string>()
