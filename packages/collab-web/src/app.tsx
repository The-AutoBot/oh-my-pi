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
import { GuestClient, type GuestRestartPreparationHandler } from "./lib/client";
import { usePhoneMic } from "./lib/use-phone-mic";
import {
	createManagedDraftScope,
	RestartDraftRegistry,
	type RestartDraftScope,
} from "./lib/restart-drafts";
import { useGuestSnapshot } from "./lib/use-guest";
import {
	managedLeaveHref,
	managedRoomReplacement,
	managedRoomRoute,
	resolveDraftScopeForRoute,
	type ManagedRoomReplacementResult,
	type ManagedRoomRoute,
} from "./lib/managed-room";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";
const ROOM_DISCOVERY_INITIAL_DELAY_MS = 3_000;
const ROOM_DISCOVERY_MAX_DELAY_MS = 30_000;
const ROOM_DISCOVERY_REQUEST_TIMEOUT_MS = 10_000;

type ManagedRoomDiscoveryFailure =
	| Exclude<ManagedRoomReplacementResult, { stage: "inactive" | "ready" }>
	| { readonly stage: "fetch"; readonly code: "network-failure" | "request-timeout" }
	| { readonly stage: "http"; readonly code: "auth-required" | "upstream-response"; readonly status: number }
	| { readonly stage: "json"; readonly code: "invalid-json" };

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
	const [managedDraftScope, setManagedDraftScope] = useState<RestartDraftScope | null>(null);
	const [managedUpdateAuthorized, setManagedUpdateAuthorized] = useState(false);
	const credsRef = useRef<Creds | null>(null);
	const managedReloadGuardRef = useRef<() => boolean>(() => true);
	const verifiedManagedRouteRef = useRef<string | null>(null);
	const [managedRoute, setManagedRoute] = useState(() => managedRoomRoute(new URLSearchParams(window.location.search)));
	const prepareManagedReload = useCallback(() => managedReloadGuardRef.current(), []);
	const registerManagedReloadGuard = useCallback((guard: (() => boolean) | null): void => {
		managedReloadGuardRef.current = guard ?? (() => true);
	}, []);
	const verifyManagedDraftScope = useCallback((route: ManagedRoomRoute | null): void => {
		if (route === null) {
			verifiedManagedRouteRef.current = null;
			setManagedDraftScope(null);
			return;
		}
		const routeKey = `${route.pcId}:${route.sessionId}`;
		if (verifiedManagedRouteRef.current === routeKey) return;
		verifiedManagedRouteRef.current = routeKey;
		setManagedDraftScope(null);
		void createManagedDraftScope(route.pcId, route.sessionId).then(scope => {
			if (verifiedManagedRouteRef.current === routeKey) setManagedDraftScope(scope);
		});
	}, []);

	const handleManagedVerified = useCallback(
		(route: ManagedRoomRoute | null): void => {
			verifyManagedDraftScope(route);
			setManagedUpdateAuthorized(route !== null);
		},
		[verifyManagedDraftScope],
	);
	const revokeManagedUpdateAuthorization = useCallback(() => {
		setManagedUpdateAuthorized(false);
		client?.setRestartPreparationAvailability(false);
	}, [client]);

	useManagedRoomDiscovery(
		managedRoute,
		discoveryEnabled,
		setDiscoveryMessage,
		handleManagedVerified,
		revokeManagedUpdateAuthorization,
		prepareManagedReload,
	);

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
		verifiedManagedRouteRef.current = null;
		setManagedUpdateAuthorized(false);
		setManagedDraftScope(null);
		managedReloadGuardRef.current = () => true;
		setManagedRoute(null);
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
	return (
		<Session
			client={client}
			onLeave={leave}
			onRejoin={rejoin}
			discoveryMessage={discoveryMessage}
			managedRoute={managedRoute}
			managedDraftScope={managedDraftScope}
			managedUpdateAuthorized={managedUpdateAuthorized}
			onManagedReloadGuard={registerManagedReloadGuard}
		/>
	);
}

