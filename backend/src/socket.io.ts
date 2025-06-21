/*!
 * ioBroker WebSockets
 * Copyright 2020-2025, bluefox <dogafox@gmail.com>
 * Released under the MIT License.
 * v 3.0.0 (2025_06_21)
 *
 * This is a exact copy of the ioBroker WebSocket client: https://github.com/ioBroker/ioBroker.ws.client/blob/main/socket.io.ts
 */

if (typeof (globalThis as any).process !== 'undefined') {
    // Implement location, localStorage and sessionStorage for Node.js environment
    (globalThis as any).location ||= {
        href: 'http://localhost:8081/',
        protocol: 'http:',
        host: 'localhost:8081',
        pathname: '/',
        hostname: 'localhost',
        reload: () => {},
    };
}

export interface ConnectOptions {
    /** Connection name, so the backend knows who wants to connect. Optional */
    name?: string;
    /** Timeout for answer for ping (pong) */
    pongTimeout?: number;
    /** Ping interval */
    pingInterval?: number;
    /** connection request timeout */
    connectTimeout?: number;
    /** Authentication timeout */
    authTimeout?: number;
    /** Interval between connection attempts */
    connectInterval?: number;
    /** Every connection attempt the interval increasing at options.connectInterval till max this number */
    connectMaxAttempt?: number;
    /** Token for authentication */
    token?: string;
    /** WebSocket constructor, if you want to use a custom one */
    WebSocket?: any;
}

const MESSAGE_TYPES: Record<string, number> = {
    MESSAGE: 0,
    PING: 1,
    PONG: 2,
    CALLBACK: 3,
};

const DEBUG = true;

const ERRORS: Record<number, string> = {
    1000: 'CLOSE_NORMAL', // Successful operation / regular socket shutdown
    1001: 'CLOSE_GOING_AWAY', // Client is leaving (browser tab closing)
    1002: 'CLOSE_PROTOCOL_ERROR', // Endpoint received a malformed frame
    1003: 'CLOSE_UNSUPPORTED', // Endpoint received an unsupported frame (e.g., binary-only endpoint received text frame)
    1005: 'CLOSED_NO_STATUS', // Expected close status, received none
    1006: 'CLOSE_ABNORMAL', // No close code frame has been received
    1007: 'Unsupported payload', // Endpoint received an inconsistent message (e.g., malformed UTF-8)
    1008: 'Policy violation', // Generic code used for situations other than 1003 and 1009
    1009: 'CLOSE_TOO_LARGE', // Endpoint won't process a large frame
    1010: 'Mandatory extension', // Client wanted an extension which server did not negotiate
    1011: 'Server error', // Internal server error while operating
    1012: 'Service restart', // Server/service is restarting
    1013: 'Try again later', // Temporary server condition forced blocking client's request
    1014: 'Bad gateway	Server', // acting as gateway received an invalid response
    1015: 'TLS handshake fail', // Transport Layer Security handshake failure
};

type SocketEventHandler = (...args: any[]) => void;
type SocketConnectionHandler = (connected: boolean) => void;
type SocketDisconnectionHandler = () => void;
type SocketErrorHandler = (err: string) => void;

// possible events: connect, disconnect, reconnect, error, connect_error
export class SocketClient {
    private readonly connectHandlers: SocketConnectionHandler[] = [];
    private readonly reconnectHandlers: SocketConnectionHandler[] = [];
    private readonly disconnectHandlers: SocketDisconnectionHandler[] = [];
    private readonly errorHandlers: SocketErrorHandler[] = [];

    private readonly handlers: {
        [event: string]: SocketEventHandler[];
    } = {};
    private wasConnected = false;
    private connectTimer: ReturnType<typeof setTimeout> | null = null;
    private connectingTimer: ReturnType<typeof setTimeout> | null = null;
    private connectionCount = 0;
    private callbacks: ({ ts: number; cb: SocketEventHandler; id: number } | null)[] = [];
    private pending: { name: string; args: any[] }[] = []; // pending requests till connection established
    private id = 0;
    private lastPong: number = 0;
    private socket: WebSocket | null = null;
    private url: string = '';
    private options: ConnectOptions | null = null;
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private sessionID = 0;
    private authTimeout: ReturnType<typeof setTimeout> | null = null;

    public connected = false;

    private readonly log: {
        debug: (text: string) => void;
        warn: (text: string) => void;
        error: (text: string) => void;
    };

    constructor() {
        this.log = {
            debug: (text: string) => {
                if (DEBUG) {
                    console.log(`[${new Date().toISOString()}] ${text}`);
                }
            },
            warn: (text: string) => console.warn(`[${new Date().toISOString()}] ${text}`),
            error: (text: string) => console.error(`[${new Date().toISOString()}] ${text}`),
        };
    }

