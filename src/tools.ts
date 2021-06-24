export function getObjectViewResultToArray<T extends ioBroker.Object>(
	doc:
		| {
				rows: ioBroker.GetObjectViewItem[];
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
	if (!host.startsWith("system.host.")) {
		host = `system.host.${host}`;
	}
	return host;
}

export function objectIdToHostname(id: string): string {
	if (id.startsWith("system.host.")) {
		id = id.substr("system.host.".length);
	}
	return id;
}
