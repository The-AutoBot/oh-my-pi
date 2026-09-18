/** Narrows untrusted JSON values to object records for boundary parsers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
