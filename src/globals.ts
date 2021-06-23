import type { Socket } from "socket.io";

declare global {
	interface Window {
		io: { connect: (name: string, par: any) => Socket };
		socketUrl: string;
		registerSocketOnLoad: (callback: () => void) => void;
	}

	interface Navigator {
		userLanguage: string;
	}
}
