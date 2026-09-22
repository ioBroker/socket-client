import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type Mock } from 'node:test';

import { Connection, ERRORS, type OAuth2Response } from '../src/Connection.js';
import type { ConnectionProps } from '../src/ConnectionProps.js';
import type { FakeSocket } from './lib/FakeSocket.js';
import { createConnection, flush, login, resetGlobals, setLocation } from './lib/helpers.js';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const HOUR = 3_600_000;
const LOCK = 'iob_token_semaphore';
const LOGIN_PAGE = 'http://localhost:8081/?login&href=';
const START_PAGE = 'http://localhost:8081/';

type StorageName = 'local' | 'session';

interface TokenOptions {
    refresh?: string;
    /** Milliseconds from now until the refresh token expires */
    refreshIn?: number;
    access?: string;
    /** Milliseconds from now until the access token expires */
    accessIn?: number;
    owner?: string;
}

interface FetchCall {
    url: string;
    init?: RequestInit;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
}

type StorageListener = (event: StorageEvent) => void;

let conn: Connection;
let socket: FakeSocket;
let fetches: FetchCall[];
let reload: Mock<() => void>;
let storageListeners: Set<StorageListener>;
let addEventListener: Mock<(type: string, listener: StorageListener) => void>;
let removeEventListener: Mock<(type: string, listener: StorageListener) => void>;

function storage(name: StorageName): Storage {
    return name === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
}

function iso(inMs: number): string {
    return new Date(Date.now() + inMs).toISOString();
}

/** The format of "iob_tokens": `refresh;refreshExpires;access;accessExpires[;owner]` */
function tokenString(options: TokenOptions = {}): string {
    const parts = [
        options.refresh ?? 'refresh-1',
        iso(options.refreshIn ?? 24 * HOUR),
        options.access ?? 'access-1',
        iso(options.accessIn ?? HOUR),
    ];
    if (options.owner) {
        parts.push(options.owner);
    }
    return parts.join(';');
}

function storeTokens(name: StorageName, options: TokenOptions = {}): void {
    storage(name).setItem('iob_tokens', tokenString(options));
}

function storedTokens(name: StorageName): string | null {
    return storage(name).getItem('iob_tokens');
}

function setLock(lock: unknown): void {
    globalThis.localStorage.setItem(LOCK, typeof lock === 'string' ? lock : JSON.stringify(lock));
}

function readLock(): unknown {
    const lock = globalThis.localStorage.getItem(LOCK);
    return lock === null ? null : JSON.parse(lock);
}

function oauthResponse(n: number): OAuth2Response {
    return {
        access_token: `access-${n}`,
        refresh_token: `refresh-${n}`,
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        token_type: 'Bearer',
    };
}

/** Lets the promise chain of the token request run through */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await flush();
    }
}

function lastFetch(): FetchCall {
    assert.ok(fetches.length, 'No token was requested');
    return fetches[fetches.length - 1];
}

/** The form data of the last token request */
function lastBody(): string {
    return lastFetch().init?.body as string;
}

/** Answers the last request to ./oauth/token like the web server */
async function answerFetch(status: number, body: unknown = {}): Promise<void> {
    lastFetch().resolve(new Response(JSON.stringify(body), { status }));
    await settle();
}

async function failFetch(): Promise<void> {
    lastFetch().reject(new TypeError('Failed to fetch'));
    await settle();
}

/** mock.timers.tick() moves the clock to the end before it runs the due timers, so a repeated timer needs a tick per period */
function tickTimes(times: number, ms: number): void {
    for (let i = 0; i < times; i++) {
        mock.timers.tick(ms);
    }
}

/** The browser tells the tab that the storage changed */
function fireStorage(key = 'iob_tokens'): void {
    storageListeners.forEach(listener => listener({ key } as StorageEvent));
}

/** Another tab stores new tokens in localStorage and the browser tells this tab */
function otherTabStores(options: TokenOptions = {}): void {
    storeTokens('local', { refresh: 'refresh-2', access: 'access-2', owner: 'other-tab', ...options });
    fireStorage();
}

/** The access tokens this connection announced to the server */
function announced(): string[] {
    return socket.requestsOf('updateTokenExpiration').map(request => request.args[0]);
}

/** The server answers the last `updateTokenExpiration` */
function answerAnnouncement(error: string | null, success?: boolean): void {
    socket.lastAnswer('updateTokenExpiration')(error, success);
}

