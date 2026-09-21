import type { AgentSnapshot, SessionEntry, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { OctagonX, RotateCcw, SendHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { GuestClient } from "../../lib/client";
import type { RestartDraftRegistry, RestartDraftSurface } from "../../lib/restart-drafts";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format";
import { decideTranscriptPoll } from "../../lib/transcript-poll";
import type { TranscriptProps } from "../transcript/Transcript";
import { Transcript } from "../transcript/Transcript";

const EMPTY_TOOLS: TranscriptProps["activeTools"] = new Map();
const POLL_MS = 1200;

export function AgentDrawer(props: {
	agent: AgentSnapshot;
	progress?: SubagentProgressPayload;
	client: GuestClient;
	drafts: RestartDraftRegistry;
	draftsReady: boolean;
	draftRecoveryVersion: number;
	restartPreparing: boolean;
	/** View-link guests: hide kill/revive/chat (the host rejects them anyway). */
	readOnly?: boolean;
	/** Forwarded to tool renderers so nested task cards can drill further. */
	host?: TranscriptProps["host"];
	onClose(): void;
}): ReactNode {
	const {
		agent,
		progress,
		client,
		drafts,
		draftsReady,
		draftRecoveryVersion,
		restartPreparing,
		readOnly,
		host,
		onClose,
	} = props;
	const [entries, setEntries] = useState<readonly SessionEntry[]>([]);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const surface: RestartDraftSurface = { kind: "agent-chat", agentId: agent.id };
	const composingRef = useRef(false);
	const live = client.getSnapshot().phase === "live";
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		setDraft(drafts.get({ kind: "agent-chat", agentId: agent.id }) ?? "");
	}, [agent.id, draftRecoveryVersion, drafts]);

	useEffect(() => () => drafts.setComposing(surface, false), [agent.id, drafts]);

	// Live transcript: poll the host-side session file while the drawer is
	// open, appending parsed JSONL entries. State resets when the agent
	// changes; the interval and any in-flight reply are dropped on cleanup.
	// A frame-level host error is terminal: stop polling and show it (the
	// host replies with an unchanged cursor, so retrying would loop hot).
	useEffect(() => {
		setEntries([]);
		setFetchError(null);
		if (!agent.hasSessionFile) return;
		let disposed = false;
		let inFlight = false;
		let cursor = 0;
		let carry = "";
		let acc: readonly SessionEntry[] = [];
		let timer: Timer | null = null;
		const stopPolling = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const poll = async (): Promise<void> => {
			if (disposed || inFlight) return;
			inFlight = true;
			try {
				const reply = await client.fetchTranscript(agent.id, cursor);
				if (disposed) return;
				const decision = decideTranscriptPoll(reply, carry);
				switch (decision.action) {
					case "retry":
						return; // timeout/transient → keep polling from the same cursor
					case "stop":
						stopPolling();
						setFetchError(decision.message);
						return;
					case "advance":
						cursor = decision.newSize;
						carry = decision.carry;
						if (decision.fresh.length > 0) {
							acc = [...acc, ...decision.fresh];
							setEntries(acc);
						}
						return;
				}
			} finally {
				inFlight = false;
			}
		};
		void poll();
		timer = setInterval(() => {
			void poll();
		}, POLL_MS);
		return () => {
			disposed = true;
			stopPolling();
		};
	}, [agent.id, agent.hasSessionFile, client]);

	const sendChat = (): void => {
		const text = draft.trim();
		if (!text || !live || !draftsReady || restartPreparing || composingRef.current) return;
		if (!client.sendAgentCmd("chat", agent.id, text)) return;
		drafts.clear(surface);
		setDraft("");
	};

	const p = progress?.progress;
	const model = p?.resolvedModel;
	const ctxPct =
		p?.contextTokens !== undefined && p.contextWindow
			? Math.min(100, (p.contextTokens / p.contextWindow) * 100)
			: null;

	return (
		<aside className="ag-drawer" role="dialog" aria-label={agent.displayName}>
			<header className="ag-drawer-head">
				<div className="ag-drawer-title">
					<span className="ag-drawer-name">{agent.displayName}</span>
					<span className={`ag-chip ag-chip--${agent.status}`}>{agent.status}</span>
					{model ? <span className="ag-chip ag-chip--model">{model}</span> : null}
				</div>
				<div className="ag-drawer-actions">
					{agent.status === "running" && !readOnly ? (
						<button
							type="button"
							className="ag-btn ag-btn--danger"
							onClick={() => client.sendAgentCmd("kill", agent.id)}
							disabled={!live || restartPreparing}
						>
							<OctagonX size={13} aria-hidden />
							kill
						</button>
					) : null}
					{(agent.status === "parked" || agent.status === "aborted") && !readOnly ? (
						<button
							type="button"
							className="ag-btn"
							onClick={() => client.sendAgentCmd("revive", agent.id)}
							disabled={!live || restartPreparing}
						>
							<RotateCcw size={13} aria-hidden />
							revive
						</button>
					) : null}
					<button type="button" className="ag-iconbtn" aria-label="close" onClick={onClose}>
						<X size={15} aria-hidden />
					</button>
				</div>
			</header>
			{p ? (
				<div className="ag-stats">
					<span className="ag-stat">
						<span className="ag-stat-label">tok</span>
						<span className="ag-stat-value">{fmtTokens(p.tokens)}</span>
					</span>
					{ctxPct !== null ? (
						<span className="ag-stat" title={`context ${fmtTokens(p.contextTokens ?? 0)}`}>
							<span className="ag-stat-label">ctx</span>
							<span className="ag-gauge">
								<span
									className={ctxPct > 80 ? "ag-gauge-fill ag-gauge-fill--warn" : "ag-gauge-fill"}
									style={{ width: `${ctxPct}%` }}
								/>
							</span>
						</span>
					) : null}
					<span className="ag-stat">
						<span className="ag-stat-label">cost</span>
						<span className="ag-stat-value">{fmtCost(p.cost)}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-label">tools</span>
						<span className="ag-stat-value">{p.toolCount}</span>
					</span>
					<span className="ag-stat">
						<span className="ag-stat-value">{fmtDuration(p.durationMs)}</span>
					</span>
				</div>
			) : null}
			<div className="ag-drawer-body">
				{agent.hasSessionFile ? (
					<>
						<Transcript
							compact
							entries={entries}
							stream={null}
							streamDone={false}
							activeTools={EMPTY_TOOLS}
							working={agent.status === "running" && fetchError === null}
							host={host}
						/>
						{fetchError !== null ? (
							<div className="ag-fetch-error" role="alert">
								transcript unavailable: {fetchError}
							</div>
						) : null}
					</>
				) : (
					<div className="ag-empty">no transcript available</div>
				)}
			</div>
			{!readOnly && (
				<form
					className="ag-chat"
					onSubmit={e => {
						e.preventDefault();
						sendChat();
					}}
				>
					<input
						className="ag-chat-input"
						value={draft}
						placeholder={draftsReady ? `message ${agent.displayName}…` : "verifying draft storage…"}
						onChange={e => {
							setDraft(e.target.value);
							if (draftsReady) {
								drafts.noteInput(surface);
								drafts.set(surface, e.target.value);
							}
						}}
						onCompositionStart={() => {
							composingRef.current = true;
							drafts.setComposing(surface, true);
						}}
						onCompositionEnd={() => {
							drafts.noteInput(surface);
							drafts.setComposing(surface, false);
							setTimeout(() => {
								composingRef.current = false;
							}, 0);
						}}
						onKeyDown={e => {
							if (e.key === "Enter" && (e.nativeEvent.isComposing || composingRef.current)) e.preventDefault();
						}}
						disabled={!draftsReady}
					/>
					<button
						type="submit"
						className="ag-iconbtn"
						aria-label="send"
						disabled={!live || !draftsReady || restartPreparing || draft.trim().length === 0}
					>
						<SendHorizontal size={15} aria-hidden />
					</button>
				</form>
			)}
		</aside>
	);
}
