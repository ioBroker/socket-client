import type { ConnectionProps, LogMessage } from './ConnectionProps.js';
import { createDeferredPromise } from './DeferredPromise.js';
import type { EmitEventHandler, ListenEventHandler, SocketClient } from './SocketClient.js';
import { getObjectViewResultToArray, normalizeHostId, pattern2RegEx, wait } from './tools.js';

if (typeof (globalThis as any).process !== 'undefined') {
    // Implement location, localStorage and sessionStorage for Node.js environment
    // @ts-expect-error globalThis.location is not defined in Node.js
    globalThis.location ||= {
        href: 'http://localhost:8081/',
        protocol: 'http:',
        host: 'localhost:8081',
        pathname: '/',
        hostname: 'localhost',
        reload: () => {},
    };
    // @ts-expect-error globalThis.location is not defined in Node.js
    globalThis.localStorage ||= {
        _keys: {} as { [key: string]: string },
        setItem: (key: string, value: string) => {
            globalThis.localStorage._keys[key] = value;
        },
        getItem: (key: string): string | null => {
            if (key in globalThis.localStorage._keys) {
                return globalThis.localStorage._keys[key];
            }
            return null;
        },
        removeItem: (key: string) => {
            if (key in globalThis.localStorage._keys) {
                delete globalThis.localStorage._keys[key];
            }
        },
    };
    globalThis.sessionStorage ||= globalThis.localStorage;
    globalThis.navigator ||= {
        language: 'en',
    } as Navigator;
}

export interface OAuth2Response {
    /** The access token */
    access_token: string;
    /** The time in seconds when the access token expires, e.g., 3600 for 1 hour */
    expires_in: number;
    /** The type of the token */
    token_type: 'Bearer' | 'JWT';
    /** The refresh token */
    refresh_token: string;
    /** The time in seconds when the refresh token expires, e.g., 600 for 10 minutes */
    refresh_token_expires_in: number;
}

export interface StoredTokens {
    refresh_token: string;
    access_token: string;
    expires_in: Date;
    refresh_token_expires_in: Date;
    stayLoggedIn: boolean;
    owner: string | undefined;
}

export interface SocketACL {
    user: `system.user.${string}` | '';
    groups: `system.group.${string}`[];
    object?: {
        read: boolean;
        list: boolean;
        write: boolean;
        delete: boolean;
    };
    state?: {
        list: boolean;
        read: boolean;
        write: boolean;
        delete: boolean;
        create: boolean;
    };
    users?: {
        create: boolean;
        delete: boolean;
        write: boolean;
    };
    other?: {
        http: boolean;
        execute: boolean;
        sendto: boolean;
    };
    file?: {
        list: boolean;
        create: boolean;
        write: boolean;
        read: boolean;
        delete: boolean;
    };
}

/** Possible progress states. */
export enum PROGRESS {
    /** The socket is connecting. */
    CONNECTING = 0,
    /** The socket is successfully connected. */
    CONNECTED = 1,
    /** All objects are loaded. */
    OBJECTS_LOADED = 2,
    /** The socket is ready for use. */
    READY = 3,
}

export enum ERRORS {
    PERMISSION_ERROR = 'permissionError',
    NOT_CONNECTED = 'notConnectedError',
    TIMEOUT = 'timeout',
    NOT_ADMIN = 'Allowed only in admin',
    NOT_SUPPORTED = 'Not supported',
}

/** @deprecated Use {@link ERRORS.PERMISSION_ERROR} instead */
export const PERMISSION_ERROR = ERRORS.PERMISSION_ERROR;
/** @deprecated Use {@link ERRORS.NOT_CONNECTED} instead */
export const NOT_CONNECTED = ERRORS.NOT_CONNECTED;

// Options to use for the backend request wrapper
/**
 * @internal
 */
export interface RequestOptions<T> {
    /** The key that is used to cache the results for later requests of the same kind */
    cacheKey?: string;
    /** Used to bypass the cache */
    forceUpdate?: boolean;
    /** Can be used to identify the request method in error messages */
    requestName?: string;
    /**
     * The timeout in milliseconds after which the call will reject with a timeout error.
     * If no timeout is given, the default is used. Set this to `false` to explicitly disable the timeout.
     */
    commandTimeout?: number | false;
    /** Will be called when the timeout elapses */
    onTimeout?: () => void;
    /** Whether the call should only be allowed in the admin adapter */
    requireAdmin?: boolean;
    /** Require certain features to be supported for this call */
    requireFeatures?: string[];
    /** The function that does the actual work */
    executor: (
        resolve: (value: T | PromiseLike<T> | Promise<T>) => void,
        reject: (reason?: any) => void,
        /** Can be used to check in the executor whether the request has timed out and/or stop it from timing out */
        timeout: Readonly<{ elapsed: boolean; clearTimeout: () => void }>,
    ) => void | Promise<void>;
}

export type BinaryStateChangeHandler = (id: string, base64: string | null) => void;

export type FileChangeHandler = (
    id: string,
    fileName: string,
    size: number | null, // null if deleted
) => void;

export interface OldObject {
    _id: string;
    type: string;
}

export type ObjectChangeHandler = (
    id: string,
    obj: ioBroker.Object | null | undefined,
    oldObj?: OldObject,
) => void | Promise<void>;

export type InstanceMessageCallback = (data: any, sourceInstance: string, messageType: string) => void | Promise<void>;

export type InstanceSubscribe = {
    messageType: string;
    callback: InstanceMessageCallback;
};

const ADAPTERS = ['material', 'echarts', 'vis'];

export class Connection<
    CustomListenEvents extends Record<keyof CustomListenEvents, ListenEventHandler> = Record<string, never>,
    CustomEmitEvents extends Record<keyof CustomEmitEvents, EmitEventHandler> = Record<string, never>,