/**
 * Creates the connection, stores the tokens and logs in with authentication enabled.
 * The tokens belong to the connection unless another owner is given.
 */
async function loginWithTokens(
    options: TokenOptions & { storage?: StorageName } = {},
    props: Partial<ConnectionProps> = {},
): Promise<void> {
    ({ conn, socket } = await createConnection(Connection, props));
    storeTokens(options.storage ?? 'local', { owner: conn.connId, ...options });
    await login(conn, socket, { isSecure: true });
}

/** Registers the hooks every test of this file needs */
function useEnvironment(): void {
    beforeEach(() => {
        resetGlobals();
        mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
        mock.method(console, 'log', () => {});
        mock.method(console, 'warn', () => {});
        mock.method(console, 'error', () => {});
        reload = mock.fn<() => void>();
        setLocation({ reload });
        fetches = [];
        mock.method(
            globalThis,
            'fetch',
            (url: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((resolve, reject) => fetches.push({ url: url as string, init, resolve, reject })),
        );
        storageListeners = new Set();
        addEventListener = mock.fn((type: string, listener: StorageListener) => {
            if (type === 'storage') {
                storageListeners.add(listener);
            }
        });
        removeEventListener = mock.fn((type: string, listener: StorageListener) => {
            if (type === 'storage') {
                storageListeners.delete(listener);
            }
        });
        Object.assign(globalThis, { addEventListener, removeEventListener });
    });

    afterEach(() => {
        conn?.destroy();
        mock.timers.reset();
        mock.restoreAll();
        delete (globalThis as any).addEventListener;
        delete (globalThis as any).removeEventListener;
    });
}

describe('Connection.readTokens', () => {
    useEnvironment();

    it('returns null without tokens', () => {
        assert.equal(Connection.readTokens(), null);
    });

    it('reads the tokens of localStorage as "stay logged in"', () => {
        storeTokens('local', { owner: 'tab-1' });

        assert.deepEqual(Connection.readTokens(), {
            refresh_token: 'refresh-1',
            refresh_token_expires_in: new Date(NOW + 24 * HOUR),
            access_token: 'access-1',
            expires_in: new Date(NOW + HOUR),
            owner: 'tab-1',
            stayLoggedIn: true,
        });
    });

    it('reads the tokens of sessionStorage as not "stay logged in"', () => {
        storeTokens('session', { owner: 'tab-1' });

        const tokens = Connection.readTokens();
        assert.equal(tokens?.access_token, 'access-1');
        assert.equal(tokens?.stayLoggedIn, false);
    });

    it('prefers the tokens of sessionStorage', () => {
        storeTokens('local', { access: 'local-access' });
        storeTokens('session', { access: 'session-access' });

        const tokens = Connection.readTokens();
        assert.equal(tokens?.access_token, 'session-access');
        assert.equal(tokens?.stayLoggedIn, false);
    });

    it('has no owner for tokens stored without one', () => {
        storeTokens('local');

        assert.equal(Connection.readTokens()?.owner, undefined);
    });

    it('returns null when the refresh token has expired', () => {
        storeTokens('local', { refreshIn: -1 });

        assert.equal(Connection.readTokens(), null);
    });

    it('returns the tokens when only the access token has expired', () => {
        storeTokens('local', { accessIn: -HOUR });

        assert.equal(Connection.readTokens()?.access_token, 'access-1');
    });

    it('returns null for a malformed token string', () => {
        globalThis.localStorage.setItem('iob_tokens', 'garbage');

        // not assert.equal: the reporter cannot print an Invalid Date
        assert.ok(Connection.readTokens() === null, 'The malformed tokens were read');
    });
});

describe('Connection.saveTokensStatic', () => {
    useEnvironment();

    it('stores the tokens with their expiry times in localStorage to stay logged in', () => {
        Connection.saveTokensStatic(oauthResponse(1), true);

        assert.equal(storedTokens('local'), 'refresh-1;2026-09-23T12:00:00.000Z;access-1;2026-09-22T13:00:00.000Z');
        assert.equal(storedTokens('session'), null);
    });

    it('stores the tokens in sessionStorage otherwise and appends the owner', () => {
        Connection.saveTokensStatic(oauthResponse(1), false, 'tab-1');

        assert.equal(
            storedTokens('session'),
            'refresh-1;2026-09-23T12:00:00.000Z;access-1;2026-09-22T13:00:00.000Z;tab-1',
        );
        assert.equal(storedTokens('local'), null);
    });

    it('stores tokens that readTokens reads back', () => {
        Connection.saveTokensStatic(oauthResponse(1), true, 'tab-1');

        assert.deepEqual(Connection.readTokens(), {
            refresh_token: 'refresh-1',
            refresh_token_expires_in: new Date(NOW + 24 * HOUR),
            access_token: 'access-1',
            expires_in: new Date(NOW + HOUR),
            owner: 'tab-1',
            stayLoggedIn: true,
        });
    });

    it('stores the connection as owner with saveTokens', async () => {
        ({ conn } = await createConnection(Connection));

        conn.saveTokens(oauthResponse(1), false);

        assert.equal(Connection.readTokens()?.owner, conn.connId);
        assert.equal(Connection.readTokens()?.stayLoggedIn, false);
    });
});

describe('Connection.deleteTokens', () => {
    useEnvironment();

    beforeEach(async () => {
        ({ conn } = await createConnection(Connection));
    });

    it('removes the tokens of both storages with deleteTokensStatic', () => {
        storeTokens('local');
        storeTokens('session');

        Connection.deleteTokensStatic();

        assert.equal(storedTokens('local'), null);
        assert.equal(storedTokens('session'), null);
    });

    it('removes only the tokens of localStorage with deleteStoredTokens(true), whoever owns them', () => {
        storeTokens('local', { owner: 'other-tab' });
        storeTokens('session', { owner: 'other-tab' });

        Connection.deleteStoredTokens(true);

        assert.equal(storedTokens('local'), null);
        assert.notEqual(storedTokens('session'), null);
    });

    it('removes only the tokens of sessionStorage with deleteStoredTokens(false)', () => {
        storeTokens('local', { owner: 'other-tab' });
        storeTokens('session', { owner: 'other-tab' });

        Connection.deleteStoredTokens(false);

        assert.notEqual(storedTokens('local'), null);
        assert.equal(storedTokens('session'), null);
    });

    it('removes its own tokens of localStorage', () => {
        storeTokens('local', { owner: conn.connId });

        conn.deleteTokens(true);

        assert.equal(storedTokens('local'), null);
    });

    it('removes its own tokens of sessionStorage', () => {
        storeTokens('session', { owner: conn.connId });

        conn.deleteTokens(false);

        assert.equal(storedTokens('session'), null);
    });

    it('keeps the tokens of another connection', () => {
        storeTokens('local', { owner: 'other-tab' });

        conn.deleteTokens(true);

        assert.notEqual(storedTokens('local'), null);
    });

    it('keeps its own tokens when they are in the other storage', () => {
        storeTokens('local', { owner: conn.connId });

        conn.deleteTokens(false);

        assert.notEqual(storedTokens('local'), null);
    });

    it('removes the tokens of both storages on logout, whoever owns them', () => {
        storeTokens('local', { owner: 'other-tab' });
        storeTokens('session', { owner: 'other-tab' });

        conn.deleteTokens(true, true);

        assert.equal(storedTokens('local'), null);
        assert.equal(storedTokens('session'), null);
    });
});

describe('Connection.connect', () => {
    useEnvironment();

    it('takes the ownership of tokens without owner', async () => {
        const tokens = tokenString();
        storeTokens('local');
        ({ conn, socket } = await createConnection(Connection));
        mock.timers.tick(1000);

        socket.fire('connect', true);

        assert.equal(storedTokens('local'), `${tokens};${conn.connId}`);
    });

    it('keeps tokens without owner in sessionStorage', async () => {
        const tokens = tokenString();
        storeTokens('session');
        ({ conn, socket } = await createConnection(Connection));

        socket.fire('connect', true);

        assert.equal(storedTokens('session'), `${tokens};${conn.connId}`);
        assert.equal(storedTokens('local'), null);
    });

    it('does not take the tokens of another connection', async () => {
        storeTokens('local', { owner: 'other-tab' });
        const tokens = storedTokens('local');
        ({ conn, socket } = await createConnection(Connection));

        socket.fire('connect', true);

        assert.equal(storedTokens('local'), tokens);
    });

    it('listens to the token changes of other tabs', async () => {
        ({ conn, socket } = await createConnection(Connection));
        assert.equal(storageListeners.size, 0);

        socket.fire('connect', true);

        assert.equal(storageListeners.size, 1);
    });
});

describe('Connection.acquireTokenLock', () => {
    useEnvironment();

    beforeEach(async () => {
        ({ conn } = await createConnection(Connection));
    });

    it('acquires a free lock for 10 seconds', () => {
        assert.equal(conn.acquireTokenLock(), true);

        assert.deepEqual(readLock(), { connId: conn.connId, expiry: NOW + 10_000 });
    });

    it('does not acquire the valid lock of another tab', () => {
        setLock({ connId: 'other-tab', expiry: NOW + 1 });

        assert.equal(conn.acquireTokenLock(), false);
        assert.deepEqual(readLock(), { connId: 'other-tab', expiry: NOW + 1 });
    });

    it('takes over an expired lock', () => {
        setLock({ connId: 'other-tab', expiry: NOW + 10_000 });
        mock.timers.tick(10_000);

        assert.equal(conn.acquireTokenLock(), true);
        assert.deepEqual(readLock(), { connId: conn.connId, expiry: NOW + 20_000 });
    });

    it('does not acquire its own lock a second time', () => {
        conn.acquireTokenLock();

        assert.equal(conn.acquireTokenLock(), false);
    });

    it('overwrites a broken lock', () => {
        setLock('{broken');

        assert.equal(conn.acquireTokenLock(), true);
        assert.deepEqual(readLock(), { connId: conn.connId, expiry: NOW + 10_000 });
    });

    it('releases its own lock', () => {
        conn.acquireTokenLock();

        conn.releaseTokenLock();

        assert.equal(readLock(), null);
    });

    it('does not release the lock of another tab', () => {
        setLock({ connId: 'other-tab', expiry: NOW + 10_000 });

        conn.releaseTokenLock();

        assert.deepEqual(readLock(), { connId: 'other-tab', expiry: NOW + 10_000 });
    });

    it('removes a broken lock on release', () => {
        setLock('{broken');

        conn.releaseTokenLock();

        assert.equal(readLock(), null);
    });
});

describe('Connection.checkAccessTokenExpire', () => {
    useEnvironment();

    it('refreshes the token 30 seconds before it expires', async () => {
        await loginWithTokens({ accessIn: 100_000 });

        mock.timers.tick(69_999);
        assert.equal(fetches.length, 0);
        // Like in a browser the timer runs a bit late: exactly 30 s before the expiry the check only reschedules itself
        mock.timers.tick(2);
        assert.equal(fetches.length, 1);
    });

    it('checks again after 120 seconds at the latest', async () => {
        await loginWithTokens({ accessIn: HOUR });
        storeTokens('local', { owner: conn.connId, accessIn: 130_000 });

        mock.timers.tick(119_999);
        assert.equal(fetches.length, 0);
        mock.timers.tick(1);
        assert.equal(fetches.length, 1);
    });

    it('refreshes at once a token that expires within 30 seconds', async () => {
        await loginWithTokens({ accessIn: 20_000 });

        assert.equal(fetches.length, 1);
    });

    it('does not check the tokens without authentication', async () => {
        ({ conn, socket } = await createConnection(Connection));
        storeTokens('local', { accessIn: 20_000 });
        await login(conn, socket);

        mock.timers.tick(60_000);

        assert.equal(fetches.length, 0);
        assert.deepEqual(announced(), []);
        assert.equal(reload.mock.callCount(), 0);
    });

    it('announces the expiring token of another tab and leaves the refresh to its owner', async () => {
        await loginWithTokens({ accessIn: 20_000, owner: 'other-tab' });

        assert.deepEqual(announced(), ['access-1']);
        tickTimes(4, 3_000);
        assert.equal(fetches.length, 0);
        assert.deepEqual(announced(), ['access-1']);
    });

    it('takes over the refresh 5.5 seconds before the expiry when the owner does not refresh', async () => {
        await loginWithTokens({ accessIn: 20_000, owner: 'other-tab' });

        // checks every 3 seconds: at 12 s 8 s are left, at 15 s only 5 s
        tickTimes(4, 3_000);
        mock.timers.tick(2_999);
        assert.equal(fetches.length, 0);
        mock.timers.tick(1);
        assert.equal(fetches.length, 1);

        await answerFetch(200, oauthResponse(2));
        assert.equal(Connection.readTokens()?.owner, conn.connId);
        assert.deepEqual(announced(), ['access-1', 'access-2']);
    });

    it('does not refresh when the owner renewed the token in time', async () => {
        await loginWithTokens({ accessIn: 20_000, owner: 'other-tab' });
        mock.timers.tick(3_000);

        otherTabStores({ accessIn: HOUR });
        tickTimes(20, 3_000);

        assert.equal(fetches.length, 0);
        assert.deepEqual(announced(), ['access-1', 'access-2']);
    });

    it('reloads the page when the token expires and there is no refresh token', async () => {
        await loginWithTokens({ refresh: '', accessIn: 20_000 });

        mock.timers.tick(19_999);
        assert.equal(reload.mock.callCount(), 0);
        mock.timers.tick(1);
        assert.equal(reload.mock.callCount(), 1);
        assert.equal(fetches.length, 0);
    });

    it('reloads the page after 500 ms when the token without refresh token has already expired', async () => {
        await loginWithTokens({ refresh: '', accessIn: -1_000 });

        mock.timers.tick(499);
        assert.equal(reload.mock.callCount(), 0);
        mock.timers.tick(1);
        assert.equal(reload.mock.callCount(), 1);
    });

    it('asks the tokenTimeoutHandler before it refreshes the token', async () => {
        const tokenTimeoutHandler = mock.fn((_expires: number) => Promise.resolve(true));

        await loginWithTokens({ accessIn: 20_000 }, { tokenTimeoutHandler });

        assert.deepEqual(tokenTimeoutHandler.mock.calls[0].arguments, [NOW + 20_000]);
        assert.equal(fetches.length, 1);
    });

    it('reloads the page at the expiry when the tokenTimeoutHandler does not prolong the token', async () => {
        const tokenTimeoutHandler = mock.fn((_expires: number) => Promise.resolve(false));

        await loginWithTokens({ accessIn: 20_000 }, { tokenTimeoutHandler });

        assert.equal(fetches.length, 0);
        mock.timers.tick(19_999);
        assert.equal(reload.mock.callCount(), 0);
        mock.timers.tick(1);
        assert.equal(reload.mock.callCount(), 1);
    });

    it('does not refresh the token when the tokenTimeoutHandler answers after destroy', async () => {
        let prolong: (value: boolean) => void = () => {};
        const tokenTimeoutHandler = mock.fn(
            (_expires: number) =>
                new Promise<boolean>(resolve => {
                    prolong = resolve;
                }),
        );
        await loginWithTokens({ accessIn: 20_000 }, { tokenTimeoutHandler });
        assert.equal(tokenTimeoutHandler.mock.callCount(), 1);

        conn.destroy();
        prolong(true);
        await flush();

        // the refresh token can be used only once, the other tabs still need it
        assert.equal(fetches.length, 0);
    });

    it('does not start a second refresh while one is running', async () => {
        await loginWithTokens({ accessIn: 20_000 });

        mock.timers.tick(60_000);
        socket.fire('reauthenticate');

        assert.equal(fetches.length, 1);
    });

    it('does not reload the page after destroy', async () => {
        await loginWithTokens({ refresh: '', accessIn: 20_000 });

        conn.destroy();
        mock.timers.tick(20_000);

        assert.equal(reload.mock.callCount(), 0);
    });
});

describe('Connection.refreshTokens', () => {
    useEnvironment();

    it('posts the refresh token to ./oauth/token', async () => {
        await loginWithTokens({ accessIn: 20_000 });

        assert.equal(lastFetch().url, './oauth/token');
        assert.deepEqual(lastFetch().init, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=refresh_token&refresh_token=refresh-1&client_id=ioBroker&stayloggedin=true',
        });
    });

    it('holds the lock during the request', async () => {
        await loginWithTokens({ accessIn: 20_000 });

        assert.deepEqual(readLock(), { connId: conn.connId, expiry: NOW + 10_000 });
    });

    it('stores the new tokens and announces the access token to the server', async () => {
        await loginWithTokens({ accessIn: 20_000 });

        await answerFetch(200, oauthResponse(2));

        assert.equal(
            storedTokens('local'),
            `refresh-2;2026-09-23T12:00:00.000Z;access-2;2026-09-22T13:00:00.000Z;${conn.connId}`,
        );
        assert.equal(readLock(), null);
        assert.deepEqual(announced(), ['access-2']);
    });

    it('keeps the tokens of sessionStorage in sessionStorage', async () => {
        await loginWithTokens({ accessIn: 20_000, storage: 'session' });
        assert.match(lastBody(), /&stayloggedin=false$/);

        await answerFetch(200, oauthResponse(2));

        assert.equal(Connection.readTokens()?.access_token, 'access-2');
        assert.equal(Connection.readTokens()?.stayLoggedIn, false);
        assert.equal(storedTokens('local'), null);
    });

    for (const status of [400, 401]) {
        it(`deletes the tokens and opens the login page when the server answers ${status}`, async () => {
            await loginWithTokens({ accessIn: 20_000 });

            await answerFetch(status, { error: 'invalid_grant' });

            assert.equal(storedTokens('local'), null);
            assert.equal(readLock(), null);
            assert.equal(globalThis.location.href, LOGIN_PAGE);
        });
    }

    it('deletes only the tokens of the storage that was refreshed', async () => {
        storeTokens('local', { refresh: 'local-refresh', owner: 'other-tab' });
        await loginWithTokens({ accessIn: 20_000, storage: 'session' });

        await answerFetch(401);

        assert.equal(storedTokens('session'), null);
        assert.match(storedTokens('local') ?? '', /^local-refresh;/);
    });

    it('opens the login page when the answer has no access token', async () => {
        await loginWithTokens({ accessIn: 20_000 });

        await answerFetch(200, {});

        assert.equal(storedTokens('local'), null);
        assert.equal(globalThis.location.href, LOGIN_PAGE);
    });

    it('tries again 5 seconds after another error of the server', async () => {
        await loginWithTokens({ accessIn: 20_000 });
        const tokens = storedTokens('local');

        await answerFetch(502);

        assert.equal(storedTokens('local'), tokens);
        assert.equal(readLock(), null);
        assert.equal(globalThis.location.href, START_PAGE);
        mock.timers.tick(4_999);
        assert.equal(fetches.length, 1);
        mock.timers.tick(1);
        assert.equal(fetches.length, 2);
    });

    it('tries again 5 seconds after a network error', async () => {
        await loginWithTokens({ accessIn: 20_000 });

        await failFetch();

        assert.notEqual(storedTokens('local'), null);
        assert.equal(globalThis.location.href, START_PAGE);
        mock.timers.tick(4_999);
        assert.equal(fetches.length, 1);
        mock.timers.tick(1);
        assert.equal(fetches.length, 2);
    });

    it('only announces the tokens that another tab renewed in the meantime', async () => {
        await loginWithTokens({ accessIn: 20_000 });
        storeTokens('local', { refresh: 'refresh-2', access: 'access-2', owner: 'other-tab' });

        await answerFetch(400);

        assert.match(storedTokens('local') ?? '', /^refresh-2;/);
        assert.equal(globalThis.location.href, START_PAGE);
        assert.deepEqual(announced(), ['access-2']);
        mock.timers.tick(10_000);
        assert.equal(fetches.length, 1);
    });

    it('checks every 2 seconds again while another tab holds the lock', async () => {
        setLock({ connId: 'other-tab', expiry: NOW + 10_000 });

        await loginWithTokens({ accessIn: 20_000 });

        assert.equal(fetches.length, 0);
        tickTimes(4, 2_000);
        mock.timers.tick(1_999);
        assert.equal(fetches.length, 0);
        // the lock of the other tab expires after 10 s
        mock.timers.tick(1);
        assert.equal(fetches.length, 1);
    });

    it('does not refresh when the tab that held the lock has renewed the tokens', async () => {
        setLock({ connId: 'other-tab', expiry: NOW + 10_000 });
        await loginWithTokens({ accessIn: 20_000 });

        mock.timers.tick(1_000);
        storeTokens('local', { refresh: 'refresh-2', access: 'access-2', owner: 'other-tab' });
        globalThis.localStorage.removeItem(LOCK);
        tickTimes(10, 2_000);

        assert.equal(fetches.length, 0);
    });

    it('stops checking the tokens when the connection was destroyed during the refresh', async () => {
        await loginWithTokens({ accessIn: 20_000 });

        conn.destroy();
        await answerFetch(200, oauthResponse(2));
        storeTokens('local', { owner: conn.connId, accessIn: 20_000 });
        mock.timers.tick(120_000);

        assert.equal(fetches.length, 1);
    });
});

