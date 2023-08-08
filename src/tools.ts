export function getObjectViewResultToArray<T extends ioBroker.Object>(
	doc:
		| {
				rows: ioBroker.GetObjectViewItem<T>[];
		  }
		| undefined,
): T[] {
	return (
		doc?.rows.map((item) => item.value).filter((val): val is T => !!val) ??
		[]
	);
}

/** Makes sure that a host id starts with "system.host." */
export function normalizeHostId(host: string): string {
	if (!host?.startsWith("system.host.")) {
		host = `system.host.${host}`;
	}
	return host;
}

export function objectIdToHostname(id: string): string {
	if (id?.startsWith("system.host.")) {
		id = id.substr("system.host.".length);
	}
	return id;
}

/**
 * Creates a promise that waits for the specified time and then resolves
 */
export function wait(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Converts ioB pattern into regex */
export function pattern2RegEx(pattern: string): string {
	pattern = (pattern || "").toString();

	const startsWithWildcard = pattern[0] === "*";
	const endsWithWildcard = pattern[pattern.length - 1] === "*";

	pattern = pattern
		.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&")
		.replace(/\*/g, ".*");

	return (
		(startsWithWildcard ? "" : "^") +
		pattern +
		(endsWithWildcard ? "" : "$")
	);
}