    private static getQuery(_url: string): Record<string, string> {
        const query = _url.split('?')[1] || '';
        const parts = query.split('&');
        const result: Record<string, string> = {};
        for (let p = 0; p < parts.length; p++) {
            const parts1 = parts[p].split('=');
            result[parts1[0]] = decodeURIComponent(parts[1]);
        }
        return result;
    }

    connect(url?: string, options?: ConnectOptions): SocketClient {
        this.log.debug('Try to connect');

        // remove hash
        if (url) {
            url = url.split('#')[0];
        }

        this.id = 0;
        if (this.connectTimer) {
            clearInterval(this.connectTimer);
            this.connectTimer = null;
        }

        this.url ||= url || globalThis.location.href;
        this.options ||= JSON.parse(JSON.stringify(options || {}));
        if (!this.options) {
            throw new Error('No options provided!');
        }
        // Class could not be copied with JSON.stringify
        if (options?.WebSocket) {
            this.options.WebSocket = options?.WebSocket;
        }

        this.options.pongTimeout = parseInt(this.options.pongTimeout as unknown as string, 10) || 60000; // Timeout for answer for ping (pong)
        this.options.pingInterval = parseInt(this.options.pingInterval as unknown as string, 10) || 5000; // Ping interval
        this.options.connectTimeout = parseInt(this.options.connectTimeout as unknown as string, 10) || 3000; // connection request timeout
        this.options.authTimeout = parseInt(this.options.authTimeout as unknown as string, 10) || 3000; // Authentication timeout
        this.options.connectInterval = parseInt(this.options.connectInterval as unknown as string, 10) || 1000; // Interval between connection attempts
        this.options.connectMaxAttempt = parseInt(this.options.connectMaxAttempt as unknown as string, 10) || 5; // Every connection attempt the interval increasing at options.connectInterval till max this number

        this.sessionID = Date.now();
        try {
            if (this.url === '/') {
                const parts = globalThis.location.pathname.split('/');
                // remove filename
                if (globalThis.location.pathname.endsWith('.html') || globalThis.location.pathname.endsWith('.htm')) {
                    parts.pop();
                }

                this.url = `${globalThis.location.protocol || 'ws:'}//${globalThis.location.host || 'localhost'}/${parts.join('/')}`;
            }

            // extract all query attributes
            const query = SocketClient.getQuery(this.url);
            if (query.sid) {
                delete query.sid;
            }

            if (Object.prototype.hasOwnProperty.call(query, '')) {
                delete query[''];
            }

            let u = `${this.url.replace(/^http/, 'ws').split('?')[0]}?sid=${this.sessionID}`;

            // Apply a query to new url
            if (Object.keys(query).length) {
                u += `&${Object.keys(query)
                    .map(attr => (query[attr] === undefined ? attr : `${attr}=${query[attr]}`))
                    .join('&')}`;
            }

            if (this.options?.name && !query.name) {
                u += `&name=${encodeURIComponent(this.options.name)}`;
            }
            if (this.options?.token) {
                u += `&token=${this.options.token}`;
            }
            // "ws://www.example.com/socketserver"
            this.socket = new (this.options.WebSocket || globalThis.WebSocket)(u);
        } catch (error) {
            this.handlers.error?.forEach(cb => cb.call(this, error));
            this.close();
            return this;
        }

        this.connectingTimer = setTimeout(() => {
            this.connectingTimer = null;
            this.log.warn('No READY flag received in 3 seconds. Re-init');
            this.close(); // re-init connection, because no ___ready___ received in 2000 ms
        }, this.options.connectTimeout);

        if (this.socket) {
            this.socket.onopen = (): void /*event*/ => {
                this.lastPong = Date.now();
                this.connectionCount = 0;

                this.pingInterval = setInterval((): void => {
                    if (!this.options) {
                        throw new Error('No options provided!');
                    }

                    if (Date.now() - this.lastPong > (this.options?.pingInterval || 5000) - 10) {
                        try {
                            this.socket?.send(JSON.stringify([MESSAGE_TYPES.PING]));
                        } catch (e) {
                            this.log.warn(`Cannot send ping. Close connection: ${e}`);
                            this.close();
                            this._garbageCollect();
                            return;
                        }
                    }
                    if (Date.now() - this.lastPong > (this.options?.pongTimeout || 60000)) {
                        this.close();
                    }
                    this._garbageCollect();
                }, this.options?.pingInterval || 5000);
            };

            this.socket.onclose = (event: CloseEvent): void => {
                if (event.code === 3001) {
                    this.log.warn('ws closed');
                } else {
                    this.log.error(`ws connection error: ${ERRORS[event.code]}`);
                }
                this.close();
            };

            // @ts-expect-error invalid typing
            this.socket.onerror = (error: CloseEvent): void => {
                if (this.connected && this.socket) {
                    if (this.socket.readyState === 1) {
                        this.log.error(`ws normal error: ${error.type}`);
                    }
                    this.errorHandlers.forEach(cb => cb.call(this, ERRORS[error.code] || 'UNKNOWN'));
                }
                this.close();
            };

            this.socket.onmessage = (message: MessageEvent<string>): void => {
                this.lastPong = Date.now();
                if (!message?.data || typeof message.data !== 'string') {
                    console.error(`Received invalid message: ${JSON.stringify(message)}`);
                    return;
                }
                let data;
                try {
                    data = JSON.parse(message.data);
                } catch {
                    console.error(`Received invalid message: ${JSON.stringify(message.data)}`);
                    return;
                }

                const type: number = data[0];
                const id: number = data[1];
                const name: string = data[2];
                const args: any[] = data[3];

                if (this.authTimeout) {
                    clearTimeout(this.authTimeout);
                    this.authTimeout = null;
                }

                if (type === MESSAGE_TYPES.CALLBACK) {
                    this.findAnswer(id, args);
                } else if (type === MESSAGE_TYPES.MESSAGE) {
                    if (name === '___ready___') {
                        this.connected = true;

                        if (this.wasConnected) {
                            this.reconnectHandlers.forEach(cb => cb.call(this, true));
                        } else {
                            this.connectHandlers.forEach(cb => cb.call(this, true));
                            this.wasConnected = true;
                        }

                        if (this.connectingTimer) {
                            clearTimeout(this.connectingTimer);
                            this.connectingTimer = null;
                        }

                        // resend all pending requests
                        if (this.pending.length) {
                            this.pending.forEach(({ name, args }) => this.emit(name, ...args));

                            this.pending = [];
                        }
                    } else if (args) {
                        this.handlers[name]?.forEach(cb => cb.apply(this, args));
                    } else {
                        this.handlers[name]?.forEach(cb => cb.call(this));
                    }
                } else if (type === MESSAGE_TYPES.PING) {
                    if (this.socket) {
                        this.socket.send(JSON.stringify([MESSAGE_TYPES.PONG]));
                    } else {
                        this.log.warn('Cannot do pong: connection closed');
                    }
                } else if (type === MESSAGE_TYPES.PONG) {
                    // lastPong saved
                } else {
                    this.log.warn(`Received unknown message type: ${type}`);
                }
            };
        }

        return this;
    }

