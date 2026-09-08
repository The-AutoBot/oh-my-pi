import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { GuestClient, LiveInputStopReason } from "./client";
import { PhoneMicController, type PhoneMicSnapshot } from "./phone-mic";

export interface PhoneMicControl {
	snapshot: PhoneMicSnapshot;
	toggle(): void;
	retryPlayback(): void;
	stop(reason: LiveInputStopReason): void;
}

export function usePhoneMic(client: GuestClient): PhoneMicControl {
	const controller = useMemo(() => new PhoneMicController(client), [client]);
	useEffect(() => controller.mount(), [controller]);
	const snapshot = useSyncExternalStore(
		listener => controller.subscribe(listener),
		() => controller.getSnapshot(),
		() => controller.getSnapshot(),
	);
	const toggle = useCallback(() => controller.toggle(), [controller]);
	const retryPlayback = useCallback(() => controller.retryPlayback(), [controller]);
	const stop = useCallback((reason: LiveInputStopReason) => controller.stop(reason), [controller]);
	return { snapshot, toggle, retryPlayback, stop };
}