function useManagedRoomDiscovery(
	route: ManagedRoomRoute | null,
	enabled: boolean,
	setMessage: (message: string | null) => void,
	onVerified: (route: ManagedRoomRoute | null) => void,
	onAuthorizationLost: () => void,
	beforeReplacement: () => boolean,
): void {
	useEffect(() => {
		if (route === null || !enabled) {
			onVerified(null);
			setMessage(null);
			return;
		}

		let active = true;
		let delayMs = ROOM_DISCOVERY_INITIAL_DELAY_MS;
		let timer: Timer | undefined;
		let controller: AbortController | undefined;
		let deadline: Timer | undefined;
		let lastFailure: string | null = null;
		const requestUrl = `/api/sessions?${new URLSearchParams({ pcId: route.pcId, sessionId: route.sessionId })}`;

		const reportFailure = (failure: ManagedRoomDiscoveryFailure): void => {
			onAuthorizationLost();
			const status = "status" in failure ? failure.status : undefined;
			const signature =
				status === undefined ? `${failure.stage}:${failure.code}` : `${failure.stage}:${failure.code}:${status}`;
			if (signature === lastFailure) return;
			if (status === undefined) {
				console.warn("collab: managed room discovery failed", { stage: failure.stage, code: failure.code });
			} else {
				console.warn("collab: managed room discovery failed", {
					stage: failure.stage,
					code: failure.code,
					status,
				});
			}
			lastFailure = signature;
		};

		const reportRecovery = (): void => {
			if (lastFailure === null) return;
			console.info("collab: managed room discovery recovered", { stage: "ready", code: "recovered" });
			lastFailure = null;
		};

		const reportReplacement = (): void => {
			console.info("collab: managed room replacement ready", { stage: "ready", code: "replacement-ready" });
			lastFailure = null;
		};

		const schedule = (): void => {
			if (!active) return;
			timer = setTimeout(() => {
				timer = undefined;
				void poll();
			}, delayMs);
		};

		const scheduleRetry = (backoff: boolean): void => {
			setMessage("Waiting for the session room to reconnect.");
			delayMs = backoff
				? Math.min(delayMs * 2, ROOM_DISCOVERY_MAX_DELAY_MS)
				: ROOM_DISCOVERY_INITIAL_DELAY_MS;
			schedule();
		};

		const retryFetchFailure = (code: "network-failure" | "request-timeout"): void => {
			reportFailure({ stage: "fetch", code });
			scheduleRetry(true);
		};

		const poll = async (): Promise<void> => {
			const pollController = new AbortController();
			controller = pollController;
			let timedOut = false;
			const pollDeadline = setTimeout(() => {
				timedOut = true;
				pollController.abort();
			}, ROOM_DISCOVERY_REQUEST_TIMEOUT_MS);
			deadline = pollDeadline;
			try {
				let response: Response;
				try {
					response = await fetch(requestUrl, {
						cache: "no-store",
						credentials: "include",
						headers: { Accept: "application/json" },
						signal: pollController.signal,
					});
				} catch (error) {
					if (!active) return;
					if (timedOut) {
						retryFetchFailure("request-timeout");
						return;
					}
					if (error instanceof DOMException && error.name === "AbortError") return;
					retryFetchFailure("network-failure");
					return;
				}
				if (!active) return;
				if (timedOut) {
					retryFetchFailure("request-timeout");
					return;
				}
				if (response.status === 401 || response.status === 403) {
					reportFailure({ stage: "http", code: "auth-required", status: response.status });
					setMessage("Sign in again to resume this room.");
					return;
				}
				if (!response.ok) {
					reportFailure({ stage: "http", code: "upstream-response", status: response.status });
					scheduleRetry(true);
					return;
				}

				let payload: unknown;
				try {
					payload = await response.json();
				} catch (error) {
					if (!active) return;
					if (timedOut) {
						retryFetchFailure("request-timeout");
						return;
					}
					if (error instanceof DOMException && error.name === "AbortError") return;
					reportFailure({ stage: "json", code: "invalid-json" });
					scheduleRetry(true);
					return;
				}
				if (!active) return;
				if (timedOut) {
					retryFetchFailure("request-timeout");
					return;
				}
				const result = managedRoomReplacement(payload, new URL(window.location.href), route);
				if (!active) return;
				if (result.stage === "inactive") {
					onVerified(null);
					return;
				}
				if (result.stage === "ready") {
					if (result.code === "replacement-ready") {
						if (!beforeReplacement()) {
							setMessage("Waiting to preserve local drafts before reconnecting this room.");
							scheduleRetry(false);
							return;
						}
						reportReplacement();
						// Fragment-only navigation does not remount React, so reload the validated room document.
						active = false;
						window.history.replaceState(null, "", result.href);
						window.location.reload();
						return;
					}
					onVerified(route);
					reportRecovery();
					setMessage(null);
					delayMs = ROOM_DISCOVERY_INITIAL_DELAY_MS;
					schedule();
					return;
				}
				reportFailure(result);
				scheduleRetry(false);
			} finally {
				clearTimeout(pollDeadline);
				if (deadline === pollDeadline) deadline = undefined;
				if (controller === pollController) controller = undefined;
			}
		};

		void poll();

		return () => {
			active = false;
			clearTimeout(deadline);
			controller?.abort();
			clearTimeout(timer);
		};
	}, [beforeReplacement, enabled, onAuthorizationLost, onVerified, route, setMessage]);
}