    private _garbageCollect(): void {
        const now = Date.now();
        let empty = 0;
        if (!DEBUG) {
            for (let i = 0; i < this.callbacks.length; i++) {
                const callback: { ts: number; cb: SocketEventHandler; id: number } | null = this.callbacks[i];
                if (callback) {
                    if (callback.ts > now) {
                        const cb = callback.cb;
                        setTimeout(cb, 0, 'timeout');
                        this.callbacks[i] = null;
                        empty++;
                    } // else callback is still valid
                } else {
                    empty++;
                }
            }
        }

        // remove nulls
        if (empty > this.callbacks.length / 2) {
            const newCallback = [];
            for (let i = 0; i < this.callbacks.length; i++) {
                this.callbacks[i] && newCallback.push(this.callbacks[i]);
            }
            this.callbacks = newCallback;
        }
    }

    private withCallback(name: string, id: number, args: any[], cb: SocketEventHandler): void {
        if (name === 'authenticate') {
            this.authTimeout = setTimeout(() => {
                this.authTimeout = null;
                if (this.connected) {
                    this.log.debug('Authenticate timeout');
                    this.handlers.error?.forEach(cb => cb.call(this, 'Authenticate timeout'));
                }
                this.close();
            }, this.options?.authTimeout || 3000);
        }
        this.callbacks.push({ id, cb, ts: DEBUG ? 0 : Date.now() + 30000 });
        this.socket?.send(JSON.stringify([MESSAGE_TYPES.CALLBACK, id, name, args]));
    }

    private findAnswer(id: number, args: any[]): void {
        for (let i = 0; i < this.callbacks.length; i++) {
            const callback = this.callbacks[i];
            if (callback?.id === id) {
                const cb = callback.cb;
                cb.call(null, ...args);
                this.callbacks[i] = null;
            }
        }
    }

