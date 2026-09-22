import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { Connection } from '../src/Connection.js';
import { FakeSocket } from './lib/FakeSocket.js';
import { flush, resetGlobals, track } from './lib/helpers.js';

/** What the ioBroker cloud answers while the ioBroker of the user is not connected to it */
const CLOUD_NOT_CONNECTED = 'ioBroker is not connected';
const VERSION = { version: '7.0.1', serverName: 'admin' };

describe('Connection.getVersion', () => {
    let socket: FakeSocket;
    let conn: Connection;
    let onError: ReturnType<typeof mock.fn<(error: any) => void>>;
    let warn: ReturnType<typeof mock.method>;

    /** Creates the connection and lets the socket connect. The connection asks for the version 500 ms later */
    async function connect(): Promise<void> {
        conn = new Connection({
            name: 'test',
            connect: () => socket,
            onError,
        });
        // The socket is created after the socket library was "loaded"
        await flush();
        socket.fire('connect');
        mock.timers.tick(500);
    }

    /** Connects and answers the version request of the connect, so a test starts without a cached version */
    async function connectAndAnswer(): Promise<void> {
        await connect();
        socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
        await flush();
        conn.resetCache('version');
        socket.requests.length = 0;
    }

    beforeEach(() => {
        resetGlobals();
        mock.timers.enable({ apis: ['setTimeout'] });
        warn = mock.method(console, 'warn', () => {});
        onError = mock.fn<(error: any) => void>();
        socket = new FakeSocket();
    });

    afterEach(() => {
        conn?.destroy();
        mock.timers.reset();
        mock.restoreAll();
    });

    describe('with the answer of the server', () => {
        beforeEach(() => connectAndAnswer());

        it('resolves with the version and the server name', async () => {
            const promise = conn.getVersion();
            assert.equal(socket.requestsOf('getVersion').length, 1);

            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);

            assert.deepEqual(await promise, VERSION);
        });

        it('caches the version until an update is requested', async () => {
            const first = conn.getVersion();
            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
            await first;

            assert.deepEqual(await conn.getVersion(), VERSION);
            assert.equal(socket.requestsOf('getVersion').length, 1);

            const updated = conn.getVersion(true);
            assert.equal(socket.requestsOf('getVersion').length, 2);
            socket.lastAnswer('getVersion')(null, '7.0.2', VERSION.serverName);
            assert.deepEqual(await updated, { version: '7.0.2', serverName: VERSION.serverName });
        });

        it('takes the version from the first parameter of the old socket.io', async () => {
            const promise = conn.getVersion();
            socket.lastAnswer('getVersion')('1.2.3');

            assert.deepEqual(await promise, { version: '1.2.3', serverName: 'socketio' });
        });

        it('rejects on an error and asks anew on the next call', async () => {
            const promise = conn.getVersion();
            socket.lastAnswer('getVersion')('permissionError');
            await assert.rejects(promise, error => error === 'permissionError');

            const next = conn.getVersion();
            assert.equal(socket.requestsOf('getVersion').length, 2);
            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
            assert.deepEqual(await next, VERSION);
        });

        it('removes its disconnect handler after the answer', async () => {
            const before = socket.listenerCount('disconnect');

            const promise = conn.getVersion();
            assert.equal(socket.listenerCount('disconnect'), before + 1);
            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
            await promise;
            assert.equal(socket.listenerCount('disconnect'), before);

            const failed = conn.getVersion(true);
            socket.lastAnswer('getVersion')('error');
            await assert.rejects(failed);
            assert.equal(socket.listenerCount('disconnect'), before);
        });
    });

    describe('while ioBroker is not connected to the cloud', () => {
        beforeEach(() => connectAndAnswer());

        it('asks again every 5 seconds until ioBroker is connected', async () => {
            const promise = track(conn.getVersion());

            socket.lastAnswer('getVersion')(CLOUD_NOT_CONNECTED);
            mock.timers.tick(4999);
            assert.equal(socket.requestsOf('getVersion').length, 1);
            mock.timers.tick(1);
            assert.equal(socket.requestsOf('getVersion').length, 2);

            socket.lastAnswer('getVersion')(CLOUD_NOT_CONNECTED);
            mock.timers.tick(5000);
            assert.equal(socket.requestsOf('getVersion').length, 3);

            await flush();
            assert.equal(promise.settled, false);

            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
            await flush();
            assert.deepEqual(promise.value, VERSION);
        });

        it('warns only once', () => {
            void conn.getVersion();
            for (let i = 0; i < 3; i++) {
                socket.lastAnswer('getVersion')(CLOUD_NOT_CONNECTED);
                mock.timers.tick(5000);
            }

            assert.equal(socket.requestsOf('getVersion').length, 4);
            assert.equal(warn.mock.callCount(), 1);
        });

        it('keeps one disconnect handler during the retries', async () => {
            const before = socket.listenerCount('disconnect');

            const promise = conn.getVersion();
            for (let i = 0; i < 3; i++) {
                socket.lastAnswer('getVersion')(CLOUD_NOT_CONNECTED);
                mock.timers.tick(5000);
                assert.equal(socket.listenerCount('disconnect'), before + 1);
            }
            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
            await promise;

            assert.equal(socket.listenerCount('disconnect'), before);
        });

        it('stops asking when the socket disconnects', async () => {
            const promise = track(conn.getVersion());
            socket.lastAnswer('getVersion')(CLOUD_NOT_CONNECTED);

            socket.fire('disconnect');
            mock.timers.tick(60000);

            assert.equal(socket.requestsOf('getVersion').length, 1);
            await flush();
            assert.equal(promise.settled, false);
        });
    });

    describe('when the socket disconnects during the request', () => {
        beforeEach(() => connectAndAnswer());

        it('ignores an answer that comes after the disconnect', async () => {
            const promise = track(conn.getVersion());

            socket.fire('disconnect');
            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
            await flush();

            assert.equal(promise.settled, false);
        });

        it('does not ask again for a "not connected" that comes after the disconnect', () => {
            void conn.getVersion();

            socket.fire('disconnect');
            socket.lastAnswer('getVersion')(CLOUD_NOT_CONNECTED);
            mock.timers.tick(60000);

            assert.equal(socket.requestsOf('getVersion').length, 1);
            assert.equal(warn.mock.callCount(), 0);
        });

        it('is asked anew by the connect handler after the reconnect', async () => {
            void conn.getVersion();
            socket.fire('disconnect');

            socket.fire('connect');
            mock.timers.tick(500);
            assert.equal(socket.requestsOf('getVersion').length, 2);

            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
            await flush();
            assert.equal(socket.requestsOf('authenticate').length, 1);
            assert.deepEqual(await conn.getVersion(), VERSION);
        });

        it('does not skip the disconnect handler registered after its own', () => {
            void conn.getVersion();
            const other = mock.fn();
            socket.on('disconnect', other);

            socket.fire('disconnect');

            assert.equal(other.mock.callCount(), 1);
        });

        it('removes its disconnect handler after the disconnect', () => {
            const before = socket.listenerCount('disconnect');
            void conn.getVersion();

            socket.fire('disconnect');
            mock.timers.tick(1);

            assert.equal(socket.listenerCount('disconnect'), before);
        });
    });

    describe('on connect', () => {
        beforeEach(() => connect());

        it('authenticates after ioBroker got connected to the cloud', async () => {
            assert.equal(socket.requestsOf('getVersion').length, 1);

            socket.lastAnswer('getVersion')(CLOUD_NOT_CONNECTED);
            await flush();
            assert.equal(socket.requestsOf('authenticate').length, 0);

            mock.timers.tick(5000);
            socket.lastAnswer('getVersion')(null, VERSION.version, VERSION.serverName);
            await flush();

            assert.equal(socket.requestsOf('authenticate').length, 1);
            assert.equal(onError.mock.callCount(), 0);
        });

        it('reports an error of the server', async () => {
            socket.lastAnswer('getVersion')('error');
            await flush();

            assert.equal(socket.requestsOf('authenticate').length, 0);
            assert.equal(onError.mock.callCount(), 1);
            assert.equal(onError.mock.calls[0].arguments[0].operation, 'getVersion');
        });
    });
});