> {
    private readonly props: ConnectionProps;
    public readonly connId: string;
    private lastAccessToken: string | null = null;

    private ignoreState: string = '';
    private connected: boolean = false;
    private subscribed: boolean = false;
    private firstConnect: boolean = true;
    public waitForRestart: boolean = false;
    public loaded: boolean = false;
    private simStates: Record<string, ioBroker.State> = {};

    constructor(props: Partial<ConnectionProps>) {
        this.props = this.applyDefaultProps(props);

        // Create unique ID of this instance
        this.connId = `${this.props.name ? `${this.props.name}-` : ''}${Math.round(Math.random() * 1000000)
            .toString()
            .padStart(6, '0')}`;

        this.waitForSocketLib()
            .then(() => this.startSocket())
            .catch(e => {
                alert(`Socket connection could not be initialized: ${e}`);
            });
    }

    private applyDefaultProps(props: Partial<ConnectionProps>): ConnectionProps {
        return {
            ...props,
            // Define default props that always need to be set
            protocol: props.protocol || globalThis.location.protocol,
            host: props.host || globalThis.location.hostname,
            port: props.port || (globalThis.location.port === '3000' ? 8081 : globalThis.location.port),
            ioTimeout: Math.max(props.ioTimeout || 20000, 20000),
            cmdTimeout: Math.max(props.cmdTimeout || 5000, 5000),
            admin5only: props.admin5only || false,
            autoSubscribes: props.autoSubscribes ?? [],
            autoSubscribeLog: props.autoSubscribeLog ?? false,
            doNotLoadACL: props.doNotLoadACL ?? true,
            doNotLoadAllObjects: props.doNotLoadAllObjects ?? true,
        };
    }

    private readonly statesSubscribes: Record<
        string,
        {
            reg: RegExp;
            cbs: (ioBroker.StateChangeHandler | BinaryStateChangeHandler)[];
        }
    > = {};
    private readonly filesSubscribes: Record<
        string,
        {
            regId: RegExp;
            regFilePattern: RegExp;
            cbs: FileChangeHandler[];
        }
    > = {};
    private readonly objectsSubscribes: Record<string, { reg: RegExp; cbs: ObjectChangeHandler[] }> = {};
    private objects: Record<string, ioBroker.Object> = {};
    private states: Record<string, ioBroker.State> = {};

    public acl: SocketACL | null = null;
    public isSecure: boolean = false;
    // Do not inform about readiness two times
    public onReadyDone: boolean = false;

    private readonly onConnectionHandlers: ((connected: boolean) => void)[] = [];
    private readonly onLogHandlers: ((message: LogMessage) => void)[] = [];

    private onCmdStdoutHandler?: (id: string, text: string) => void;
    private onCmdStderrHandler?: (id: string, text: string) => void;
    private onCmdExitHandler?: (id: string, exitCode: number) => void;
    private onError(error: any): void {
        (this.props.onError ?? console.error)(error);
    }

    /** The socket instance */
    protected _socket!: SocketClient<CustomListenEvents, CustomEmitEvents>;

    private _waitForSocketPromise?: Promise<void>;
    private readonly _waitForFirstConnectionPromise = createDeferredPromise();

    /** array with all subscriptions to instances */
    private _instanceSubscriptions: Record<string, InstanceSubscribe[]> = {};

    /** Cache for server requests */
    private readonly _promises: Record<string, Promise<any>> = {};

    protected _authTimer: ReturnType<typeof setTimeout> | null = null;
    protected _refreshTimer: ReturnType<typeof setTimeout> | null = null;

    protected _systemConfig?: ioBroker.SystemConfigObject;
    /** The "system.config" object */
    public get systemConfig(): Readonly<ioBroker.SystemConfigObject> | undefined {
        return this._systemConfig;
    }

    /** System language. It could be changed during runtime */
    public systemLang: ioBroker.Languages = 'en';

    /**
     * Checks if this connection is running in a web adapter and not in an admin.
     *
     * @returns True if running in a web adapter or in a socketio adapter.
     */
    static isWeb(): boolean {
        return (globalThis as any).socketUrl !== undefined;
    }

    private waitForSocketLib(): Promise<void> {
        // Only wait once
        if (this._waitForSocketPromise) {
            return this._waitForSocketPromise;
        }

        // eslint-disable-next-line no-async-promise-executor
        this._waitForSocketPromise = new Promise(async (resolve, reject) => {
            // Connect function was provided, so we do not need to wait for the socket.io library
            if (this.props.connect) {
                resolve();
                return;
            }

            // If socket io is not yet loaded, we need to wait for it
            if (typeof (globalThis as any).io === 'undefined' && typeof (globalThis as any).iob === 'undefined') {
                // If the registerSocketOnLoad function is defined in index.html,
                // we can use it to know when the socket library was loaded
                if (typeof (globalThis as any).registerSocketOnLoad === 'function') {
                    (globalThis as any).registerSocketOnLoad(() => resolve());
                } else {
                    // otherwise, we need to poll
                    for (let i = 1; i <= 30; i++) {
                        if ((globalThis as any).io || (globalThis as any).iob) {
                            return resolve();
                        }
                        await wait(100);
                    }

                    reject(new Error('Socket library could not be loaded!'));
                }
            } else {
                resolve();
            }
        });
        return this._waitForSocketPromise;
    }

    /**
     * Starts the socket.io connection.
     */
    async startSocket(): Promise<void> {
        if (this._socket) {
            return;
        }

        let host = this.props.host;
        let port = this.props.port;
        let protocol = (this.props.protocol || globalThis.location.protocol).replace(':', '');
        let path = globalThis.location.pathname;

        if (globalThis.location.hostname === 'iobroker.net' || globalThis.location.hostname === 'iobroker.pro') {
            path = '';
        } else {
            // if web adapter, socket io could be on another port or even host
            if ((globalThis as any).socketUrl) {
                const parsed = new globalThis.URL((globalThis as any).socketUrl);
                host = parsed.hostname;
                port = parsed.port;
                protocol = parsed.protocol.replace(':', '');
            }
            // get a current path
            const pos = path.lastIndexOf('/');
            if (pos !== -1) {
                path = path.substring(0, pos + 1);
            }

            if (Connection.isWeb()) {
                // remove one level, like echarts, vis, .... We have here: '/echarts/'
                const parts = path.split('/');
                if (parts.length > 2) {
                    parts.pop();
                    parts.pop();
                    // material can have paths like this '/material/1.3.0/', so remove one more level
                    if (ADAPTERS.includes(parts[parts.length - 1])) {
                        parts.pop();
                    }
                    path = parts.join('/');
                    if (!path.endsWith('/')) {
                        path += '/';
                    }
                }
            }
        }

        const url = port ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;

        const connectFunc: (name: string, par: any) => SocketClient =
            this.props.connect || ((globalThis as any).io || (globalThis as any).iob).connect;

        this._socket = connectFunc(url, {
            path: path.endsWith('/') ? `${path}socket.io` : `${path}/socket.io`,
            query: 'ws=true',
            name: this.props.name,
            timeout: this.props.ioTimeout,
            uuid: this.props.uuid,
            token: this.props.token,
        });

        this._socket.on('connect', noTimeout => {
            // Listen for messages from other tabs
            globalThis.addEventListener?.('storage', this.onAccessTokenUpdated);

            const tokens = Connection.readTokens();
            if (tokens && !tokens.owner) {
                // Take the ownership of the token
                const now = Date.now();
                this.saveTokens(
                    {
                        access_token: tokens.access_token,
                        refresh_token: tokens.refresh_token,
                        expires_in: Math.round((tokens.expires_in.getTime() - now) / 1000),
                        refresh_token_expires_in: Math.round((tokens.refresh_token_expires_in.getTime() - now) / 1000),
                        token_type: 'Bearer',
                    },
                    tokens.stayLoggedIn,
                );
            }

            this.onReadyDone = false;
            // If the user is not admin, it takes some time to install the handlers, because all rights must be checked
            if (noTimeout !== true) {
                this.connected = true;
                setTimeout(
                    () =>
                        this.getVersion()
                            .then(info => {
                                const [major, minor, patch] = info.version.split('.');
                                const v = parseInt(major, 10) * 10000 + parseInt(minor, 10) * 100 + parseInt(patch, 10);
                                if (v < 40102) {
                                    this._authTimer = null;
                                    // possible this is an old version of admin
                                    this.onPreConnect(false, false);
                                } else {
                                    this._socket.emit('authenticate', (isOk, isSecure) =>
                                        this.onPreConnect(isOk, isSecure),
                                    );
                                }
                            })
                            .catch(e =>
                                this.onError({
                                    message: e.toString(),
                                    operation: 'getVersion',
                                }),
                            ),
                    500,
                );
            } else {
                // iobroker websocket waits, till all handlers are installed
                this._socket.emit('authenticate', (isOk, isSecure) => {
                    this.onPreConnect(isOk, isSecure);
                });
            }
        });

        this._socket.on('reconnect', () => {
            this.onReadyDone = false;
            this.props.onProgress?.(PROGRESS.READY);
            this.connected = true;

            if (this.waitForRestart) {
                globalThis.location.reload();
            } else {
                this._subscribe(true);
                this.onConnectionHandlers.forEach(cb => cb(true));
            }
        });

        this._socket.on('disconnect', () => {
            this.onReadyDone = false;
            this.connected = false;
            this.subscribed = false;
            this.props.onProgress?.(PROGRESS.CONNECTING);
            this.onConnectionHandlers.forEach(cb => cb(false));
        });

        this._socket.on('reauthenticate', () => this.authenticate());

        this._socket.on('log', (message: LogMessage) => {
            this.props.onLog?.(message);
            this.onLogHandlers.forEach(cb => cb(message));
        });

        this._socket.on('error', (err: any) => {
            let _err: string;

            if (err == undefined) {
                _err = '';
            } else if (typeof err.toString === 'function') {
                _err = err.toString();
            } else {
                _err = JSON.stringify(err);
                console.error(`Received strange error: ${_err}`);
            }

            if (_err.includes('User not authorized')) {
                this.authenticate();
            } else if (_err.includes('websocket error')) {
                console.error(`Socket Error => reload: ${err}`);
                globalThis.location.reload();
            } else {
                console.error(`Socket Error: ${err}`);
            }
        });

        this._socket.on('connect_error', (err: any) => console.error(`Connect error: ${err}`));

        this._socket.on('permissionError', err =>
            this.onError({
                message: 'no permission',
                operation: err.operation,
                type: err.type,
                id: err.id || '',
            }),
        );

        this._socket.on('objectChange', (id, obj) => {
            setTimeout(() => this.objectChange(id, obj), 0);
        });

        this._socket.on('stateChange', (id, state) => {
            setTimeout(() => this.stateChange(id, state), 0);
        });

        // instance message
        this._socket.on('im', (messageType, from, data) => {
            setTimeout(() => this.instanceMessage(messageType, from, data), 0);
        });

        this._socket.on('fileChange', (id, fileName, size) => {
            setTimeout(() => this.fileChange(id, fileName, size), 0);
        });

        this._socket.on('cmdStdout', (id, text) => {
            this.onCmdStdoutHandler?.(id, text);
        });

        this._socket.on('cmdStderr', (id, text) => {
            this.onCmdStderrHandler?.(id, text);
        });

        this._socket.on('cmdExit', (id, exitCode) => {
            this.onCmdExitHandler?.(id, exitCode);
        });

        return Promise.resolve();
    }

    /**
     * Called internally.
     */
    private onPreConnect(_isOk: boolean, isSecure: boolean): void {
        if (this._authTimer) {
            clearTimeout(this._authTimer);
            this._authTimer = null;
        }

        this.connected = true;
        this.isSecure = isSecure;

        if (this.waitForRestart) {
            globalThis.location.reload();
        } else {
            if (this.firstConnect) {
                void this.loadData().catch(e => {
                    console.error(`Cannot load data: ${e}`);
                });
            } else {
                this.props.onProgress?.(PROGRESS.READY);
            }

            this._subscribe(true);
            this.onConnectionHandlers.forEach(cb => cb(true));

            this.checkAccessTokenExpire();
        }

        this._waitForFirstConnectionPromise.resolve();
    }

    static readTokens(): StoredTokens | null {
        let tokenString: string | null | undefined = globalThis.sessionStorage.getItem('iob_tokens');
        const stayLoggedIn = !tokenString;
        if (!tokenString) {
            tokenString = globalThis.localStorage.getItem('iob_tokens');
        }
        if (!tokenString) {
            return null;
        }

        const [refresh_token, refresh_token_expires_in, access_token, expires_in, owner] = tokenString.split(';');
        const refreshExpires = new Date(refresh_token_expires_in);
        if (refreshExpires.getTime() < Date.now()) {
            // refresh token expired
            return null;
        }
        return {
            refresh_token,
            refresh_token_expires_in: refreshExpires,
            access_token,
            expires_in: new Date(expires_in),
            owner,
            stayLoggedIn,
        };
    }

    static saveTokensStatic(data: OAuth2Response, stayLoggedIn: boolean, owner?: string): void {
        const tokenStr = `${data.refresh_token};${new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString()};${data.access_token};${new Date(Date.now() + data.expires_in * 1000).toISOString()}${owner ? `;${owner}` : ''}`;
        if (stayLoggedIn) {
            globalThis.localStorage.setItem('iob_tokens', tokenStr);
        } else {
            globalThis.sessionStorage.setItem('iob_tokens', tokenStr);
        }
    }

    public saveTokens(data: OAuth2Response, stayLoggedIn: boolean): void {
        Connection.saveTokensStatic(data, stayLoggedIn, this.connId);
    }

    static deleteTokensStatic(): void {
        globalThis.localStorage.removeItem('iob_tokens');
        globalThis.sessionStorage.removeItem('iob_tokens');
    }

    /**
     * Destroy tokens if they were created by this connection if they expired or invalid
     *
     * @param stayLoggedIn if stored in localStorage or in sessionStorage
     * @param logout if logout is requested
     */
    public deleteTokens(stayLoggedIn: boolean, logout?: boolean): void {
        const tokens = Connection.readTokens();
        if (tokens) {
            if (logout) {
                Connection.deleteTokensStatic();
            } else if (tokens.stayLoggedIn === stayLoggedIn && tokens.owner === this.connId) {
                if (tokens.stayLoggedIn) {
                    globalThis.localStorage.removeItem('iob_tokens');
                } else {
                    globalThis.sessionStorage.removeItem('iob_tokens');
                }
            }
        }
    }

    private onAccessTokenUpdated = (event: StorageEvent): void => {
        // Storage event is only fired in other tabs/globalThiss (or iframes) of the same origin when the localStorage (or sessionStorage) is modified, and not in the same globalThis where the change was made.
        if (event.key === 'iob_tokens') {
            const tokens = Connection.readTokens();
            if (tokens) {
                console.log(`Tab ${this.connId} received updated token: ${tokens.access_token}`);
                this.updateTokenExpiration(tokens.access_token);
            }
        }
    };

    private updateTokenExpiration(accessToken: string): void {
        // This connection is not a token owner, so only read the new access token and inform the server
        if (this.lastAccessToken !== accessToken) {
            this.lastAccessToken = accessToken;
            this._socket.emit('updateTokenExpiration', accessToken, (err: string | null, success?: boolean): void => {
                if (err) {
                    console.error(`[UPDATE/${new Date().toISOString()}] cannot say to server about new token: ${err}`);
                    globalThis.location.reload();
                } else if (!success) {
                    console.error(`[UPDATE/${new Date().toISOString()}] cannot say to server about new token`);
                    globalThis.location.reload();
                } else {
                    console.log(`[UPDATE/${new Date().toISOString()}] server accepted new token: ${accessToken}`);
                }
            });
        }

        this.checkAccessTokenExpire();
    }

    private refreshTokens(tokenStructure: StoredTokens, takeOwnership?: boolean): void {
        if (!tokenStructure) {
            console.log(`[REFRESH/${new Date().toISOString()}] No token structure found => reloading the page`);
            // Refresh the page, as we cannot refresh the token
            setTimeout(() => globalThis.location.reload(), 500);
            return;
        }

        if (takeOwnership || !tokenStructure.owner || tokenStructure.owner === this.connId) {
            console.log(`[REFRESH/${new Date().toISOString()}] claim ownership of the token`);
            if (this.acquireTokenLock()) {
                console.log(`[REFRESH/${new Date().toISOString()}] refreshing token`);
                // Access token will expire soon => Send authentication again
                fetch('./oauth/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: `grant_type=refresh_token&refresh_token=${tokenStructure.refresh_token}&client_id=ioBroker&stayloggedin=${tokenStructure.stayLoggedIn}`,
                })
                    .then(response => {
                        if (response.ok) {
                            return response.json();
                        }
                        throw new Error('Cannot refresh access token');
                    })
                    .then((data: OAuth2Response): void => {
                        if (data.access_token) {
                            console.log(
                                `[REFRESH/${new Date().toISOString()}] received new token: ${data.access_token}`,
                            );
                            this.saveTokens(data, tokenStructure.stayLoggedIn);

                            this.releaseTokenLock();

                            this.updateTokenExpiration(data.access_token);
                        } else {
                            throw new Error('Cannot get access token');
                        }
                    })
                    .catch(err => {
                        console.warn(`[REFRESH/${new Date().toISOString()}] cannot refresh token: ${err}`);
                        this.releaseTokenLock();
                        this.deleteTokens(tokenStructure.stayLoggedIn);
                        console.error(err);
                        globalThis.location.reload();
                    });
            } else {
                console.log(
                    `[REFRESH/${new Date().toISOString()}] Someone else is updating the token, so wait for the next check`,
                );
                // Someone else is updating the token, so wait for the next check
                this.checkAccessTokenExpire();
            }
        } else if (this.lastAccessToken !== tokenStructure.access_token) {
            this.updateTokenExpiration(tokenStructure.access_token);
        }
    }

    /**
     * Attempts to acquire the semaphore lock.
     *
     * @returns True if the lock was acquired successfully; otherwise, false.
     */
    acquireTokenLock(): boolean {
        const now = Date.now();
        const lock = globalThis.localStorage.getItem('iob_token_semaphore');

        if (lock) {
            try {
                const lockData: { expiry: number; connId: string } = JSON.parse(lock);
                // If the current lock is still valid, we cannot acquire the lock.
                if (now < lockData.expiry) {
                    return false;
                }
                // Otherwise, the lock has expired and we can override it.
            } catch {
                // ignore
            }
        }

        // Create a new lock with expiry 10 seconds from now.
        const newLock: { expiry: number; connId: string } = {
            connId: this.connId,
            expiry: now + 10 * 1000, // 10 seconds in milliseconds
        };

        globalThis.localStorage.setItem('iob_token_semaphore', JSON.stringify(newLock));
        return true;
    }

    /** Releases the semaphore lock if it's owned by the given connection ID. */
    releaseTokenLock(): void {
        const lock = globalThis.localStorage.getItem('iob_token_semaphore');
        if (lock) {
            try {
                const lockData: { expiry: number; connId: string } = JSON.parse(lock);
                // Only remove the lock if it's owned by the current connection.
                if (lockData.connId === this.connId) {
                    globalThis.localStorage.removeItem('iob_token_semaphore');
                }
            } catch {
                // If parsing fails, remove the lock just in case.
                globalThis.localStorage.removeItem('iob_token_semaphore');
            }
        }
    }

    private checkAccessTokenExpire(): void {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (this.isSecure) {
            const tokens = Connection.readTokens();
            if (tokens) {
                const accessExpireInUnixMs = tokens.expires_in.getTime();
                // Check if the access token expires in the next 30 seconds
                if (accessExpireInUnixMs < Date.now() + 30_000) {
                    const takeOwnership = accessExpireInUnixMs < Date.now() + 5_500;
                    console.log(`[TOKEN/${new Date().toISOString()}] Updating refresh token ${tokens.access_token}`);
                    if (!tokens.refresh_token) {
                        console.log(
                            `[TOKEN/${new Date().toISOString()}] We do not have a refresh token, so we need to reauthenticate`,
                        );
                        // Refresh the page, as we cannot refresh the token
                        setTimeout(
                            () => globalThis.location.reload(),
                            Date.now() > accessExpireInUnixMs ? 500 : accessExpireInUnixMs - Date.now(),
                        );
                    } else if (
                        tokens.owner === this.connId ||
                        // We gave 25 seconds to the owner to update the token, and now we will do it and take the ownership
                        takeOwnership
                    ) {
                        if (tokens.owner === this.connId) {
                            console.log(`[TOKEN/${new Date().toISOString()}] We are the owner of the token`);
                        } else {
                            console.log(
                                `[TOKEN/${new Date().toISOString()}] We are not the owner of the token, but we will take ownership`,
                            );
                        }
                        // Handle token expiration if the connection is the owner of the token
                        if (this.props.tokenTimeoutHandler) {
                            console.log(
                                `[TOKEN/${new Date().toISOString()}] Asking GUI if we should prolong the token`,
                            );
                            // Asc if the user wants to stay logged in
                            void this.props.tokenTimeoutHandler(accessExpireInUnixMs).then(prolong => {
                                if (prolong) {
                                    console.log(`[TOKEN/${new Date().toISOString()}] Token will be prolonged`);
                                    this.refreshTokens(tokens, takeOwnership);
                                } else {
                                    console.log(
                                        `[TOKEN/${new Date().toISOString()}] Token will not be prolonged. Reloading the page`,
                                    );
                                    // Refresh the page, as we cannot refresh the token
                                    setTimeout(
                                        () => globalThis.location.reload(),
                                        Date.now() > accessExpireInUnixMs ? 500 : accessExpireInUnixMs - Date.now(),
                                    );
                                }
                            });
                        } else {
                            console.log(
                                `[TOKEN/${new Date().toISOString()}] No tokenTimeoutHandler defined. Prolonging the token`,
                            );
                            this.refreshTokens(tokens, takeOwnership);
                        }
                    } else if (this.lastAccessToken !== tokens.access_token) {
                        console.log(
                            `[TOKEN/${new Date().toISOString()}] We are not the owner of the token, but we will inform the server about new token`,
                        );
                        // The connection is not the owner, so just check if access_token changed, so inform the server about it
                        this.refreshTokens(tokens);
                    } else {
                        console.log(
                            `[TOKEN/${new Date().toISOString()}] We are not the owner of the token and the token did not change. Check in 3 seconds if the owner updated the token`,
                        );
                        // What 3 seconds and check again, maybe the owner connection will update the token
                        this._refreshTimer = setTimeout(() => {
                            this._refreshTimer = null;
                            this.checkAccessTokenExpire();
                        }, 3_000);
                    }
                } else {
                    this._refreshTimer = setTimeout(
                        () => {
                            this._refreshTimer = null;
                            this.checkAccessTokenExpire();
                        },
                        accessExpireInUnixMs - Date.now() - 30_000 > 120_000
                            ? 120_000
                            : accessExpireInUnixMs - Date.now() - 30_000,
                    );
                }
            }
        }
    }

    /**
     * Checks if running in ioBroker cloud
     */
    static isCloud(): boolean {
        if (
            globalThis.location.hostname.includes('amazonaws.com') ||
            globalThis.location.hostname.includes('iobroker.in')
        ) {
            return true;
        }
        if (typeof (globalThis as any).socketUrl === 'undefined') {
            return false;
        }
        return (
            (globalThis as any).socketUrl.includes('iobroker.in') || (globalThis as any).socketUrl.includes('amazonaws')
        );
    }

    /**
     * Checks if the socket is connected.
     *
     * @returns true if connected.
     */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Returns a promise which is resolved when the socket is connected.
     */
    waitForFirstConnection(): Promise<void> {
        return this._waitForFirstConnectionPromise;
    }

    /**
     * Called internally.
     */
    private async getUserPermissions(): Promise<SocketACL | null> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getUserPermissions', (err, acl?: SocketACL | null): void => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(acl || null);
                    }
                });
            },
        });
    }

    /** Loads the important data and retries a couple of times if it takes too long */
    private async loadData(): Promise<void> {
        if (this.loaded) {
            return;
        }
        const maxAttempts = 10;
        for (let i = 1; i <= maxAttempts; i++) {
            void this.doLoadData().catch(e => console.error(`Cannot load data: ${e}`));
            if (this.loaded) {
                return;
            }
            // give more time via remote connection
            await wait(Connection.isCloud() ? 5000 : 1000);
        }
    }

    /**
     * Called after the socket is connected. Loads the necessary data.
     */
    private async doLoadData(): Promise<void> {
        if (this.loaded) {
            return;
        }

        // Load ACL if not disabled
        if (!this.props.doNotLoadACL) {
            try {
                this.acl = await this.getUserPermissions();
            } catch (e) {
                this.onError(`Cannot read user permissions: ${e}`);
                return;
            }
        }

        // Load system config if not disabled
        try {
            if (
                this.props.admin5only &&
                !Connection.isWeb() &&
                (!(globalThis as any).vendorPrefix || (globalThis as any).vendorPrefix === '@@vendorPrefix@@')
            ) {
                this._systemConfig = await this.getCompactSystemConfig();
            } else {
                this._systemConfig = await this.getSystemConfig();
            }
        } catch (e) {
            this.onError(`Cannot read system config: ${e}`);
            return;
        }

        // Detect the system language
        if (this._systemConfig) {
            this.systemLang = this._systemConfig.common?.language;
            if (!this.systemLang) {
                this.systemLang = ((globalThis.navigator as any).userLanguage || globalThis.navigator.language) as any;
                // Browsers may report languages like "de-DE", "en-US", etc.
                // ioBroker expects "de", "en", ...
                if (/^(en|de|ru|pt|nl|fr|it|es|pl|uk)-?/.test(this.systemLang)) {
                    this.systemLang = this.systemLang.substring(0, 2) as any;
                } else if (!/^(en|de|ru|pt|nl|fr|it|es|pl|uk|zh-cn)$/.test(this.systemLang)) {
                    this.systemLang = 'en';
                }
                this._systemConfig.common.language = this.systemLang;
            }
        }
        this.props.onLanguage?.(this.systemLang);

        // We are now connected
        this.loaded = true;
        this.props.onProgress?.(PROGRESS.CONNECTED);
        this.firstConnect = false;

        // Load all objects if desired
        if (!this.props.doNotLoadAllObjects) {
            this.objects = await this.getObjects();
        } else if (this.props.admin5only) {
            this.objects = {};
        } else {
            this.objects = { 'system.config': this._systemConfig };
        }

        this.props.onProgress?.(PROGRESS.READY);
        if (!this.onReadyDone) {
            this.onReadyDone = true;
            this.props.onReady?.(this.objects);
        }
    }

    /**
     * Called internally.
     */
    private authenticate(): void {
        if (globalThis.location.search.includes('&href=')) {
            globalThis.location.href = `${globalThis.location.protocol}//${globalThis.location.host}${globalThis.location.pathname}${globalThis.location.search}`;
        } else {
            globalThis.location.href = `${globalThis.location.protocol}//${globalThis.location.host}${globalThis.location.pathname}?login&href=${encodeURIComponent(globalThis.location.search + globalThis.location.hash)}`;
        }
    }

    /**
     * Subscribe to the changes of the given state.
     * In compare to the subscribeObject method,
     * this method calls the handler with the current state value immediately after subscribing.
     *
     * @param id The ioBroker state ID or array of state IDs.
     * @param binary Set to true if the given state is binary and requires Base64 decoding.
     * @param cb The callback.
     */
    subscribeState(id: string | string[], binary: true, cb: BinaryStateChangeHandler): Promise<void>;

    subscribeState(id: string | string[], binary: false, cb: ioBroker.StateChangeHandler): Promise<void>;

    subscribeState(id: string | string[], cb: ioBroker.StateChangeHandler): Promise<void>;

    async subscribeState(
        ...args:
            | [id: string | string[], binary: true, cb: BinaryStateChangeHandler]
            | [id: string | string[], binary: false, cb: ioBroker.StateChangeHandler]
            | [id: string | string[], cb: ioBroker.StateChangeHandler]
    ): Promise<void> {
        let id: string | string[];
        let binary: boolean;
        let cb: ioBroker.StateChangeHandler | BinaryStateChangeHandler;
        if (args.length === 3) {
            [id, binary, cb] = args;
        } else {
            [id, cb] = args;
            binary = false;
        }
        let ids: string[];
        if (!Array.isArray(id)) {
            ids = [id];
        } else {
            ids = id;
        }

        if (typeof cb !== 'function') {
            throw new Error('The state change handler must be a function!');
        }
        const toSubscribe: string[] = [];
        for (let i = 0; i < ids.length; i++) {
            const _id = ids[i];
            if (!this.statesSubscribes[_id]) {
                this.statesSubscribes[_id] = {
                    reg: new RegExp(pattern2RegEx(_id)),
                    cbs: [cb],
                };
                if (id !== this.ignoreState) {
                    toSubscribe.push(_id);
                }
            } else {
                !this.statesSubscribes[_id].cbs.includes(cb) && this.statesSubscribes[_id].cbs.push(cb);
            }
        }

        if (!this.connected) {
            return;
        }

        if (toSubscribe.length) {
            // no answer from server required
            this._socket.emit('subscribe', toSubscribe);
        }

        // Try to get the current value(s) of the state(s) and call the change handlers
        if (binary) {
            let base64: string | undefined;
            for (let i = 0; i < ids.length; i++) {
                try {
                    // binary states are deprecated
                    base64 = await this.getBinaryState(ids[i]);
                } catch (e) {
                    console.error(`Cannot getBinaryState "${ids[i]}": ${JSON.stringify(e)}`);
                    base64 = undefined;
                }
                if (base64 != undefined) {
                    (cb as BinaryStateChangeHandler)(ids[i], base64);
                }
            }
        } else if (ids.find(_id => _id.includes('*'))) {
            let states: Record<string, ioBroker.State> | undefined;
            for (let i = 0; i < ids.length; i++) {
                try {
                    states = await this.getForeignStates(ids[i]);
                } catch (e) {
                    console.error(`Cannot getForeignStates "${ids[i]}": ${JSON.stringify(e)}`);
                    return;
                }
                if (states) {
                    for (const [id, state] of Object.entries(states)) {
                        const mayBePromise = (cb as ioBroker.StateChangeHandler)(id, state);
                        if (mayBePromise instanceof Promise) {
                            void mayBePromise.catch(e => console.error(`Cannot call state change handler: ${e}`));
                        }
                    }
                }
            }
        } else {
            try {
                const states = await (Connection.isWeb() ? this.getStates(ids) : this.getForeignStates(ids));
                if (states) {
                    for (const [id, state] of Object.entries(states)) {
                        const mayBePromise = (cb as ioBroker.StateChangeHandler)(id, state);
                        if (mayBePromise instanceof Promise) {
                            void mayBePromise.catch(e => console.error(`Cannot call state change handler: ${e}`));
                        }
                    }
                }
            } catch (e) {
                console.error(`Cannot getState "${ids.join(', ')}": ${e.message}`);
                return;
            }
        }
    }

    /**
     * Subscribe to the changes of the given state and wait for answer.
     *
     * @param id The ioBroker state ID.
     * @param cb The callback.
     */
    async subscribeStateAsync(id: string | string[], cb: ioBroker.StateChangeHandler): Promise<void> {
        return this.subscribeState(id, cb);
    }

    /**
     * Unsubscribes the given callback from changes of the given state.
     *
     * @param id The ioBroker state ID or array of state IDs.
     * @param cb The callback.
     */
    unsubscribeState(id: string | string[], cb?: ioBroker.StateChangeHandler): void {
        let ids: string[];
        if (!Array.isArray(id)) {
            ids = [id];
        } else {
            ids = id;
        }
        const toUnsubscribe = [];
        for (let i = 0; i < ids.length; i++) {
            const _id = ids[i];

            if (this.statesSubscribes[_id]) {
                const sub = this.statesSubscribes[_id];
                if (cb) {
                    const pos = sub.cbs.indexOf(cb);
                    pos !== -1 && sub.cbs.splice(pos, 1);
                } else {
                    sub.cbs = [];
                }

                if (!sub.cbs?.length) {
                    delete this.statesSubscribes[_id];
                    if (_id !== this.ignoreState) {
                        toUnsubscribe.push(_id);
                    }
                }
            }
        }
        if (this.connected && toUnsubscribe.length) {
            this._socket.emit('unsubscribe', ids);
        }
    }

    /**
     * Subscribe to changes of the given object.
     * In compare to the subscribeState method,
     * this method does not call the handler with the current value immediately after subscribe.
     *
     * the current value.
     *
     * @param id The ioBroker object ID.
     * @param cb The callback.
     */
    subscribeObject(id: string | string[], cb: ObjectChangeHandler): Promise<void> {
        let ids: string[];
        if (!Array.isArray(id)) {
            ids = [id];
        } else {
            ids = id;
        }

        if (typeof cb !== 'function') {
            throw new Error('The object change handler must be a function!');
        }

        const toSubscribe: string[] = [];
        for (let i = 0; i < ids.length; i++) {
            const _id = ids[i];
            if (!this.objectsSubscribes[_id]) {
                this.objectsSubscribes[_id] = {
                    reg: new RegExp(pattern2RegEx(_id)),
                    cbs: [cb],
                };
                toSubscribe.push(_id);
            } else {
                !this.objectsSubscribes[_id].cbs.includes(cb) && this.objectsSubscribes[_id].cbs.push(cb);
            }
        }

        if (this.connected && toSubscribe.length) {
            this._socket.emit('subscribeObjects', toSubscribe);
        }

        return Promise.resolve();
    }

    /**
     * Unsubscribes all callbacks from changes of the given object.
     *
     * @param id The ioBroker object ID.
     */
    /**
     * Unsubscribes the given callback from changes of the given object.
     *
     * @param id The ioBroker object ID.
     * @param cb The callback.
     */
    unsubscribeObject(id: string | string[], cb?: ObjectChangeHandler): Promise<void> {
        let ids: string[];
        if (!Array.isArray(id)) {
            ids = [id];
        } else {
            ids = id;
        }
        const toUnsubscribe: string[] = [];
        for (let i = 0; i < ids.length; i++) {
            const _id = ids[i];
            if (this.objectsSubscribes[_id]) {
                const sub = this.objectsSubscribes[_id];
                if (cb) {
                    const pos = sub.cbs.indexOf(cb);
                    pos !== -1 && sub.cbs.splice(pos, 1);
                } else {
                    sub.cbs = [];
                }

                if (!sub.cbs?.length) {
                    delete this.objectsSubscribes[_id];
                    toUnsubscribe.push(_id);
                }
            }
        }
        if (this.connected && toUnsubscribe.length) {
            this._socket.emit('unsubscribeObjects', toUnsubscribe);
        }
        return Promise.resolve();
    }

    /**
     * Called internally.
     *
     * @param id The ioBroker object ID.
     * @param obj The new object.
     */
    private objectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        // update main.objects cache

        // Remember the id and type of th old object
        let oldObj: OldObject | undefined;
        if (this.objects[id]) {
            oldObj = { _id: id, type: this.objects[id].type };
        }

        let changed = false;
        if (obj) {
            // The object was added, updated or changed

            // Copy the _rev property (whatever that is)
            if ((obj as any)._rev && this.objects[id]) {
                (this.objects[id] as any)._rev = (obj as any)._rev;
            }

            // Detect if there was a change
            if (!this.objects[id] || JSON.stringify(this.objects[id]) !== JSON.stringify(obj)) {
                this.objects[id] = obj;
                changed = true;
            }
        } else if (this.objects[id]) {
            // The object was deleted
            delete this.objects[id];
            changed = true;
        }

        // Notify all subscribed listeners
        for (const [_id, sub] of Object.entries(this.objectsSubscribes)) {
            if (_id === id || sub.reg.test(id)) {
                sub.cbs.forEach(cb => {
                    try {
                        const mayBePromise = cb(id, obj, oldObj);
                        if (mayBePromise instanceof Promise) {
                            void mayBePromise.catch(e => console.error(`Cannot call object change handler: ${e}`));
                        }
                    } catch (e) {
                        console.error(`Error by callback of objectChange: ${e}`);
                    }
                });
            }
        }

        // Notify the default listener on change
        if (changed) {
            const mayBePromise = this.props.onObjectChange?.(id, obj);
            if (mayBePromise instanceof Promise) {
                void mayBePromise.catch(e => console.error(`Cannot call object change handler: ${e}`));
            }
        }
    }

    /**
     * Called internally.
     *
     * @param id The ioBroker state ID.
     * @param state The new state value.
     */
    private stateChange(id: string, state: ioBroker.State | null | undefined): void {
        for (const sub of Object.values(this.statesSubscribes)) {
            if (sub.reg.test(id)) {
                for (const cb of sub.cbs) {
                    try {
                        const mayBePromise = cb(id, (state ?? null) as any);
                        if (mayBePromise instanceof Promise) {
                            void mayBePromise.catch(e => console.error(`Cannot call state change handler: ${e}`));
                        }
                    } catch (e) {
                        console.error(`Error by callback of stateChanged: ${e}`);
                    }
                }
            }
        }
    }

    /**
     * Called internally.
     *
     * @param messageType The message type from the instance
     * @param sourceInstance The source instance
     * @param data The message data
     */
    private instanceMessage(messageType: string, sourceInstance: string, data: any): void {
        this._instanceSubscriptions[sourceInstance]?.forEach(sub => {
            if (sub.messageType === messageType) {
                const mayBePromise = sub.callback(data, sourceInstance, messageType);
                if (mayBePromise instanceof Promise) {
                    void mayBePromise.catch(e => console.error(`Cannot call instance message handler: ${e}`));
                }
            }
        });
    }

    /**
     * Called internally.
     *
     * @param id The ioBroker object ID of type 'meta'.
     * @param fileName - file name
     * @param size - size of the file
     */
    private fileChange(id: string, fileName: string, size: number | null): void {
        for (const sub of Object.values(this.filesSubscribes)) {
            if (sub.regId.test(id) && sub.regFilePattern.test(fileName)) {
                for (const cb of sub.cbs) {
                    try {
                        cb(id, fileName, size);
                    } catch (e) {
                        console.error(`Error by callback of fileChange: ${e}`);
                    }
                }
            }
        }
    }

    /**
     * Subscribe to changes of the files.
     *
     * @param id The ioBroker state ID for a "meta" object. Could be a pattern
     * @param filePattern Pattern or file name, like 'main/*' or 'main/visViews.json`
     * @param cb The callback.
     */
    async subscribeFiles(id: string, filePattern: string | string[], cb: FileChangeHandler): Promise<void> {
        if (typeof cb !== 'function') {
            throw new Error('The state change handler must be a function!');
        }

        let filePatterns: string[];
        if (Array.isArray(filePattern)) {
            filePatterns = filePattern;
        } else {
            filePatterns = [filePattern];
        }

        const toSubscribe = [];
        for (let f = 0; f < filePatterns.length; f++) {
            const pattern = filePatterns[f];
            const key = `${id}$%$${pattern}`;

            if (!this.filesSubscribes[key]) {
                this.filesSubscribes[key] = {
                    regId: new RegExp(pattern2RegEx(id)),
                    regFilePattern: new RegExp(pattern2RegEx(pattern)),
                    cbs: [cb],
                };
                toSubscribe.push(pattern);
            } else {
                !this.filesSubscribes[key].cbs.includes(cb) && this.filesSubscribes[key].cbs.push(cb);
            }
        }
        if (this.connected && toSubscribe.length) {
            this._socket.emit('subscribeFiles', id, toSubscribe);
        }

        return Promise.resolve();
    }

    /**
     * Unsubscribes the given callback from changes of files.
     *
     * @param id The ioBroker state ID.
     * @param filePattern Pattern or file name, like 'main/*' or 'main/visViews.json`
     * @param cb The callback.
     */
    unsubscribeFiles(id: string, filePattern: string | string[], cb?: FileChangeHandler): void {
        let filePatterns: string[];
        if (Array.isArray(filePattern)) {
            filePatterns = filePattern;
        } else {
            filePatterns = [filePattern];
        }
        const toUnsubscribe = [];
        for (let f = 0; f < filePatterns.length; f++) {
            const pattern = filePatterns[f];
            const key = `${id}$%$${pattern}`;
            if (this.filesSubscribes[key]) {
                const sub = this.filesSubscribes[key];
                if (cb) {
                    const pos = sub.cbs.indexOf(cb);
                    pos !== -1 && sub.cbs.splice(pos, 1);
                } else {
                    sub.cbs = [];
                }

                if (!sub.cbs?.length) {
                    delete this.filesSubscribes[key];
                    toUnsubscribe.push(pattern);
                }
            }
        }
        if (this.connected && toUnsubscribe.length) {
            this._socket.emit('unsubscribeFiles', id, toUnsubscribe);
        }
    }

    /** Requests data from the server or reads it from the cache */
    protected async request<T>({
        cacheKey,
        forceUpdate,
        commandTimeout,
        onTimeout,
        requireAdmin,
        requireFeatures,
        // requestName,
        executor,
    }: RequestOptions<T>): Promise<T> {
        // TODO: mention requestName in errors

        // If the command requires the admin adapter, enforce it
        if (requireAdmin && Connection.isWeb()) {
            return Promise.reject(new Error(ERRORS.NOT_ADMIN));
        }

        // Return the cached value if allowed
        if (cacheKey && !forceUpdate && cacheKey in this._promises) {
            return this._promises[cacheKey];
        }

        // Require the socket to be connected
        if (!this.connected) {
            return Promise.reject(new Error(ERRORS.NOT_CONNECTED));
        }

        // Check if all required features are supported
        if (requireFeatures?.length) {
            for (const feature of requireFeatures) {
                if (!(await this.checkFeatureSupported(feature))) {
                    throw new Error(ERRORS.NOT_SUPPORTED);
                }
            }
        }

        // eslint-disable-next-line no-async-promise-executor
        const promise = new Promise<T>(async (resolve, reject) => {
            const timeoutControl = {
                elapsed: false,
                clearTimeout: () => {
                    // no-op unless there is a timeout
                },
            };
            let timeout: ReturnType<typeof setTimeout> | undefined;
            if (commandTimeout !== false) {
                timeout = setTimeout(() => {
                    timeoutControl.elapsed = true;
                    // Let the caller know that the timeout elapsed
                    onTimeout?.();

                    // do not cache responses with timeout or no connection
                    if (cacheKey && this._promises[cacheKey] instanceof Promise) {
                        delete this._promises[cacheKey];
                    }
                    reject(new Error(ERRORS.TIMEOUT));
                }, commandTimeout ?? this.props.cmdTimeout);
                timeoutControl.clearTimeout = () => {
                    clearTimeout(timeout);
                };
            }
            // Call the actual function - awaiting it allows us to catch sync and async errors
            // no matter if the executor is async or not
            try {
                await executor(resolve, reject, timeoutControl);
            } catch (e) {
                // do not cache responses with timeout or no connection
                if (cacheKey && this._promises[cacheKey] instanceof Promise) {
                    delete this._promises[cacheKey];
                }
                reject(new Error(e.toString()));
            }
        });
        if (cacheKey) {
            this._promises[cacheKey] = promise;
        }
        return promise;
    }

    /**
     * Deletes cached promise.
     * So next time the information will be requested anew
     */
    resetCache(key: string, isAll?: boolean): void {
        if (isAll) {
            Object.keys(this._promises)
                .filter(k => k.startsWith(key))
                .forEach(k => {
                    delete this._promises[k];
                });
        } else {
            delete this._promises[key];
        }
    }

    /**
     * Gets all states.
     *
     * @param pattern Pattern of states or array of IDs
     */
    getStates(pattern?: string | string[]): Promise<Record<string, ioBroker.State>> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getStates', pattern, (err, res) => {
                    this.states = res ?? {};

                    // if (!disableProgressUpdate) {
                    // 	this.props.onProgress?.(PROGRESS.STATES_LOADED);
                    // }
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.states);
                    }
                });
            },
        });
    }

    /**
     * Gets the given state.
     *
     * @param id The state ID.
     */
    getState(id: string): Promise<ioBroker.State | null | undefined> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                if (id && id === this.ignoreState) {
                    resolve(this.simStates[id] || { val: null, ack: true });
                    return;
                }
                this._socket.emit('getState', id, (err, state) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(state);
                    }
                });
            },
        });
    }

    /**
     * Gets the given binary state Base64 encoded.
     *
     * @deprecated since js-controller 5.0. Use files instead.
     * @param id The state ID.
     */
    getBinaryState(id: string): Promise<string | undefined> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getBinaryState', id, (err, state) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(state);
                    }
                });
            },
        });
    }

    /**
     * Sets the given binary state.
     *
     * @deprecated since js-controller 5.0. Use files instead.
     * @param id The state ID.
     * @param base64 The Base64 encoded binary data.
     */
    setBinaryState(id: string, base64: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('setBinaryState', id, base64, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Sets the given state value.
     *
     * @param id The state ID.
     * @param val The state value.
     * @param ack Acknowledgement flag.
     */
    setState(
        id: string,
        val: ioBroker.State | ioBroker.StateValue | ioBroker.SettableState,
        ack?: boolean,
    ): Promise<void> {
        if (typeof ack === 'boolean') {
            val = { val: val as ioBroker.StateValue, ack };
        }

        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                // extra handling for "nothing_selected" state for vis
                if (id && id === this.ignoreState) {
                    let state: ioBroker.State;

                    if (typeof ack === 'boolean') {
                        state = val as ioBroker.State;
                    } else if (typeof val === 'object' && (val as ioBroker.State).val !== undefined) {
                        state = val as ioBroker.State;
                    } else {
                        state = {
                            val: val as ioBroker.StateValue,
                            ack: false,
                            ts: Date.now(),
                            lc: Date.now(),
                            from: 'system.adapter.vis.0',
                        };
                    }

                    this.simStates[id] = state;

                    // inform subscribers about changes
                    if (this.statesSubscribes[id]) {
                        for (const cb of this.statesSubscribes[id].cbs) {
                            try {
                                const mayBePromise = cb(id, state as any);
                                if (mayBePromise instanceof Promise) {
                                    void mayBePromise.catch(e =>
                                        console.error(`Cannot call state change handler: ${e}`),
                                    );
                                }
                            } catch (e) {
                                console.error(`Error by callback of stateChanged: ${e}`);
                            }
                        }
                    }
                    resolve();
                    return;
                }
                this._socket.emit('setState', id, val, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Gets all objects.
     *
     * @param update Callback that is executed when all objects are retrieved.
     */
    /**
     * Gets all objects.
     *
     * @param update Set to true to retrieve all objects from the server (instead of using the local cache).
     * @param disableProgressUpdate don't call onProgress() when done
     */
    getObjects(update?: boolean, disableProgressUpdate?: boolean): Promise<Record<string, ioBroker.Object>> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                if (!update && this.objects) {
                    resolve(this.objects);
                    return;
                }

                this._socket.emit(Connection.isWeb() ? 'getObjects' : 'getAllObjects', (err, res) => {
                    if (!disableProgressUpdate) {
                        this.props.onProgress?.(PROGRESS.OBJECTS_LOADED);
                    }
                    if (err) {
                        reject(err);
                    } else {
                        this.objects = res ?? {};
                        resolve(this.objects);
                    }
                });
            },
        });
    }

    /**
     * Gets the list of objects by ID.
     *
     * @param list array of IDs to retrieve
     */
    getObjectsById(list: string[]): Promise<Record<string, ioBroker.Object> | undefined> {
        return this.request({
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getObjects', list, (err, res) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(res);
                    }
                });
            },
        });
    }

    /**
     * Called internally.
     *
     * @param isEnable Set to true if subscribing, false to unsubscribe.
     */
    private _subscribe(isEnable: boolean): void {
        if (isEnable && !this.subscribed) {
            this.subscribed = true;
            if (this.props.autoSubscribes?.length) {
                this._socket.emit('subscribeObjects', this.props.autoSubscribes);
            }
            // re subscribe objects
            const ids = Object.keys(this.objectsSubscribes);
            if (ids.length) {
                this._socket.emit('subscribeObjects', ids);
            }
            Object.keys(this.objectsSubscribes).forEach(id => this._socket.emit('subscribeObjects', id));
            // re-subscribe logs
            this.props.autoSubscribeLog && this._socket.emit('requireLog', true);
            // re subscribe states
            Object.keys(this.statesSubscribes).forEach(id => this._socket.emit('subscribe', id));
            // re-subscribe files
            Object.keys(this.filesSubscribes).forEach(key => {
                const [id, filePattern] = key.split('$%$');
                this._socket.emit('subscribeFiles', id, filePattern);
            });
        } else if (!isEnable && this.subscribed) {
            this.subscribed = false;
            // un-subscribe objects
            if (this.props.autoSubscribes?.length) {
                this._socket.emit('unsubscribeObjects', this.props.autoSubscribes);
            }
            const ids = Object.keys(this.objectsSubscribes);
            if (ids.length) {
                this._socket.emit('unsubscribeObjects', ids);
            }
            // un-subscribe logs
            this.props.autoSubscribeLog && this._socket.emit('requireLog', false);

            // un-subscribe states
            Object.keys(this.statesSubscribes).forEach(id => this._socket.emit('unsubscribe', id));
            // re-subscribe files
            Object.keys(this.filesSubscribes).forEach(key => {
                const [id, filePattern] = key.split('$%$');
                this._socket.emit('unsubscribeFiles', id, filePattern);
            });
        }
    }

    /**
     * Requests log updates.
     *
     * @param isEnabled Set to true to get logs.
     */
    requireLog(isEnabled: boolean): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('requireLog', isEnabled, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Deletes the given object.
     *
     * @param id The object ID.
     * @param maintenance Force deletion of non conform IDs.
     */
    delObject(id: string, maintenance: boolean = false): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('delObject', id, { maintenance }, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Deletes the given object and all its children.
     *
     * @param id The object ID.
     * @param maintenance Force deletion of non conform IDs.
     */
    delObjects(id: string, maintenance: boolean): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('delObjects', id, { maintenance }, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Sets the object.
     *
     * @param id The object ID.
     * @param obj The object.
     */
    setObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
        if (!obj) {
            return Promise.reject(new Error('Null object is not allowed'));
        }

        obj = JSON.parse(JSON.stringify(obj));
        delete obj.from;
        delete obj.user;
        delete obj.ts;

        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('setObject', id, obj, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Gets the object with the given id from the server.
     *
     * @param id The object ID.
     * @returns The object.
     */
    getObject<T extends string>(id: T): ioBroker.GetObjectPromise<T> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                if (id && id === this.ignoreState) {
                    resolve({
                        _id: this.ignoreState,
                        type: 'state',
                        common: {
                            name: 'ignored state',
                            type: 'mixed',
                        },
                    } as any);
                    return;
                }
                this._socket.emit('getObject', id, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj as any);
                    }
                });
            },
        });
    }

    /**
     * Sends a message to a specific instance or all instances of some specific adapter.
     *
     * @param instance The instance to send this message to.
     * @param command Command name of the target instance.
     * @param data The message data to send.
     */
    sendTo<T = any>(instance: string, command: string, data?: any): Promise<T> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: resolve => {
                this._socket.emit('sendTo', instance, command, data, (result: any) => {
                    resolve(result);
                });
            },
        });
    }

    /**
     * Extend an object and create it if it might not exist.
     *
     * @param id The id.
     * @param obj The object.
     */
    extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
        if (!obj) {
            return Promise.reject(new Error('Null object is not allowed'));
        }

        obj = JSON.parse(JSON.stringify(obj));
        delete obj.from;
        delete obj.user;
        delete obj.ts;

        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('extendObject', id, obj, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Register a handler for log messages.
     *
     * @param handler The handler.
     */
    registerLogHandler(handler: (message: LogMessage) => void): void {
        if (!this.onLogHandlers.includes(handler)) {
            this.onLogHandlers.push(handler);
        }
    }

    /**
     * Unregister a handler for log messages.
     *
     * @param handler The handler.
     */
    unregisterLogHandler(handler: (message: LogMessage) => void): void {
        const pos = this.onLogHandlers.indexOf(handler);
        pos !== -1 && this.onLogHandlers.splice(pos, 1);
    }

    /**
     * Register a handler for the connection state.
     *
     * @param handler The handler.
     */
    registerConnectionHandler(handler: (connected: boolean) => void): void {
        if (!this.onConnectionHandlers.includes(handler)) {
            this.onConnectionHandlers.push(handler);
        }
    }

    /**
     * Unregister a handler for the connection state.
     *
     * @param handler The handler.
     */
    unregisterConnectionHandler(handler: (connected: boolean) => void): void {
        const pos = this.onConnectionHandlers.indexOf(handler);
        pos !== -1 && this.onConnectionHandlers.splice(pos, 1);
    }

    /**
     * Set the handler for standard output of a command.
     *
     * @param handler The handler.
     */
    registerCmdStdoutHandler(handler: (id: string, text: string) => void): void {
        this.onCmdStdoutHandler = handler;
    }

    /**
     * Unset the handler for standard output of a command.
     */
    unregisterCmdStdoutHandler(): void {
        this.onCmdStdoutHandler = undefined;
    }

    /**
     * Set the handler for standard error of a command.
     *
     * @param handler The handler.
     */
    registerCmdStderrHandler(handler: (id: string, text: string) => void): void {
        this.onCmdStderrHandler = handler;
    }

    /**
     * Unset the handler for standard error of a command.
     */
    unregisterCmdStderrHandler(): void {
        this.onCmdStderrHandler = undefined;
    }

    /**
     * Set the handler for exit of a command.
     *
     * @param handler The handler.
     */
    registerCmdExitHandler(handler: (id: string, exitCode: number) => void): void {
        this.onCmdExitHandler = handler;
    }

    /**
     * Unset the handler for exit of a command.
     */
    unregisterCmdExitHandler(): void {
        this.onCmdExitHandler = undefined;
    }

    /**
     * Get all enums with the given name.
     *
     * @param _enum The name of the enum, like `rooms` or `functions`
     * @param update Force update.
     */
    getEnums(_enum?: string, update?: boolean): Promise<Record<string, ioBroker.EnumObject>> {
        return this.request({
            cacheKey: `enums_${_enum || 'all'}`,
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit(
                    'getObjectView',
                    'system',
                    'enum',
                    {
                        startkey: `enum.${_enum || ''}`,
                        endkey: _enum ? `enum.${_enum}.\u9999` : `enum.\u9999`,
                    },
                    (err, res) => {
                        if (err) {
                            reject(err);
                        } else {
                            const _res: Record<string, ioBroker.EnumObject> = {};
                            if (res) {
                                for (let i = 0; i < res.rows.length; i++) {
                                    if (_enum && res.rows[i].id === `enum.${_enum}`) {
                                        continue;
                                    }
                                    _res[res.rows[i].id] = res.rows[i].value as ioBroker.EnumObject;
                                }
                            }
                            resolve(_res);
                        }
                    },
                );
            },
        });
    }

    /**
     * @deprecated since version 1.1.15, cause parameter order does not match backend
     * Query a predefined object view.
     * @param start The start ID.
     * @param end The end ID.
     * @param type The type of object.
     */
    getObjectView<T extends ioBroker.ObjectType>(
        start: string | undefined,
        end: string | undefined,
        type: T,
    ): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
        return this.getObjectViewCustom('system', type, start, end);
    }

    /**
     * Query a predefined object view.
     *
     * @param type The type of object.
     * @param start The start ID.
     * @param [end] The end ID.
     */
    getObjectViewSystem<T extends ioBroker.ObjectType>(
        type: T,
        start?: string,
        end?: string,
    ): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
        return this.getObjectViewCustom('system', type, start, end);
    }

    /**
     * Query a predefined object view.
     *
     * @param design design - 'system' or other designs like `custom`.
     * @param type The type of object.
     * @param start The start ID.
     * @param [end] The end ID.
     */
    getObjectViewCustom<T extends ioBroker.ObjectType>(
        design: string,
        type: T,
        start?: string,
        end?: string,
    ): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                start ||= '';
                end ||= '\u9999';

                this._socket.emit('getObjectView', design, type, { startkey: start, endkey: end }, (err, res) => {
                    if (err) {
                        reject(err);
                    } else {
                        const _res: Record<string, ioBroker.AnyObject & { type: T }> = {};
                        if (res && res.rows) {
                            for (let i = 0; i < res.rows.length; i++) {
                                _res[res.rows[i].id] = res.rows[i].value;
                            }
                        }
                        resolve(_res);
                    }
                });
            },
        });
    }

    /**
     * Read the meta items.
     */
    readMetaItems(): Promise<ioBroker.Object[]> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit(
                    'getObjectView',
                    'system',
                    'meta',
                    { startkey: '', endkey: '\u9999' },
                    (err, objs) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(objs!.rows?.map(obj => obj.value).filter((val): val is ioBroker.Object => !!val));
                        }
                    },
                );
            },
        });
    }

    /**
     * Read the directory of an adapter.
     *
     * @param namespace (this may be the adapter name, the instance name or the name of a storage object within the adapter).
     * @param path The directory name.
     */
    readDir(namespace: string | null, path: string): Promise<ioBroker.ReadDirResult[]> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('readDir', namespace, path, (err, files) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(files!);
                    }
                });
            },
        });
    }

    /**
     * Read a file of an adapter.
     *
     * @param namespace (this may be the adapter name, the instance name or the name of a storage object within the adapter).
     * @param fileName The file name.
     * @param base64 If it must be a base64 format
     */
    readFile(
        namespace: string | null,
        fileName: string,
        base64?: boolean,
    ): Promise<{ file: string; mimeType: string }> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit(base64 ? 'readFile64' : 'readFile', namespace, fileName, (err, data, type) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ file: data as string, mimeType: type! });
                    }
                });
            },
        });
    }

    /**
     * Write a file of an adapter.
     *
     * @param namespace (this may be the adapter name, the instance name or the name of a storage object within the adapter).
     * @param fileName The file name.
     * @param data The data (if it's a Buffer, it will be converted to Base64).
     */
    writeFile64(namespace: string, fileName: string, data: ArrayBuffer | string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                if (typeof data === 'string') {
                    this._socket.emit('writeFile', namespace, fileName, data, err => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                } else {
                    const base64 = btoa(
                        new Uint8Array(data).reduce((data, byte) => data + String.fromCharCode(byte), ''),
                    );

                    this._socket.emit('writeFile64', namespace, fileName, base64, err => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                }
            },
        });
    }

    /**
     * Delete a file of an adapter.
     *
     * @param namespace (this may be the adapter name, the instance name or the name of a storage object within the adapter).
     * @param fileName The file name.
     */
    deleteFile(namespace: string, fileName: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('deleteFile', namespace, fileName, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Delete a folder of an adapter.
     *
     * @param namespace (this may be the adapter name, the instance name or the name of a storage object within the adapter).
     * @param folderName The folder name.
     */
    deleteFolder(namespace: string, folderName: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('deleteFolder', namespace, folderName, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Rename file or folder in ioBroker DB
     *
     * @param namespace (this may be the adapter name, the instance name or the name of a storage object within the adapter).
     * @param oldName current file name, e.g., main/vis-views.json
     * @param newName new file name, e.g., main/vis-views-new.json
     */
    rename(namespace: string, oldName: string, newName: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('rename', namespace, oldName, newName, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Rename file in ioBroker DB
     *
     * @param namespace (this may be the adapter name, the instance name or the name of a storage object within the adapter).
     * @param oldName current file name, e.g., main/vis-views.json
     * @param newName new file name, e.g., main/vis-views-new.json
     */
    renameFile(namespace: string, oldName: string, newName: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('renameFile', namespace, oldName, newName, err => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Execute a command on a host.
     */
    cmdExec(
        /** Host name */
        host: string,
        /** Command to execute */
        cmd: string,
        /** Command ID */
        cmdId: number,
        /** Timeout of command in ms */
        cmdTimeout?: number,
    ): Promise<void> {
        return this.request({
            commandTimeout: cmdTimeout,
            executor: (resolve, reject, timeout) => {
                host = normalizeHostId(host);

                this._socket.emit('cmdExec', host, cmdId, cmd, err => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();

                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            },
        });
    }

    /**
     * Gets the system configuration.
     *
     * @param update Force update.
     */
    getSystemConfig(update?: boolean): Promise<ioBroker.SystemConfigObject> {
        return this.request({
            cacheKey: 'systemConfig',
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: async resolve => {
                let systemConfig = await this.getObject('system.config');
                (systemConfig as any) ??= {};
                (systemConfig as any).common ??= {};
                (systemConfig as any).native ??= {};

                resolve(systemConfig!);
            },
        });
    }

    // returns very optimized information for adapters to minimize a connection load
    getCompactSystemConfig(update?: boolean): Promise<ioBroker.SystemConfigObject> {
        return this.request({
            cacheKey: 'systemConfigCommon',
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            requireAdmin: true,
            executor: (resolve, reject) => {
                this._socket.emit('getCompactSystemConfig', (err, systemConfig) => {
                    if (err) {
                        reject(err);
                    } else {
                        (systemConfig as any) ??= {};
                        (systemConfig as any).common ??= {};
                        (systemConfig as any).native ??= {};
                        resolve(systemConfig!);
                    }
                });
            },
        });
    }

    /**
     * Read all states (which might not belong to this adapter) which match the given pattern.
     *
     * @param pattern The pattern to match.
     */
    getForeignStates(pattern?: string | string[] | null): ioBroker.GetStatesPromise {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getForeignStates', pattern || '*', (err, states) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(states ?? {});
                    }
                });
            },
        });
    }

    /**
     * Get foreign objects by pattern, by specific type and resolve their enums.
     *
     * @param pattern The pattern to match.
     * @param type The type of the object.
     */
    getForeignObjects<T extends ioBroker.ObjectType>(
        pattern: string | null | undefined,
        type: T,
    ): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getForeignObjects', pattern || '*', type, (err, objects) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(objects as any);
                    }
                });
            },
        });
    }

    /**
     * Sets the system configuration.
     *
     * @param obj The new system configuration.
     */
    setSystemConfig(obj: ioBroker.SystemConfigObject): Promise<void> {
        return this.setObject('system.config', obj);
    }

    /**
     * Get the raw socket.io socket.
     */
    getRawSocket(): any {
        return this._socket;
    }

    /**
     * Get the history of a given state.
     *
     * @param id The state ID.
     * @param options The query options.
     */
    getHistory(id: string, options: ioBroker.GetHistoryOptions): Promise<ioBroker.GetHistoryResult> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getHistory', id, options, (err, values) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(values!);
                    }
                });
            },
        });
    }

    /**
     * Get the history of a given state.
     *
     * @param id The state ID.
     * @param options The query options.
     */
    getHistoryEx(
        id: string,
        options: ioBroker.GetHistoryOptions,
    ): Promise<{
        values: ioBroker.GetHistoryResult;
        sessionId: number;
        step: number;
    }> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getHistory', id, options, (err, values, step, sessionId) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({
                            values: values!,
                            sessionId: sessionId!,
                            step: step!,
                        });
                    }
                });
            },
        });
    }

    /**
     * Get the IP addresses of the given host.
     *
     * @param host The host name.
     * @param update Force update.
     */
    getIpAddresses(host: string, update?: boolean): Promise<string[]> {
        host = normalizeHostId(host);
        return this.request({
            cacheKey: `IPs_${host}`,
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: async resolve => {
                const obj = await this.getObject(host);
                resolve(obj?.common.address ?? []);
            },
        });
    }

    /**
     * Gets the version.
     */
    getVersion(update?: boolean): Promise<{ version: string; serverName: string }> {
        return this.request({
            cacheKey: 'version',
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getVersion', (err, version, serverName) => {
                    // Old socket.io had no error parameter
                    if (err && !version && typeof err === 'string' && err.match(/\d+\.\d+\.\d+/)) {
                        resolve({ version: err, serverName: 'socketio' });
                    } else {
                        if (err) {
                            reject(err);
                        } else {
                            resolve({
                                version: version!,
                                serverName: serverName!,
                            });
                        }
                    }
                });
            },
        });
    }

    /**
     * Gets the web server name.
     */
    getWebServerName(): Promise<string> {
        return this.request({
            cacheKey: 'webName',
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('getAdapterName', (err, name) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(name!);
                    }
                });
            },
        });
    }

    /**
     * Check if the file exists
     *
     * @param adapter adapter name
     * @param filename file name with the full path. it could be like vis.0/*
     */
    fileExists(adapter: string, filename: string): Promise<boolean> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('fileExists', adapter, filename, (err, exists) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(!!exists);
                    }
                });
            },
        });
    }

    /**
     * Read current user
     */
    getCurrentUser(): Promise<string> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: resolve => {
                this._socket.emit('authEnabled', (_isSecure, user) => {
                    resolve(user);
                });
            },
        });
    }

    /**
     * Get uuid
     */
    getUuid(): Promise<string> {
        return this.request({
            cacheKey: 'uuid',
            // TODO: check if this should time out
            commandTimeout: false,
            executor: async resolve => {
                const obj = await this.getObject('system.meta.uuid');
                resolve(obj?.native?.uuid);
            },
        });
    }

    /**
     * Checks if a given feature is supported.
     *
     * @param feature The feature to check.
     * @param update Force update.
     */
    checkFeatureSupported(feature: string, update?: boolean): Promise<any> {
        return this.request({
            cacheKey: `supportedFeatures_${feature}`,
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('checkFeatureSupported', feature, (err, features) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(features);
                    }
                });
            },
        });
    }

    /**
     * Get all adapter instances.
     *
     * @param update Force update.
     */
    /**
     * Get all instances of the given adapter.
     *
     * @param adapter The name of the adapter.
     * @param update Force update.
     */
    getAdapterInstances(adapter?: string | boolean, update?: boolean): Promise<ioBroker.InstanceObject[]> {
        if (typeof adapter === 'boolean') {
            update = adapter;
            adapter = '';
        }
        adapter ||= '';

        return this.request({
            cacheKey: `instances_${adapter}`,
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: async resolve => {
                const startKey = adapter ? `system.adapter.${adapter}.` : 'system.adapter.';
                const endKey = `${startKey}\u9999`;

                const instances = await this.getObjectViewSystem('instance', startKey, endKey);
                const instanceObjects = Object.values(instances);
                if (adapter) {
                    resolve(instanceObjects.filter(o => o.common.name === adapter));
                } else {
                    resolve(instanceObjects);
                }
            },
        });
    }

    /**
     * Get adapters with the given name.
     *
     * @param adapter The name of the adapter.
     * @param update Force update.
     */
    getAdapters(adapter?: string, update?: boolean): Promise<ioBroker.AdapterObject[]> {
        if (typeof adapter === 'boolean') {
            update = adapter;
            adapter = '';
        }
        adapter ||= '';

        return this.request({
            cacheKey: `adapter_${adapter}`,
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: async resolve => {
                const adapters = await this.getObjectViewSystem(
                    'adapter',
                    `system.adapter.${adapter || ''}`,
                    `system.adapter.${adapter || '\u9999'}`,
                );
                const adapterObjects = Object.values(adapters);
                if (adapter) {
                    resolve(adapterObjects.filter(o => o.common.name === adapter));
                } else {
                    resolve(adapterObjects);
                }
            },
        });
    }

    /**
     * Get the list of all groups.
     *
     * @param update Force update.
     */
    getGroups(update?: boolean): Promise<ioBroker.GroupObject[]> {
        return this.request({
            cacheKey: 'groups',
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit(
                    'getObjectView',
                    'system',
                    'group',
                    {
                        startkey: 'system.group.',
                        endkey: 'system.group.\u9999',
                    },
                    (err, doc) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(getObjectViewResultToArray<ioBroker.GroupObject>(doc));
                        }
                    },
                );
            },
        });
    }

    /**
     * Logout current user
     */
    logout(): Promise<string | null> {
        return this.request({
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('logout', err => {
                    err ? reject(err) : resolve(null);
                });
            },
        });
    }

    /**
     * Subscribe on instance message
     *
     * @param targetInstance instance, like 'cameras.0'
     * @param messageType message type like 'startCamera/cam3'
     * @param data optional data object
     * @param callback message handler
     */
    subscribeOnInstance(
        targetInstance: string,
        messageType: string,
        data: any,
        callback: InstanceMessageCallback,
    ): Promise<{
        error?: string;
        accepted?: boolean;
        heartbeat?: number;
    } | null> {
        return this.request({
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('clientSubscribe', targetInstance, messageType, data, (err, subscribeResult) => {
                    if (err) {
                        reject(err);
                    } else if (subscribeResult) {
                        if (subscribeResult.error) {
                            reject(subscribeResult.error);
                        } else {
                            if (!targetInstance.startsWith('system.adapter.')) {
                                targetInstance = `system.adapter.${targetInstance}`;
                            }
                            // save callback
                            this._instanceSubscriptions[targetInstance] =
                                this._instanceSubscriptions[targetInstance] || [];

                            if (
                                !this._instanceSubscriptions[targetInstance].find(
                                    subscription =>
                                        subscription.messageType === messageType && subscription.callback === callback,
                                )
                            ) {
                                this._instanceSubscriptions[targetInstance].push({
                                    messageType,
                                    callback,
                                });
                            }
                            resolve(subscribeResult);
                        }
                    }
                });
            },
        });
    }

    /**
     * Unsubscribe from instance message
     *
     * @param targetInstance instance, like 'cameras.0'
     * @param messageType message type like 'startCamera/cam3'
     * @param callback message handler
     */
    unsubscribeFromInstance(
        targetInstance: string,
        messageType: string,
        callback: InstanceMessageCallback,
    ): Promise<boolean> {
        if (!targetInstance.startsWith('system.adapter.')) {
            targetInstance = `system.adapter.${targetInstance}`;
        }

        let deleted;
        const promiseResults = [];
        do {
            deleted = false;
            const index = this._instanceSubscriptions[targetInstance]?.findIndex(
                sub => (!messageType || sub.messageType === messageType) && (!callback || sub.callback === callback),
            );

            if (index !== undefined && index !== null && index !== -1) {
                deleted = true;
                // remember messageType
                const _messageType = this._instanceSubscriptions[targetInstance][index].messageType;

                this._instanceSubscriptions[targetInstance].splice(index, 1);
                if (!this._instanceSubscriptions[targetInstance].length) {
                    delete this._instanceSubscriptions[targetInstance];
                }

                // try to find another subscription for this instance and messageType
                const found =
                    this._instanceSubscriptions[targetInstance] &&
                    this._instanceSubscriptions[targetInstance].find(sub => sub.messageType === _messageType);

                if (!found) {
                    promiseResults.push(
                        this.request({
                            commandTimeout: false,
                            executor: (resolve, reject) => {
                                this._socket.emit(
                                    'clientUnsubscribe',
                                    targetInstance,
                                    messageType,
                                    (err, wasSubscribed) => (err ? reject(err) : resolve(wasSubscribed)),
                                );
                            },
                        }),
                    );
                }
            }
        } while (deleted && (!callback || !messageType));

        if (promiseResults.length) {
            return Promise.all(promiseResults).then(results => !!results.find(result => result));
        }

        return Promise.resolve(false);
    }

    /**
     * Send log to ioBroker log
     *
     * @param text Log text
     * @param level `info`, `debug`, `warn`, `error` or `silly`
     */
    log(text: string, level?: string): Promise<null> {
        return text
            ? this.request({
                  commandTimeout: false,
                  executor: resolve => {
                      this._socket.emit('log', text, level);
                      return resolve(null);
                  },
              })
            : Promise.resolve(null);
    }

    /**
     * This is a special method for vis.
     * It is used to not send to server the changes about "nothing_selected" state
     *
     * @param id The state that has to be ignored by communication
     */
    setStateToIgnore(id: string): void {
        this.ignoreState = id;
    }
}