    emit = (name: string, ...args: any[]): void => {
        if (!this.socket || !this.connected) {
            if (!this.wasConnected) {
                // cache all calls till connected
                this.pending.push({ name, args });
            } else {
                this.log.warn('Not connected');
            }
            return;
        }

        this.id++;

        if (name === 'writeFile' && args && typeof args[2] !== 'string' && args[2]) {
            // Arguments: arg1,     arg2,     arg3, arg4
            // Arguments: _adapter, filename, data, callback
            if (typeof (globalThis as any).process !== 'undefined') {
                // Node.js environment
                args[2] = (globalThis as any).Buffer.from(args[2]).toString('base64');
            } else {
                // Browser environment
                let binary = '';
                const bytes = new Uint8Array(args[2]);
                const len = bytes.byteLength;
                for (let i = 0; i < len; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                args[2] = globalThis.btoa(binary);
            }
        }

        try {
            // if the last argument is a function
            if (args && typeof args[args.length - 1] === 'function') {
                const _args = [...args];
                const eventHandler: SocketEventHandler = _args.pop();
                this.withCallback(name, this.id, _args, eventHandler);
            } else if (!args?.length) {
                this.socket.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.id, name]));
            } else {
                this.socket.send(JSON.stringify([MESSAGE_TYPES.MESSAGE, this.id, name, args]));
            }
        } catch (e) {
            console.error(`Cannot send: ${e}`);
            this.close();
        }
    };

    on(
        name: string,
        cb: SocketEventHandler | SocketErrorHandler | SocketDisconnectionHandler | SocketConnectionHandler,
    ): void {
        if (cb) {
            if (name === 'connect') {
                this.connectHandlers.push(cb as SocketConnectionHandler);
            } else if (name === 'disconnect') {
                this.disconnectHandlers.push(cb as SocketDisconnectionHandler);
            } else if (name === 'reconnect') {
                this.reconnectHandlers.push(cb as SocketConnectionHandler);
            } else if (name === 'error') {
                this.errorHandlers.push(cb as SocketErrorHandler);
            } else {
                this.handlers[name] = this.handlers[name] || [];
                this.handlers[name].push(cb as SocketEventHandler);
            }
        }
    }

    off(
        name: string,
        cb: SocketEventHandler | SocketErrorHandler | SocketDisconnectionHandler | SocketConnectionHandler,
    ): void {
        if (name === 'connect') {
            const pos = this.connectHandlers.indexOf(cb as SocketConnectionHandler);
            if (pos !== -1) {
                this.connectHandlers.splice(pos, 1);
            }
        } else if (name === 'disconnect') {
            const pos = this.disconnectHandlers.indexOf(cb as SocketDisconnectionHandler);
            if (pos !== -1) {
                this.disconnectHandlers.splice(pos, 1);
            }
        } else if (name === 'reconnect') {
            const pos = this.reconnectHandlers.indexOf(cb as SocketConnectionHandler);
            if (pos !== -1) {
                this.reconnectHandlers.splice(pos, 1);
            }
        } else if (name === 'error') {
            const pos = this.errorHandlers.indexOf(cb as SocketErrorHandler);
            if (pos !== -1) {
                this.errorHandlers.splice(pos, 1);
            }
        } else if (this.handlers[name]) {
            const pos = this.handlers[name].indexOf(cb as SocketEventHandler);
            if (pos !== -1) {
                this.handlers[name].splice(pos, 1);
                if (!this.handlers[name].length) {
                    delete this.handlers[name];
                }
            }
        }
    }

    close(): SocketClient {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }

        if (this.authTimeout) {
            clearTimeout(this.authTimeout);
            this.authTimeout = null;
        }

        if (this.connectingTimer) {
            clearTimeout(this.connectingTimer);
            this.connectingTimer = null;
        }

        if (this.socket) {
            try {
                this.socket.close();
            } catch {
                // ignore
            }
            this.socket = null;
        }

        if (this.connected) {
            this.disconnectHandlers.forEach(cb => cb.call(this));
            this.connected = false;
        }

        this.callbacks = [];

        this._reconnect();

        return this;
    }

    // alias for back compatibility
    disconnect = this.close;

    destroy(): void {
        this.close();
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
    }

    private _reconnect(): void {
        if (!this.connectTimer) {
            this.log.debug(`Start reconnect ${this.connectionCount}`);
            this.connectTimer = setTimeout(
                () => {
                    if (!this.options) {
                        throw new Error('No options provided!');
                    }
                    this.connectTimer = null;
                    if (this.connectionCount < (this.options?.connectMaxAttempt || 5)) {
                        this.connectionCount++;
                    }
                    this.connect(this.url, this.options);
                },
                this.connectionCount * (this.options?.connectInterval || 1000),
            );
        } else {
            this.log.debug(`Reconnect is already running ${this.connectionCount}`);
        }
    }
}

// every time creates a new socket
function connect(url?: string, options?: ConnectOptions): SocketClient {
    const socketClient = new SocketClient();
    socketClient.connect(url, options);
    return socketClient;
}

(globalThis as any).io = {
    connect,
};
