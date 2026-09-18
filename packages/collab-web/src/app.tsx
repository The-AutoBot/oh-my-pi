import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient } from "./lib/client";
import { usePhoneMic } from "./lib/use-phone-mic";
import { useGuestSnapshot } from "./lib/use-guest";
import { managedLeaveHref, managedReplacementHref, managedRoomRoute, type ManagedRoomRoute } from "./lib/managed-room";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";
const ROOM_DISCOVERY_INITIAL_DELAY_MS = 3_000;
const ROOM_DISCOVERY_MAX_DELAY_MS = 30_000;

interface Creds {
	link: string;
	name: string;
}

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

export function App(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [discoveryEnabled, setDiscoveryEnabled] = useState(true);
	const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
	const credsRef = useRef<Creds | null>(null);
	const managedRoute = useMemo(() => managedRoomRoute(new URLSearchParams(window.location.search)), []);

	useManagedRoomDiscovery(managedRoute, discoveryEnabled, setDiscoveryMessage);

	const connect = useCallback((link: string, name: string): void => {
		let next: GuestClient;
		try {
			next = new GuestClient(link, name);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		credsRef.current = { link, name };
		window.location.hash = link;
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		setDiscoveryEnabled(false);
		setClient(prev => {
			prev?.close();
			return null;
		});
		history.replaceState(null, "", managedLeaveHref(new URL(window.location.href)));
	}, []);

	const rejoin = useCallback((): void => {
		setDiscoveryEnabled(true);
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name);
	}, [connect]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	// Deep link: a page load with a hash auto-connects.
	useEffect(() => {
		const link = hashLink();
		if (link) connect(link, storedName());
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = "omp collab";
	}, [client]);

	if (!client) {
		return <ConnectScreen defaultName={storedName()} error={connectError ?? discoveryMessage} onConnect={connect} />;
	}
	return <Session client={client} onLeave={leave} onRejoin={rejoin} discoveryMessage={discoveryMessage} />;
}

function useManagedRoomDiscovery(
	route: ManagedRoomRoute | null,
	enabled: boolean,
	setMessage: (message: string | null) => void,
): void {
	useEffect(() => {
		if (route === null || !enabled) {
			setMessage(null);
			return;
		}

		let active = true;
		let delayMs = ROOM_DISCOVERY_INITIAL_DELAY_MS;
		let timer: Timer | undefined;
		let controller: AbortController | undefined;
		const requestUrl = `/api/sessions?${new URLSearchParams({ pcId: route.pcId, sessionId: route.sessionId })}`;

		const schedule = (): void => {
			if (!active) return;
			timer = setTimeout(() => {
				timer = undefined;
				void poll();
			}, delayMs);
		};

		const poll = async (): Promise<void> => {
			controller = new AbortController();
			try {
				const response = await fetch(requestUrl, {
					cache: "no-store",
					credentials: "include",
					headers: { Accept: "application/json" },
					signal: controller.signal,
				});
				if (!active) return;
				if (response.status === 401 || response.status === 403) {
					setMessage("Sign in again to resume this room.");
					return;
				}
				if (!response.ok) {
					setMessage("Waiting for the session room to reconnect.");
					delayMs = Math.min(delayMs * 2, ROOM_DISCOVERY_MAX_DELAY_MS);
					schedule();
					return;
				}
				const currentUrl = new URL(window.location.href);
				const replacement = managedReplacementHref(await response.json(), currentUrl, route);
				if (!active) return;
				if (replacement !== null) {
					// Fragment-only navigation does not remount React, so reload the validated room document.
					active = false;
					window.history.replaceState(null, "", replacement);
					window.location.reload();
					return;
				}
				setMessage("Waiting for the session room to reconnect.");
				delayMs = ROOM_DISCOVERY_INITIAL_DELAY_MS;
			} catch (error) {
				if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
				setMessage("Waiting for the session room to reconnect.");
				delayMs = Math.min(delayMs * 2, ROOM_DISCOVERY_MAX_DELAY_MS);
			}
			schedule();
		};

		void poll();
		return () => {
			active = false;
			controller?.abort();
			clearTimeout(timer);
		};
	}, [enabled, route, setMessage]);
}

interface SessionProps {
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
	discoveryMessage: string | null;
}

function Session({ client, onLeave, onRejoin, discoveryMessage }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const phoneMic = usePhoneMic(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const leaveSession = useCallback((): void => {
		phoneMic.stop("user");
		onLeave();
	}, [onLeave, phoneMic]);

	return (
		<div className="sh-app">
			<HeaderBar
				snapshot={snap}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={() => setRailOpen(open => !open)}
				phoneMic={phoneMic.snapshot}
				onPhoneMicToggle={phoneMic.toggle}
				onPhonePlaybackRetry={phoneMic.retryPlayback}
				onLeave={leaveSession}
			/>
			<main className="sh-main">
				<section className="sh-content" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
						/>
					</div>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			<Composer client={client} snapshot={snap} />
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			<Banners
				phase={snap.phase}
				endedReason={snap.endedReason}
				onRejoin={onRejoin}
				onNewLink={onLeave}
				discoveryMessage={discoveryMessage}
			/>
			<Toasts notices={snap.notices} />
		</div>
	);
}
