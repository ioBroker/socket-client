import type { SocketClient } from './SocketClient';

/**
 * Log event
 */
export type LogMessage = {
    /** Log message */
    message: string;
    /** origin */
    from: string;
    /** timestamp in ms */
    ts: number;
    /** Log message */
    severity: ioBroker.LogLevel;
    /** unique ID of the message */
    _id: number;
};

export interface ConnectionProps {
    /** The socket name. */
    name?: string;
    /**
     * Object ID patterns (not state IDs) to subscribe to on every connect, e.g. `['system.adapter.*']`.
     * The changes of these objects are passed to `onObjectChange`. To receive the values of states, use `subscribeState`.
     */
    autoSubscribes?: string[];
    /** Automatically subscribe to logging. */
    autoSubscribeLog?: boolean;
    /** The protocol to use for the socket.io connection, with or without colon, e.g. `'https:'` or `'https'`. */
    protocol?: 'ws:' | 'wss:' | 'http:' | 'https:' | 'ws' | 'wss' | 'http' | 'https';
    /** The host name to use for the socket.io connection. */
    host?: string;
    /** The port to use for the socket.io connection. */
    port: string | number;
    /** The socket.io connection timeout. */
    ioTimeout?: number;
    /** The socket.io command timeout. */
    cmdTimeout?: number;
    /** Flag to indicate if all objects should be loaded or not. Default true (not loaded) */
    doNotLoadAllObjects?: boolean;
    /** Flag to indicate if AccessControlList for current user will be loaded or not. Default true (not loaded) */
    doNotLoadACL?: boolean;
    /** Progress callback. */
    onProgress?: (progress: number) => void;
    /** Ready callback. */
    onReady?: (objects: Record<string, ioBroker.Object>) => void;
    /** Log callback. */
    onLog?: (message: LogMessage) => void;
    /** Error callback. */
    onError?: (error: any) => void;
    /** Called when an object subscribed with `autoSubscribes` or `subscribeObject` changes. `obj` is null or undefined if the object was deleted */
    onObjectChange?: ioBroker.ObjectChangeHandler;
    /** Gets called when the system language is determined */
    onLanguage?: (lang: ioBroker.Languages) => void;
    /** Forces the use of the Compact Methods, which only exist in admin 5 UI. */
    admin5only?: boolean;
    /** The device UUID with which the communication must be established */
    uuid?: string;
    /** Authentication token */
    token?: string;
    /** The timeout handler, which will be called 30 seconds before token expiration */
    tokenTimeoutHandler?: (accessTokenExpireUnixTimeInMs: number) => Promise<boolean>;
    /** The function to connect to the socket (used in Node.js) */
    connect?: (name: string, options: any) => SocketClient;
}