describe('Connection.updateTokenExpiration', () => {
    useEnvironment();

    beforeEach(() => loginWithTokens());

    it('refreshes the token when the server rejects the announced one', () => {
        otherTabStores();

        answerAnnouncement('No access token found', false);

        assert.equal(fetches.length, 1);
        assert.match(lastBody(), /refresh_token=refresh-2&/);
    });

    it('treats an answer without success as a rejection', () => {
        otherTabStores();

        answerAnnouncement(null, false);

        assert.equal(fetches.length, 1);
    });

    it('reloads the page after the third rejection in a row', async () => {
        otherTabStores();
        answerAnnouncement('No access token found', false);
        await answerFetch(200, oauthResponse(3));
        answerAnnouncement('No access token found', false);
        await answerFetch(200, oauthResponse(4));
        assert.equal(reload.mock.callCount(), 0);

        answerAnnouncement('No access token found', false);

        assert.deepEqual(announced(), ['access-2', 'access-3', 'access-4']);
        assert.equal(fetches.length, 2);
        assert.equal(reload.mock.callCount(), 1);
    });

    it('counts the rejections anew after the server accepted a token', async () => {
        otherTabStores();
        answerAnnouncement('No access token found', false);
        await answerFetch(200, oauthResponse(3));
        answerAnnouncement('No access token found', false);
        await answerFetch(200, oauthResponse(4));
        answerAnnouncement(null, true);

        otherTabStores({ refresh: 'refresh-5', access: 'access-5' });
        answerAnnouncement('No access token found', false);

        assert.equal(fetches.length, 3);
        assert.equal(reload.mock.callCount(), 0);
    });

    it('reloads the page when the server rejects the token and there is no refresh token', () => {
        otherTabStores({ refresh: '' });

        answerAnnouncement('No access token found', false);

        assert.equal(fetches.length, 0);
        assert.equal(reload.mock.callCount(), 1);
    });

    it('does not announce the same token twice', () => {
        otherTabStores();
        fireStorage();

        assert.deepEqual(announced(), ['access-2']);
    });

    it('waits for the running refresh when the server rejects a token meanwhile', async () => {
        otherTabStores();
        // announced token = stored token, so this starts a refresh
        socket.fire('reauthenticate');
        assert.equal(fetches.length, 1);

        answerAnnouncement('Access token belongs to another user', false);
        assert.equal(reload.mock.callCount(), 0);

        await answerFetch(200, oauthResponse(3));
        assert.deepEqual(announced(), ['access-2', 'access-3']);
    });
});

