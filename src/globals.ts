import type { SocketClient } from "./SocketClient";

declare global {
	interface Window {
		io: { connect: (name: string, par: any) => SocketClient };
		socketUrl: string;
		registerSocketOnLoad: (callback: () => void) => void;
	}

	interface Navigator {
		userLanguage: string;
	}
}
