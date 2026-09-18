import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import type { RestartDraftRegistry, RestartDraftSurface } from "../../lib/restart-drafts";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
	drafts: RestartDraftRegistry;
	draftsReady: boolean;
	draftRecoveryVersion: number;
	editorDraftCapabilityFingerprint: string | null;
}

const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;
const COMPOSER_SURFACE: RestartDraftSurface = { kind: "composer" };

function autosize(el: HTMLTextAreaElement | null): void {
	if (!el) return;
	el.style.height = "0px";
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
	el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
}

export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	reqId: number;
	capabilityFingerprint: string;
	prefill: string | undefined;
	drafts: RestartDraftRegistry;
	draftsReady: boolean;
	draftRecoveryVersion: number;
	live: boolean;
	restartPreparing: boolean;
	onSubmit(value: string): boolean;
}

/** A prepared update fences submissions, not typing; accepted edits are locally durable first. */
function AskEditor({
	reqId,
	capabilityFingerprint,
	prefill,
	drafts,
	draftsReady,
	draftRecoveryVersion,
	live,
	restartPreparing,
	onSubmit,
}: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const initialPrefillRef = useRef(prefill);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	const surface: RestartDraftSurface = { kind: "editor", reqId, capabilityFingerprint };

	useEffect(() => {
		setDraft(drafts.get(surface) ?? initialPrefillRef.current ?? "");
	}, [capabilityFingerprint, draftRecoveryVersion, drafts, reqId]);
	useEffect(() => () => drafts.setComposing(surface, false), [capabilityFingerprint, drafts, reqId]);
	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [draft]);

	const submit = (): void => {
		if (!live || !draftsReady || restartPreparing) return;
		if (onSubmit(draft)) drafts.clear(surface);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (!shouldSubmitOnEnter(e, composingRef.current)) return;
		e.preventDefault();
		submit();
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => {
					setDraft(e.target.value);
					if (draftsReady) {
						drafts.noteInput(surface);
						drafts.set(surface, e.target.value);
					}
				}}
				onKeyDown={onKeyDown}
				onCompositionStart={() => {
					onCompositionStart();
					drafts.setComposing(surface, true);
				}}
				onCompositionEnd={() => {
					onCompositionEnd();
					drafts.noteInput(surface);
					drafts.setComposing(surface, false);
				}}
				placeholder={draftsReady ? "type your response…" : "verifying draft storage…"}
				disabled={!draftsReady}
				rows={1}
				spellCheck={false}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					onClick={submit}
					disabled={!live || !draftsReady || restartPreparing}
					title="submit response"
				>
					<SendHorizontal size={12} /> <span className="sh-btn-label">Submit</span>
				</button>
			</div>
		</div>
	);
}

export function Composer({
	client,
	snapshot,
	drafts,
	draftsReady,
	draftRecoveryVersion,
	editorDraftCapabilityFingerprint,
}: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	const live = snapshot.phase === "live";
	const readOnly = snapshot.readOnly;
	const uiRequest = snapshot.uiRequest;
	const canEdit = !readOnly && draftsReady;
	const canPrompt = live && canEdit;
	const busy = snapshot.working;
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend = canPrompt && !snapshot.restartPreparing && text.trim().length > 0;
	useEffect(() => () => drafts.setComposing(COMPOSER_SURFACE, false), [drafts]);
	useEffect(() => {
		setText(drafts.get(COMPOSER_SURFACE) ?? "");
	}, [draftRecoveryVersion, drafts]);
	useLayoutEffect(() => {
		autosize(taRef.current);
	}, [text, uiRequest?.reqId]);
	useLayoutEffect(() => {
		if (uiRequest) drafts.setComposing(COMPOSER_SURFACE, false);
	}, [drafts, uiRequest]);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed || !canPrompt || snapshot.restartPreparing) return;
		if (!client.sendPrompt(trimmed)) return;
		drafts.clear(COMPOSER_SURFACE);
		setText("");
	}, [canPrompt, client, drafts, snapshot.restartPreparing, text]);
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (!shouldSubmitOnEnter(e, composingRef.current)) return;
		e.preventDefault();
		send();
	};

	if (uiRequest && canEdit && (uiRequest.kind === "select" || editorDraftCapabilityFingerprint)) {
		return (
			<div className="sh-composer sh-composer-ask">
				<div className="sh-ask-title">{uiRequest.title}</div>
				{uiRequest.kind === "select" ? (
					<div className="sh-ask-options">
						{uiRequest.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = uiRequest.checkedIndices?.includes(index) ?? false;
							return (
								<button
									key={`${uiRequest.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}`}
									onClick={() => client.sendUiResponse(uiRequest.reqId, label)}
									disabled={!live || snapshot.restartPreparing}
								>
									<span className="sh-ask-option-marker">
										{uiRequest.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<AskEditor
						key={uiRequest.reqId}
						reqId={uiRequest.reqId}
						prefill={uiRequest.prefill}
						drafts={drafts}
						capabilityFingerprint={editorDraftCapabilityFingerprint ?? ""}
						draftsReady={draftsReady}
						draftRecoveryVersion={draftRecoveryVersion}
						live={live}
						restartPreparing={snapshot.restartPreparing}
						onSubmit={value => client.sendUiResponse(uiRequest.reqId, value)}
					/>
				)}
				<div className="sh-composer-actions sh-ask-actions">
					<button
						type="button"
						className="sh-btn"
						onClick={() => {
							if (!client.sendUiResponse(uiRequest.reqId)) return;
							if (uiRequest.kind === "editor" && editorDraftCapabilityFingerprint) {
								drafts.clear({
									kind: "editor",
									reqId: uiRequest.reqId,
									capabilityFingerprint: editorDraftCapabilityFingerprint,
								});
							}
						}}
						disabled={!live || snapshot.restartPreparing}
					>
						Cancel
					</button>
					{busy && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live || snapshot.restartPreparing}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="sh-composer">
			<div className="sh-composer-inner">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					value={text}
					onChange={e => {
						setText(e.target.value);
						if (draftsReady) {
							drafts.noteInput(COMPOSER_SURFACE);
							drafts.set(COMPOSER_SURFACE, e.target.value);
						}
					}}
					onKeyDown={onKeyDown}
					onCompositionStart={() => {
						onCompositionStart();
						drafts.setComposing(COMPOSER_SURFACE, true);
					}}
					onCompositionEnd={() => {
						onCompositionEnd();
						drafts.noteInput(COMPOSER_SURFACE);
						drafts.setComposing(COMPOSER_SURFACE, false);
					}}
					placeholder={
						!draftsReady
							? "verifying draft storage…"
							: readOnly
								? "read-only session — watching only"
								: live
									? "prompt the host agent…"
									: "offline — draft saved locally"
					}
					disabled={!canEdit}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-actions">
					{busy && queued > 0 && (
						<span className="sh-queued">
							<span className="sh-queued-label">queued </span>×{queued}
						</span>
					)}
					{busy && !readOnly && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => client.sendAbort()}
							disabled={!live || snapshot.restartPreparing}
							title="stop the current turn"
						>
							<Square size={11} /> <span className="sh-btn-label">Stop</span>
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={send}
						disabled={!canSend}
						title="send (Enter)"
					>
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
		</div>
	);
}