describe('Connection.onReauthenticate', () => {
    useEnvironment();

    /** The server has accepted the stored token of another tab 5 seconds ago */
    async function loginAndAnnounce(): Promise<void> {
        await loginWithTokens({ owner: 'other-tab' });
        fireStorage();
        answerAnnouncement(null, true);
        mock.timers.tick(5_000);
    }

    it('opens the login page without a refresh token', async () => {
        ({ conn, socket } = await createConnection(Connection));
        await login(conn, socket, { isSecure: true });

        socket.fire('reauthenticate');

        assert.equal(globalThis.location.href, LOGIN_PAGE);
        assert.equal(fetches.length, 0);
    });

    it('opens the login page when the refresh token has expired', async () => {
        await loginWithTokens({ refreshIn: 10_000 });
        mock.timers.tick(10_001);

        socket.fire('reauthenticate');

        assert.equal(globalThis.location.href, LOGIN_PAGE);
        assert.equal(fetches.length, 0);
    });

    it('refreshes the rejected token even if another tab owns it', async () => {
        await loginAndAnnounce();

        socket.fire('reauthenticate');

        assert.equal(fetches.length, 1);
        assert.match(lastBody(), /refresh_token=refresh-1&/);
        await answerFetch(200, oauthResponse(2));
        assert.equal(Connection.readTokens()?.owner, conn.connId);
        assert.deepEqual(announced(), ['access-1', 'access-2']);
        assert.equal(globalThis.location.href, START_PAGE);
    });

    it('opens the login page when the refresh token is rejected too', async () => {
        await loginAndAnnounce();

        socket.fire('reauthenticate');
        await answerFetch(401);

        assert.equal(globalThis.location.href, LOGIN_PAGE);
    });

    it('does nothing while a refresh is running', async () => {
        await loginAndAnnounce();
        socket.fire('reauthenticate');

        socket.fire('reauthenticate');

        assert.equal(fetches.length, 1);
        assert.equal(globalThis.location.href, START_PAGE);
    });

    it('ignores a rejection within 5 seconds after the server accepted a token', async () => {
        await loginWithTokens({ owner: 'other-tab' });
        fireStorage();
        answerAnnouncement(null, true);

        mock.timers.tick(4_999);
        socket.fire('reauthenticate');
        assert.equal(fetches.length, 0);

        mock.timers.tick(1);
        socket.fire('reauthenticate');
        assert.equal(fetches.length, 1);
    });

    it('announces a token that another tab renewed instead of refreshing it', async () => {
        await loginAndAnnounce();
        storeTokens('local', { refresh: 'refresh-2', access: 'access-2', owner: 'other-tab' });

        socket.fire('reauthenticate');

        assert.deepEqual(announced(), ['access-1', 'access-2']);
        assert.equal(fetches.length, 0);
    });

    it('refreshes a token of another tab that expires within 5 seconds', async () => {
        await loginAndAnnounce();
        storeTokens('local', { refresh: 'refresh-2', access: 'access-2', accessIn: 5_000, owner: 'other-tab' });

        socket.fire('reauthenticate');

        assert.equal(fetches.length, 1);
        assert.match(lastBody(), /refresh_token=refresh-2&/);
    });
});

