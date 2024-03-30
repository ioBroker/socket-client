import type { SocketClient } from "./SocketClient";

declare global {
	interface Window {
		io: { connect: (name: string, par: any) => SocketClient };
		socketUrl: string;
		registerSocketOnLoad: (callback: () => void) => void;
		vendorPrefix: string;
	}

	interface Navigator {
		userLanguage: string;
	}
}
