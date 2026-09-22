import assert from 'node:assert/strict';

import type { Connection } from '../../src/Connection.js';
import type { ConnectionProps } from '../../src/ConnectionProps.js';
import { FakeSocket } from './FakeSocket.js';

export const SYSTEM_CONFIG = {
    _id: 'system.config',
    type: 'config',
    common: { language: 'de', defaultHistory: 'history.0' },
    native: {},
} as unknown as ioBroker.SystemConfigObject;

/** Lets all pending promise callbacks run. setImmediate is not faked by `mock.timers.enable({ apis: ['setTimeout'] })` */
export function flush(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

export interface Tracked<T> {
    settled: boolean;
    value?: T;
    error?: unknown;
}

/** Records when the promise settles, so a test can check that it has not */
export function track<T>(promise: Promise<T>): Tracked<T> {
    const state: Tracked<T> = { settled: false };
    promise.then(
        value => {
            state.settled = true;
            state.value = value;
        },
        (error: unknown) => {
            state.settled = true;
            state.error = error;
        },
    );
    return state;
}

/** Storage like in the browser, but in memory */
export class MemoryStorage {
    private readonly items = new Map<string, string>();

    get length(): number {
        return this.items.size;
    }

    getItem(key: string): string | null {
        return this.items.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.items.set(key, String(value));
    }

    removeItem(key: string): void {
        this.items.delete(key);
    }

    clear(): void {
        this.items.clear();
    }

    key(index: number): string | null {
        return [...this.items.keys()][index] ?? null;
    }
}

/**
 * Sets the browser globals the connection uses to a known state: a location of "http://localhost:8081/",
 * separate empty localStorage and sessionStorage and no socketUrl, socketPath or socket library.
 * The stubs of Connection.ts share one storage for both, so the tests could not tell them apart.
 */
export function resetGlobals(): void {
    const g = globalThis as any;
    g.location = {
        href: 'http://localhost:8081/',
        protocol: 'http:',
        host: 'localhost:8081',
        hostname: 'localhost',
        port: '8081',
        pathname: '/',
        search: '',
        hash: '',
        reload: () => {},
    };
    g.localStorage = new MemoryStorage();
    g.sessionStorage = new MemoryStorage();
    delete g.socketUrl;
    delete g.socketPath;
    delete g.socketForceWebSockets;
    delete g.io;
    delete g.iob;
    delete g.registerSocketOnLoad;
    delete g.vendorPrefix;
}

/** Changes some fields of the location stub. Call `resetGlobals` before */
export function setLocation(location: Partial<Location>): void {
    Object.assign((globalThis as any).location, location);
}

/** Connection or AdminConnection. The latter declares all props as required, but they get defaults like in Connection */
type ConnectionClass<C> = new (props: ConnectionProps) => C;

/**
 * Creates the connection with a fake socket. The socket is not yet connected, see `login`.
 */
export async function createConnection<C extends Connection<any, any>>(
    Class: ConnectionClass<C>,
    props: Partial<ConnectionProps> = {},
): Promise<{ conn: C; socket: FakeSocket }> {
    const socket = new FakeSocket();
    const conn = new Class({
        name: 'test',
        connect: (url: string, options: any) => {
            socket.url = url;
            socket.options = options;
            return socket;
        },
        ...props,
    } as ConnectionProps);
    // The socket is created after the socket library was "loaded"
    await flush();
    return { conn, socket };
}

/**
 * Lets the socket connect like the ws client of ioBroker does (connect → authenticate) and waits until the
 * connection has loaded the system config and called onReady.
 * Answers "authenticate" and "getObject" for "system.config", unless the test already set responders for them.
 */
export async function login(
    conn: Connection<any, any>,
    socket: FakeSocket,
    options: { isSecure?: boolean; systemConfig?: ioBroker.SystemConfigObject } = {},
): Promise<void> {
    const systemConfig = options.systemConfig ?? SYSTEM_CONFIG;
    socket.responders.authenticate ??= () => [true, options.isSecure ?? false];
    socket.responders.getObject ??= (id: string) => (id === 'system.config' ? [null, systemConfig] : [null, null]);

    socket.fire('connect', true);
    for (let i = 0; i < 20 && !conn.onReadyDone; i++) {
        await flush();
    }
    assert.ok(conn.onReadyDone, 'The connection did not get ready');
}

/** Creates the connection and logs in. See `createConnection` and `login` */
export async function createLoggedInConnection<C extends Connection<any, any>>(
    Class: ConnectionClass<C>,
    props: Partial<ConnectionProps> = {},
): Promise<{ conn: C; socket: FakeSocket }> {
    const result = await createConnection(Class, props);
    await login(result.conn, result.socket);
    return result;
}