describe('Connection.onAccessTokenUpdated', () => {
    useEnvironment();

    beforeEach(() => loginWithTokens());

    it('announces the token that another tab stored', () => {
        otherTabStores();

        assert.deepEqual(announced(), ['access-2']);
    });

    it('ignores changes of other keys', () => {
        storeTokens('local', { access: 'access-2' });

        fireStorage('other');

        assert.deepEqual(announced(), []);
    });

    it('ignores the removal of the tokens', () => {
        Connection.deleteTokensStatic();

        fireStorage();

        assert.deepEqual(announced(), []);
    });

    it('is removed by destroy', () => {
        const [listener] = storageListeners;

        conn.destroy();

        assert.equal(storageListeners.size, 0);
        assert.deepEqual(removeEventListener.mock.calls[0].arguments, ['storage', listener]);
        assert.equal(addEventListener.mock.callCount(), 1);
    });
});

describe('Connection.authenticate', () => {
    useEnvironment();

    beforeEach(async () => {
        ({ conn, socket } = await createConnection(Connection));
    });

    it('opens the login page with the query and hash of the page on "User not authorized"', () => {
        setLocation({ search: '?lang=de', hash: '#tab-intro' });

        socket.fire('error', 'User not authorized');

        assert.equal(globalThis.location.href, `${LOGIN_PAGE}%3Flang%3Dde%23tab-intro`);
    });

    it('keeps the path of the page', () => {
        setLocation({ pathname: '/vis-2/edit.html' });

        socket.fire('error', new Error('User not authorized'));

        assert.equal(globalThis.location.href, 'http://localhost:8081/vis-2/edit.html?login&href=');
    });

    it('opens the login page as it is when the query already has a href', () => {
        setLocation({ search: '?login&href=%3Flang%3Dde', hash: '#tab-intro' });

        socket.fire('error', 'User not authorized');

        assert.equal(globalThis.location.href, `${LOGIN_PAGE}%3Flang%3Dde`);
    });

    it('stays on the page on other errors', () => {
        socket.fire('error', 'Something else');

        assert.equal(globalThis.location.href, START_PAGE);
    });
});

describe('Connection.logout', () => {
    useEnvironment();

    it('asks the server to log out and resolves with null', async () => {
        await loginWithTokens();

        const promise = conn.logout();
        socket.lastAnswer('logout')(null);

        assert.equal(await promise, null);
    });

    it('rejects with the error of the server', async () => {
        await loginWithTokens();

        const promise = conn.logout();
        socket.lastAnswer('logout')('No session');

        await assert.rejects(promise, error => error === 'No session');
    });

    it('rejects when the socket is not connected', async () => {
        ({ conn, socket } = await createConnection(Connection));

        await assert.rejects(conn.logout(), { message: ERRORS.NOT_CONNECTED });
        assert.equal(socket.requestsOf('logout').length, 0);
    });
});
