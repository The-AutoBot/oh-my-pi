import { LogOut, Mic, PanelRight, VolumeX } from "lucide-react";
import type { ReactNode } from "react";
import type { GuestSnapshot } from "../../lib/client";
import { fmtPercent, shortenPath } from "../../lib/format";
import type { PhoneMicSnapshot } from "../../lib/phone-mic";
import { ThemeToggle } from "./ThemeToggle";

interface PhoneMicPresentation {
	label: string;
	shortLabel: string;
	disabled: boolean;
	active: boolean;
}

function presentPhoneMic(snapshot: GuestSnapshot, phoneMic: PhoneMicSnapshot): PhoneMicPresentation {
	if (phoneMic.phase === "idle" && snapshot.liveActive && snapshot.liveInput === "local") {
		return { label: "Host microphone is active", shortLabel: "host mic live", disabled: true, active: false };
	}
	if (phoneMic.phase === "idle" && snapshot.liveActive && snapshot.liveInput === "remote") {
		return {
			label: "Another guest microphone is active",
			shortLabel: "guest mic live",
			disabled: true,
			active: false,
		};
	}
	const connectionDisabled = snapshot.phase !== "live" || snapshot.restartPreparing;
	const otherInputActive =
		snapshot.liveInput !== "none" &&
		phoneMic.phase !== "active" &&
		phoneMic.phase !== "requesting" &&
		phoneMic.phase !== "waiting";
	switch (phoneMic.phase) {
		case "requesting":
			return {
				label: "Cancel microphone request",
				shortLabel: "requesting…",
				disabled: connectionDisabled,
				active: false,
			};
		case "waiting":
			return {
				label: "Cancel microphone request",
				shortLabel: "waiting…",
				disabled: connectionDisabled,
				active: false,
			};
		case "active":
			return {
				label: "Stop sharing this device microphone",
				shortLabel: "phone mic live",
				disabled: false,
				active: true,
			};
		case "busy":
			return {
				label: "Try this device microphone again",
				shortLabel: "mic busy",
				disabled: connectionDisabled || otherInputActive,
				active: false,
			};
		case "permission-denied":
			return {
				label: "Retry microphone permission",
				shortLabel: "permission denied",
				disabled: connectionDisabled,
				active: false,
			};
		case "revoked":
			return {
				label: "Try this device microphone again",
				shortLabel: "mic revoked",
				disabled: connectionDisabled || otherInputActive,
				active: false,
			};
		case "unavailable":
			return {
				label: "Try this device microphone again",
				shortLabel: "mic unavailable",
				disabled: connectionDisabled,
				active: false,
			};
		default:
			return {
				label: "Use this device microphone",
				shortLabel: "phone mic",
				disabled: connectionDisabled || otherInputActive,
				active: false,
			};
	}
}
export interface HeaderBarProps {
	snapshot: GuestSnapshot;
	subCount: number;
	railOpen: boolean;
	onToggleRail(): void;
	onLeave(): void;
	phoneMic: PhoneMicSnapshot;
	onPhoneMicToggle(): void;
	onPhonePlaybackRetry(): void;
}

export function HeaderBar({
	snapshot,
	subCount,
	railOpen,
	phoneMic,
	onToggleRail,
	onPhoneMicToggle,
	onPhonePlaybackRetry,
	onLeave,
}: HeaderBarProps): ReactNode {
	const { header, state, phase, readOnly } = snapshot;
	const title = header?.title ?? state?.sessionName ?? "session";
	const liveControl = presentPhoneMic(snapshot, phoneMic);
	const liveTitle = phoneMic.message ? `${liveControl.label}. ${phoneMic.message}` : liveControl.label;
	const usage = state?.contextUsage;
	let pct: number | null = null;
	if (usage) {
		pct =
			usage.percent ??
			(usage.tokens != null && usage.contextWindow !== null && usage.contextWindow > 0
				? (usage.tokens / usage.contextWindow) * 100
				: null);
	}

	return (
		<header className="sh-header">
			<div className="sh-header-left">
				<span className="sh-title" title={title}>
					{title}
				</span>
				{state?.cwd && (
					<span className="sh-cwd" title={state.cwd}>
						{shortenPath(state.cwd)}
					</span>
				)}
			</div>
			<div className="sh-header-right">
				{readOnly && (
					<span className="sh-chip" title="you joined with a read-only link — watching only">
						read-only
					</span>
				)}
				{state?.model && <span className="sh-chip sh-chip-meta">{state.model.name}</span>}
				{state?.thinkingLevel && <span className="sh-chip sh-chip-meta">{state.thinkingLevel}</span>}
				{pct != null && (
					<span
						className={pct > 80 ? "sh-gauge sh-gauge-warn" : "sh-gauge"}
						title={`context · ${fmtPercent(pct)}`}
					>
						<span className="sh-gauge-track">
							<span className="sh-gauge-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
						</span>
						<span className="sh-gauge-pct">{fmtPercent(pct)}</span>
					</span>
				)}
				{state && state.participants.length > 0 && (
					<span className="sh-avatars">
						{state.participants.map((p, i) => (
							<span
								key={`${p.name}:${i}`}
								className={p.role === "host" ? "sh-avatar sh-avatar-host" : "sh-avatar"}
								title={`${p.name} · ${p.role}${p.readOnly ? " · view-only" : ""}`}
							>
								{(p.name[0] ?? "?").toUpperCase()}
							</span>
						))}
					</span>
				)}
				<span className={`sh-dot sh-dot-${phase}`} title={phase} />
				{!readOnly && (
					<button
						type="button"
						className={`sh-btn sh-btn-live${liveControl.active ? " sh-btn-on" : ""}`}
						data-state={phoneMic.phase}
						onClick={onPhoneMicToggle}
						disabled={liveControl.disabled}
						aria-label={liveControl.label}
						aria-pressed={liveControl.active}
						title={liveTitle}
					>
						<Mic size={14} aria-hidden />
						<span className="sh-live-label" aria-live="polite">
							{liveControl.shortLabel}
						</span>
					</button>
				)}
				{!readOnly && phoneMic.playbackPhase === "unavailable" && (
					<button
						type="button"
						className="sh-btn sh-btn-icon sh-btn-audio-error"
						data-playback-state="unavailable"
						onClick={onPhonePlaybackRetry}
						aria-label="Retry assistant audio playback"
						title={
							phoneMic.playbackMessage ??
							"Assistant audio is unavailable. Microphone sharing is still active; click to retry playback."
						}
					>
						<VolumeX size={14} aria-hidden />
					</button>
				)}
				<ThemeToggle />
				<button
					type="button"
					className={railOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggleRail}
					title={railOpen ? "hide agents" : "show agents"}
				>
					<PanelRight size={14} />
					{subCount > 0 && <span className="sh-badge">{subCount}</span>}
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onLeave} title="leave session">
					<LogOut size={14} />
				</button>
			</div>
		</header>
	);
}
