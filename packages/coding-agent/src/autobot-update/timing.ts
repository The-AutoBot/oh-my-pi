export const AUTO_BOT_UPDATE_INTERVAL_MS = 30_000;
export const AUTO_BOT_SESSION_DISPOSE_TIMEOUT_MS = 45_000;
export const AUTO_BOT_POSTMORTEM_CLEANUP_TIMEOUT_MS = 10_000;
export const AUTO_BOT_STDOUT_DRAIN_TIMEOUT_MS = 5_000;
/** Full predecessor teardown: session disposal, postmortem cleanup, and stdout drain. */
export const AUTO_BOT_PREDECESSOR_TEARDOWN_TIMEOUT_MS =
	AUTO_BOT_SESSION_DISPOSE_TIMEOUT_MS + AUTO_BOT_POSTMORTEM_CLEANUP_TIMEOUT_MS + AUTO_BOT_STDOUT_DRAIN_TIMEOUT_MS;
/** Browser's separate last-moment guest ACK lease, acquired immediately before predecessor shutdown. */
export const AUTO_BOT_FINAL_GUEST_ACK_LEASE_MS = 15_000;
/** Candidate standby deadline before activation; it must not become a writer yet. */
export const AUTO_BOT_CANDIDATE_READY_TIMEOUT_MS = 60_000;
/** Candidate post-activation fresh reopen/TUI deadline before its durable acknowledgement. */
export const AUTO_BOT_ACTIVATION_ACK_TIMEOUT_MS = 45_000;
/** A failed pre-activation candidate gets this bounded retirement window. */
export const AUTO_BOT_FAILED_CANDIDATE_RETIREMENT_TIMEOUT_MS = 15_000;
/** Exactly one pre-activation fallback has this bounded old-runtime restart window. */
export const AUTO_BOT_FALLBACK_STARTUP_TIMEOUT_MS = 30_000;
/** Bounded final Browser/coordinator preparation and network allowance. */
export const AUTO_BOT_FINAL_GUEST_PREPARATION_AND_NETWORK_TIMEOUT_MS = 45_000;
