import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HeaderBar } from "../src/components/shell/HeaderBar";
import type { ConnectionPhase, GuestSnapshot } from "../src/lib/client";
import type { PhoneMicSnapshot } from "../src/lib/phone-mic";

function snapshot({
	phase = "live",
	readOnly = false,
	liveActive = false,
	liveInput = "none",
}: {
	phase?: ConnectionPhase;
	readOnly?: boolean;
	liveActive?: boolean;
	liveInput?: GuestSnapshot["liveInput"];
} = {}): GuestSnapshot {
	return {
		phase,
		endedReason: null,
		header: null,
		entries: [],
		state: { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] },
		agents: [],
		progress: new Map(),
		lifecycle: new Map(),
		stream: null,
		streamDone: false,
		activeTools: new Map(),
		working: false,
		liveActive,
		liveInput,
		liveInputLease: { status: "idle", requestId: null, leaseId: null, message: null, started: false },
		readOnly,
		uiRequest: null,
		notices: [],
	};
}

const IDLE_PHONE_MIC: PhoneMicSnapshot = {
	phase: "idle",
	message: null,
	playbackPhase: "locked",
	playbackMessage: null,
};

function renderHeader(guestSnapshot: GuestSnapshot, phoneMic: Partial<PhoneMicSnapshot> = {}): string {
	const fullPhoneMic = { ...IDLE_PHONE_MIC, ...phoneMic };
	return renderToStaticMarkup(
		<HeaderBar
			snapshot={guestSnapshot}
			phoneMic={fullPhoneMic}
			subCount={0}
			railOpen={false}
			onToggleRail={() => {}}
			onPhoneMicToggle={() => {}}
			onPhonePlaybackRetry={() => {}}
			onLeave={() => {}}
		/>,
	);
}

interface LiveControl {
	found: boolean;
	label: string | null;
	pressed: string | null;
	disabled: boolean;
	state: string | null;
	text: string;
}

function liveControl(html: string): LiveControl {
	const control: LiveControl = {
		found: false,
		label: null,
		pressed: null,
		disabled: false,
		state: null,
		text: "",
	};
	new HTMLRewriter()
		.on("button[data-state]", {
			element(el) {
				control.found = true;
				control.label = el.getAttribute("aria-label");
				control.pressed = el.getAttribute("aria-pressed");
				control.disabled = el.hasAttribute("disabled");
				control.state = el.getAttribute("data-state");
			},
			text(chunk) {
				control.text += chunk.text;
			},
		})
		.transform(html);
	return control;
}

describe("HeaderBar phone microphone control", () => {
	it("offers a writable live guest an explicit device microphone action", () => {
		expect(liveControl(renderHeader(snapshot()))).toMatchObject({
			found: true,
			label: "Use this device microphone",
			pressed: "false",
			disabled: false,
		});
	});

	it("shows this browser microphone as the active stop action", () => {
		const control = liveControl(
			renderHeader(snapshot({ liveActive: true, liveInput: "remote" }), {
				phase: "active",
				message: "This device microphone is live.",
			}),
		);
		expect(control).toMatchObject({
			label: "Stop sharing this device microphone",
			pressed: "true",
			disabled: false,
			state: "active",
		});
		expect(control.text).toContain("phone mic live");
	});

	it("keeps host-local live input distinct from this browser", () => {
		const control = liveControl(renderHeader(snapshot({ liveActive: true, liveInput: "local" })));
		expect(control).toMatchObject({
			label: "Host microphone is active",
			pressed: "false",
			disabled: true,
		});
		expect(control.text).toContain("host mic live");
	});

	it("does not offer the control to a read-only guest", () => {
		const html = renderHeader(snapshot({ readOnly: true }));
		expect(liveControl(html).found).toBe(false);
		expect(html).toContain("read-only");
	});

	it("disables the control until the connection is live", () => {
		expect(liveControl(renderHeader(snapshot({ phase: "reconnecting" })))).toMatchObject({
			label: "Use this device microphone",
			disabled: true,
		});
	});

	it("announces busy, permission-denied, unavailable, and revoked states", () => {
		for (const [phase, text] of [
			["busy", "mic busy"],
			["permission-denied", "permission denied"],
			["unavailable", "mic unavailable"],
			["revoked", "mic revoked"],
		] as const) {
			const control = liveControl(renderHeader(snapshot(), { phase, message: text }));
			expect(control.state).toBe(phase);
			expect(control.text).toContain(text);
		}
	});

	it("offers an actionable playback retry without changing the active microphone action", () => {
		const html = renderHeader(snapshot({ liveActive: true, liveInput: "remote" }), {
			phase: "active",
			message: "This device microphone is live.",
			playbackPhase: "unavailable",
			playbackMessage: "Assistant audio is blocked; microphone sharing continues.",
		});
		expect(liveControl(html)).toMatchObject({
			label: "Stop sharing this device microphone",
			pressed: "true",
		});
		expect(html).toContain('aria-label="Retry assistant audio playback"');
		expect(html).toContain("microphone sharing continues");
	});
});