interface SessionProps {
	client: GuestClient;
	onLeave(): void;
	onRejoin(): void;
	discoveryMessage: string | null;
	managedRoute: ManagedRoomRoute | null;
	managedDraftScope: RestartDraftScope | null;
	managedUpdateAuthorized: boolean;
	onManagedReloadGuard(guard: (() => boolean) | null): void;
}

function Session({
	client,
	onLeave,
	onRejoin,
	discoveryMessage,
	managedRoute,
	managedDraftScope,
	managedUpdateAuthorized,
	onManagedReloadGuard,
}: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const phoneMic = usePhoneMic(client);
	const draftsRef = useRef<RestartDraftRegistry | null>(null);
	const drafts = draftsRef.current ?? (draftsRef.current = new RestartDraftRegistry());
	const [draftsReady, setDraftsReady] = useState(false);
	const [draftRecoveryVersion, setDraftRecoveryVersion] = useState(0);
	const [editorDraftCapabilityFingerprint, setEditorDraftCapabilityFingerprint] = useState<string | null>(null);
	const restartHandler = useMemo<GuestRestartPreparationHandler>(
		() => ({
			prepare: request => drafts.prepare(request),
			cancel: (requestId, disposition) => drafts.cancel(requestId, disposition),
		}),
		[drafts],
	);

	useEffect(() => client.setRestartPreparationHandler(restartHandler), [client, restartHandler]);

	useEffect(() => {
		const eligible =
			managedRoute !== null &&
			managedUpdateAuthorized &&
			draftsReady &&
			managedDraftScope?.sessionId === snap.header?.id;
		client.setRestartPreparationAvailability(eligible);
		return () => client.setRestartPreparationAvailability(false);
	}, [client, draftsReady, managedDraftScope, managedRoute, managedUpdateAuthorized, snap.header?.id]);

	useEffect(() => {
		const syncDirty = () => client.setRestartDirty(drafts.dirty);
		syncDirty();
		return drafts.subscribe(syncDirty);
	}, [client, drafts]);

	useEffect(() => {
		if (!editorDraftCapabilityFingerprint) return;
		return client.setUiRequestEndedHandler(reqId =>
			drafts.clear({ kind: "editor", reqId, capabilityFingerprint: editorDraftCapabilityFingerprint }),
		);
	}, [client, drafts, editorDraftCapabilityFingerprint]);

	useEffect(() => {
		let disposed = false;
		const deactivate = (): void => {
			if (disposed) return;
			drafts.setScope(undefined);
			setEditorDraftCapabilityFingerprint(null);
			setDraftsReady(false);
		};
		const activate = (scope: RestartDraftScope, capabilityFingerprint: string): void => {
			if (disposed) return;
			drafts.setScope(scope);
			drafts.restore(scope, capabilityFingerprint);
			setEditorDraftCapabilityFingerprint(capabilityFingerprint);
			setDraftsReady(true);
			setDraftRecoveryVersion(version => version + 1);
		};
		const resolveScope = (scopePromise: Promise<RestartDraftScope | null>): void => {
			void Promise.all([scopePromise, client.editorDraftCapabilityFingerprint()]).then(([scope, capabilityFingerprint]) => {
				if (!scope || !capabilityFingerprint) {
					deactivate();
					return;
				}
				activate(scope, capabilityFingerprint);
			});
		};
		const sessionId = snap.header?.id;
		if (!sessionId) {
			deactivate();
			return () => {
				disposed = true;
			};
		}
		const scope = resolveDraftScopeForRoute(managedRoute, managedDraftScope, sessionId);
		if (scope === null) {
			deactivate();
			return () => {
				disposed = true;
			};
		}
		setDraftsReady(false);
		setEditorDraftCapabilityFingerprint(null);
		if (scope === "manual") {
			resolveScope(client.manualDraftScope(sessionId));
		} else {
			resolveScope(Promise.resolve(scope));
		}
		return () => {
			disposed = true;
		};
	}, [client, drafts, managedDraftScope, managedRoute, snap.header?.id]);

	useEffect(() => {
		onManagedReloadGuard(() => {
			if (managedRoute && !draftsReady) return !drafts.dirty;
			return drafts.prepareForManagedReload();
		});
		return () => onManagedReloadGuard(null);
	}, [drafts, draftsReady, managedRoute, onManagedReloadGuard]);

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
			<Composer
				client={client}
				snapshot={snap}
				drafts={drafts}
				draftsReady={draftsReady}
				draftRecoveryVersion={draftRecoveryVersion}
				editorDraftCapabilityFingerprint={editorDraftCapabilityFingerprint}
			/>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						drafts={drafts}
						draftsReady={draftsReady}
						draftRecoveryVersion={draftRecoveryVersion}
						restartPreparing={snap.restartPreparing}
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
