import type { SocketClient } from './SocketClient.js';

declare global {
    interface Window {
        io: { connect: (name: string, par: any) => SocketClient };
        iob: { connect: (name: string, par: any) => SocketClient };
        socketUrl: string;
        socketPath: string;
        registerSocketOnLoad: (callback: () => void) => void;
        vendorPrefix: string;
        socketForceWebSockets: boolean;
    }
    interface globalThis {
        io: { connect: (name: string, par: any) => SocketClient };
        iob: { connect: (name: string, par: any) => SocketClient };
        socketUrl: string;
        socketPath: string;
        registerSocketOnLoad: (callback: () => void) => void;
        vendorPrefix: string;
        socketForceWebSockets: boolean;
    }
    interface Navigator {
        userLanguage: string;
    }
}
