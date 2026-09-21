/** Return the native-addon export expected for a native compatibility version. */
export function versionSentinelFor(nativeCompatibilityVersion: string): string;

/** Check whether addon bytes contain the exact expected version sentinel. */
export function containsVersionSentinel(bytes: Buffer, expected: string): boolean;
