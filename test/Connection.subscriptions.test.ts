import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { Connection, ERRORS } from '../src/Connection.js';
import type {
    BinaryStateChangeHandler,
    FileChangeHandler,
    InstanceMessageCallback,
    ObjectChangeHandler,
} from '../src/Connection.js';
import type { ConnectionProps, LogMessage } from '../src/ConnectionProps.js';
import type { FakeSocket } from './lib/FakeSocket.js';
import { createConnection, createLoggedInConnection, flush, login, resetGlobals, track } from './lib/helpers.js';

const STATE = { val: 1, ack: true, ts: 1000, lc: 1000, from: 'system.adapter.test.0', q: 0 } as ioBroker.State;
/** The state vis uses for "nothing selected" and never sends to the server */
const IGNORED = 'nothing_selected';
const INSTANCE = 'system.adapter.cameras.0';
const MESSAGE_TYPE = 'startCamera/cam3';

/** A new object each time, as the connection keeps and changes the objects it gets */
function stateObject(id: string, extra: Record<string, unknown> = {}): ioBroker.Object {
    return {
        _id: id,
        type: 'state',
        common: { name: id, type: 'number', role: 'value', read: true, write: true },
        native: {},
        ...extra,
    } as unknown as ioBroker.Object;
}

describe('Connection.subscriptions', () => {
    let conn: Connection;
    let socket: FakeSocket;
    let consoleError: ReturnType<typeof mock.method>;

    /** Creates the connection, logs in and forgets the requests of the login */
    async function connect(props: Partial<ConnectionProps> = {}): Promise<void> {
        ({ conn, socket } = await createLoggedInConnection(Connection, props));
        socket.clearRequests();
    }

    /** Simulates an event of the server and lets the connection dispatch it, which it does with a setTimeout of 0 ms */
    function serverEvent(name: string, ...args: any[]): void {
        socket.fire(name, ...args);
        mock.timers.tick(0);
    }

    /** Lets the socket disconnect and connect again like the ws client of ioBroker does */
    async function reconnect(): Promise<void> {
        socket.fire('disconnect');
        socket.fire('connect', true);
        await flush();
    }

    /** The ids of all requests with this name, no matter if they were sent one by one or as an array */
    function idsOf(name: string): string[] {
        return socket.requestsOf(name).flatMap(request => request.args[0]);
    }

    /** The [id, file pattern] pairs of all requests with this name */
    function filesOf(name: string): [string, string][] {
        return socket
            .requestsOf(name)
            .flatMap(request =>
                [request.args[1]].flat().map((pattern: string): [string, string] => [request.args[0], pattern]),
            );
    }

    function argsOf(name: string): any[][] {
        return socket.requestsOf(name).map(request => request.args);
    }

    beforeEach(() => {
        resetGlobals();
        mock.timers.enable({ apis: ['setTimeout'] });
        consoleError = mock.method(console, 'error', () => {});
    });

    afterEach(() => {
        conn?.destroy();
        mock.timers.reset();
        mock.restoreAll();
    });

    describe('subscribeState', () => {
        let handler: ReturnType<typeof mock.fn<ioBroker.StateChangeHandler>>;

        beforeEach(async () => {
            await connect();
            handler = mock.fn<ioBroker.StateChangeHandler>();
        });

        it('subscribes a new id and resolves after the handler got the current value', async () => {
            const promise = track(conn.subscribeState('a.0.x', handler));

            assert.deepEqual(argsOf('subscribe'), [[['a.0.x']]]);
            assert.deepEqual(argsOf('getForeignStates'), [[['a.0.x']]]);
            await flush();
            assert.equal(promise.settled, false);

            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE });
            await flush();

            assert.equal(promise.settled, true);
            assert.equal(promise.error, undefined);
            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments),
                [['a.0.x', STATE]],
            );
        });

        it('subscribes all ids of an array with one request', async () => {
            const promise = conn.subscribeState(['a.0.x', 'a.0.y'], handler);

            assert.deepEqual(argsOf('subscribe'), [[['a.0.x', 'a.0.y']]]);
            assert.deepEqual(argsOf('getForeignStates'), [[['a.0.x', 'a.0.y']]]);
            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE, 'a.0.y': null });
            await promise;

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments),
                [
                    ['a.0.x', STATE],
                    ['a.0.y', null],
                ],
            );
        });

        it('asks a web server with "getStates" for the current values', async () => {
            (globalThis as any).socketUrl = 'http://localhost:8082';

            const promise = conn.subscribeState('a.0.x', handler);

            assert.equal(socket.requestsOf('getForeignStates').length, 0);
            assert.deepEqual(argsOf('getStates'), [[['a.0.x']]]);
            socket.lastAnswer('getStates')(null, { 'a.0.x': STATE });
            await promise;
            assert.deepEqual(handler.mock.calls[0].arguments, ['a.0.x', STATE]);
        });

        it('subscribes only the new ids, but gives a further handler the current value', async () => {
            socket.respond('getForeignStates', () => [null, { 'a.0.x': STATE }]);
            await conn.subscribeState('a.0.x', mock.fn());
            socket.clearRequests();

            await conn.subscribeState(['a.0.x', 'a.0.y'], handler);

            assert.deepEqual(idsOf('subscribe'), ['a.0.y']);
            assert.equal(socket.requestsOf('getForeignStates').length, 1);
            assert.deepEqual(handler.mock.calls[0].arguments, ['a.0.x', STATE]);
        });

        it('does not subscribe anything when all ids are already subscribed', async () => {
            socket.respond('getForeignStates', () => [null, {}]);
            await conn.subscribeState(['a.0.x', 'a.0.y'], mock.fn());
            socket.clearRequests();

            await conn.subscribeState(['a.0.y', 'a.0.x'], handler);

            assert.equal(socket.requestsOf('subscribe').length, 0);
        });

        it('registers the same handler only once', async () => {
            socket.respond('getForeignStates', () => [null, {}]);
            await conn.subscribeState('a.0.x', handler);
            await conn.subscribeState('a.0.x', handler);

            serverEvent('stateChange', 'a.0.x', STATE);

            assert.equal(handler.mock.callCount(), 1);
        });

        it('reads the current values of a pattern', async () => {
            const promise = conn.subscribeState('a.0.*', handler);

            assert.deepEqual(argsOf('subscribe'), [[['a.0.*']]]);
            assert.deepEqual(argsOf('getForeignStates'), [['a.0.*']]);
            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE, 'a.0.y': STATE });
            await promise;

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments[0]),
                ['a.0.x', 'a.0.y'],
            );
        });

        it('reads the current values of an array with a pattern id by id', async () => {
            const promise = conn.subscribeState(['a.0.*', 'b.0.x'], handler);

            assert.deepEqual(argsOf('subscribe'), [[['a.0.*', 'b.0.x']]]);
            assert.deepEqual(argsOf('getForeignStates'), [['a.0.*']]);
            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE });
            await flush();
            assert.deepEqual(argsOf('getForeignStates'), [['a.0.*'], ['b.0.x']]);
            socket.lastAnswer('getForeignStates')(null, { 'b.0.x': STATE });
            await promise;

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments[0]),
                ['a.0.x', 'b.0.x'],
            );
        });

        it('calls a binary handler with the Base64 value of each id', async () => {
            const binaryHandler = mock.fn<BinaryStateChangeHandler>();
            const promise = conn.subscribeState(
                ['a.0.bin', 'a.0.empty', 'a.0.broken', 'a.0.last'],
                true,
                binaryHandler,
            );
            assert.deepEqual(argsOf('subscribe'), [[['a.0.bin', 'a.0.empty', 'a.0.broken', 'a.0.last']]]);

            socket.lastAnswer('getBinaryState')(null, 'AAEC');
            await flush();
            socket.lastAnswer('getBinaryState')(null, undefined);
            await flush();
            socket.lastAnswer('getBinaryState')('error');
            await flush();
            socket.lastAnswer('getBinaryState')(null, 'AQ==');
            await promise;

            assert.deepEqual(argsOf('getBinaryState'), [['a.0.bin'], ['a.0.empty'], ['a.0.broken'], ['a.0.last']]);
            assert.equal(socket.requestsOf('getForeignStates').length, 0);
            assert.deepEqual(
                binaryHandler.mock.calls.map(call => call.arguments),
                [
                    ['a.0.bin', 'AAEC'],
                    ['a.0.last', 'AQ=='],
                ],
            );
            assert.equal(consoleError.mock.callCount(), 1);
        });

        it('treats the binary flag false like no flag', async () => {
            const promise = conn.subscribeState('a.0.x', false, handler);
            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE });
            await promise;

            assert.equal(socket.requestsOf('getBinaryState').length, 0);
            assert.deepEqual(handler.mock.calls[0].arguments, ['a.0.x', STATE]);
        });

        it('rejects a handler that is not a function and registers nothing', async () => {
            await assert.rejects(conn.subscribeState('a.0.x', undefined as any), /must be a function/);
            assert.equal(socket.requests.length, 0);

            void conn.subscribeState('a.0.x', handler);
            assert.deepEqual(idsOf('subscribe'), ['a.0.x']);
        });

        it('only registers the handler while disconnected', async () => {
            socket.fire('disconnect');

            await conn.subscribeState('a.0.x', handler);

            assert.equal(socket.requests.length, 0);
            assert.equal(handler.mock.callCount(), 0);
        });

        it('resolves and stays subscribed when the current value cannot be read', async () => {
            const promise = conn.subscribeState('a.0.x', handler);
            socket.lastAnswer('getForeignStates')('permissionError');
            await promise;

            assert.equal(handler.mock.callCount(), 0);
            assert.equal(consoleError.mock.callCount(), 1);
            serverEvent('stateChange', 'a.0.x', STATE);
            assert.equal(handler.mock.callCount(), 1);
        });

        it('catches the rejection of an async handler for the current value', async () => {
            handler = mock.fn<ioBroker.StateChangeHandler>(() => Promise.reject(new Error('failed')));

            const promise = conn.subscribeState('a.0.x', handler);
            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE });
            await promise;
            await flush();

            assert.match(String(consoleError.mock.calls[0].arguments[0]), /Cannot call state change handler/);
        });

        it('gives the handler the current values of the other ids when it throws for one', async () => {
            handler = mock.fn<ioBroker.StateChangeHandler>(id => {
                if (id === 'a.0.x') {
                    throw new Error('failed');
                }
            });

            const promise = conn.subscribeState(['a.0.x', 'a.0.y'], handler);
            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE, 'a.0.y': STATE });
            await promise;

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments[0]),
                ['a.0.x', 'a.0.y'],
            );
        });

        it('does not reject when the handler throws for the current value of a pattern', async () => {
            handler = mock.fn<ioBroker.StateChangeHandler>(() => {
                throw new Error('failed');
            });

            const promise = conn.subscribeState('a.0.*', handler);
            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE });

            await promise;
        });

        it('subscribeStateAsync resolves after the handler got the current value', async () => {
            const promise = track(conn.subscribeStateAsync('a.0.x', handler));
            assert.deepEqual(idsOf('subscribe'), ['a.0.x']);
            await flush();
            assert.equal(promise.settled, false);

            socket.lastAnswer('getForeignStates')(null, { 'a.0.x': STATE });
            await flush();

            assert.equal(promise.settled, true);
            assert.equal(handler.mock.callCount(), 1);
        });
    });

    describe('unsubscribeState', () => {
        let first: ReturnType<typeof mock.fn<ioBroker.StateChangeHandler>>;
        let second: ReturnType<typeof mock.fn<ioBroker.StateChangeHandler>>;

        beforeEach(async () => {
            await connect();
            socket.respond('getForeignStates', () => [null, {}]);
            first = mock.fn<ioBroker.StateChangeHandler>();
            second = mock.fn<ioBroker.StateChangeHandler>();
            await conn.subscribeState('a.0.x', first);
            await conn.subscribeState('a.0.x', second);
            socket.clearRequests();
        });

        it('unsubscribes at the server when the last handler is removed', () => {
            conn.unsubscribeState('a.0.x', first);
            assert.equal(socket.requestsOf('unsubscribe').length, 0);

            conn.unsubscribeState('a.0.x', second);
            assert.deepEqual(argsOf('unsubscribe'), [[['a.0.x']]]);
        });

        it('calls only the remaining handlers', () => {
            conn.unsubscribeState('a.0.x', first);

            serverEvent('stateChange', 'a.0.x', STATE);

            assert.equal(first.mock.callCount(), 0);
            assert.equal(second.mock.callCount(), 1);
        });

        it('removes all handlers without a handler argument', () => {
            conn.unsubscribeState('a.0.x');
            assert.deepEqual(idsOf('unsubscribe'), ['a.0.x']);

            serverEvent('stateChange', 'a.0.x', STATE);
            assert.equal(first.mock.callCount() + second.mock.callCount(), 0);
        });

        it('ignores unknown ids and handlers', () => {
            conn.unsubscribeState('a.0.unknown');
            conn.unsubscribeState('a.0.x', mock.fn<ioBroker.StateChangeHandler>());

            assert.equal(socket.requests.length, 0);
            serverEvent('stateChange', 'a.0.x', STATE);
            assert.equal(first.mock.callCount(), 1);
        });

        it('unsubscribes all ids of an array with one request', async () => {
            await conn.subscribeState(['b.0.x', 'b.0.y'], first);
            socket.clearRequests();

            conn.unsubscribeState(['b.0.x', 'b.0.y'], first);

            assert.deepEqual(argsOf('unsubscribe'), [[['b.0.x', 'b.0.y']]]);
        });

        it('unsubscribes at the server only the ids without remaining handlers', async () => {
            await conn.subscribeState('b.0.x', first);
            socket.clearRequests();

            conn.unsubscribeState(['a.0.x', 'b.0.x'], first);

            assert.deepEqual(idsOf('unsubscribe'), ['b.0.x']);
        });

        it('does not unsubscribe while disconnected and not subscribe again after the reconnect', async () => {
            socket.fire('disconnect');
            conn.unsubscribeState('a.0.x');
            assert.equal(socket.requests.length, 0);

            socket.fire('connect', true);
            await flush();

            assert.deepEqual(idsOf('subscribe'), []);
        });
    });

    describe('stateChange', () => {
        let handler: ReturnType<typeof mock.fn<ioBroker.StateChangeHandler>>;

        beforeEach(async () => {
            await connect();
            socket.respond('getForeignStates', () => [null, {}]);
            handler = mock.fn<ioBroker.StateChangeHandler>();
        });

        it('calls all handlers of the id after the current event', async () => {
            const other = mock.fn<ioBroker.StateChangeHandler>();
            await conn.subscribeState('a.0.x', handler);
            await conn.subscribeState('a.0.x', other);

            socket.fire('stateChange', 'a.0.x', STATE);
            assert.equal(handler.mock.callCount(), 0);
            mock.timers.tick(0);

            assert.deepEqual(handler.mock.calls[0].arguments, ['a.0.x', STATE]);
            assert.deepEqual(other.mock.calls[0].arguments, ['a.0.x', STATE]);
        });

        it('does not call the handlers of an id for other ids', async () => {
            await conn.subscribeState('a.0.x', handler);

            for (const id of ['a.0.xy', 'a.0', 'a.0.x.y', 'b.a.0.x', 'a90x']) {
                serverEvent('stateChange', id, STATE);
            }

            assert.equal(handler.mock.callCount(), 0);
        });

        it('calls the handlers of matching patterns', async () => {
            const alive = mock.fn<ioBroker.StateChangeHandler>();
            await conn.subscribeState('a.0.*', handler);
            await conn.subscribeState('*.alive', alive);

            for (const id of ['a.0.x', 'a.0.x.y', 'a.1.x', 'a.0', 'system.adapter.a.0.alive', 'a.0.alive.x']) {
                serverEvent('stateChange', id, STATE);
            }

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments[0]),
                ['a.0.x', 'a.0.x.y', 'a.0.alive.x'],
            );
            assert.deepEqual(
                alive.mock.calls.map(call => call.arguments[0]),
                ['system.adapter.a.0.alive'],
            );
        });

        it('passes null for a deleted state', async () => {
            await conn.subscribeState('a.0.x', handler);

            serverEvent('stateChange', 'a.0.x', null);
            serverEvent('stateChange', 'a.0.x', undefined);

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments),
                [
                    ['a.0.x', null],
                    ['a.0.x', null],
                ],
            );
        });

        it('calls the other handlers when one throws', async () => {
            await conn.subscribeState(
                'a.0.x',
                mock.fn(() => {
                    throw new Error('failed');
                }),
            );
            await conn.subscribeState('a.0.x', handler);

            serverEvent('stateChange', 'a.0.x', STATE);

            assert.equal(handler.mock.callCount(), 1);
            assert.match(String(consoleError.mock.calls[0].arguments[0]), /failed/);
        });

        it('catches the rejection of an async handler', async () => {
            await conn.subscribeState('a.0.x', () => Promise.reject(new Error('failed')));

            serverEvent('stateChange', 'a.0.x', STATE);
            await flush();

            assert.match(String(consoleError.mock.calls[0].arguments[0]), /Cannot call state change handler/);
        });
    });

    describe('setStateToIgnore', () => {
        let handler: ReturnType<typeof mock.fn<ioBroker.StateChangeHandler>>;

        beforeEach(async () => {
            await connect();
            socket.respond('getForeignStates', () => [null, {}]);
            handler = mock.fn<ioBroker.StateChangeHandler>();
            conn.setStateToIgnore(IGNORED);
        });

        it('does not subscribe or unsubscribe the ignored state at the server', async () => {
            await conn.subscribeState(IGNORED, handler);
            conn.unsubscribeState(IGNORED, handler);

            assert.equal(socket.requestsOf('subscribe').length, 0);
            assert.equal(socket.requestsOf('unsubscribe').length, 0);
        });

        it('does not subscribe the ignored state given in an array at the server', async () => {
            await conn.subscribeState([IGNORED, 'a.0.x'], handler);

            assert.deepEqual(idsOf('subscribe'), ['a.0.x']);
        });

        it('sets the ignored state locally and informs its handlers', async () => {
            await conn.subscribeState(IGNORED, handler);
            socket.clearRequests();

            await conn.setState(IGNORED, 'widget1');

            assert.equal(socket.requests.length, 0);
            assert.equal(handler.mock.callCount(), 1);
            const [id, state] = handler.mock.calls[0].arguments;
            assert.equal(id, IGNORED);
            assert.equal(state?.val, 'widget1');
            assert.equal(state?.ack, false);
            assert.equal(state?.from, 'system.adapter.vis.0');
            assert.equal(typeof state?.ts, 'number');
            assert.equal(await conn.getState(IGNORED), state);
            assert.equal(socket.requests.length, 0);
        });

        it('keeps the ack flag and a state object as given', async () => {
            await conn.setState(IGNORED, 5, true);
            assert.deepEqual(await conn.getState(IGNORED), { val: 5, ack: true });

            await conn.setState(IGNORED, STATE);
            assert.deepEqual(await conn.getState(IGNORED), STATE);

            assert.equal(socket.requests.length, 0);
        });

        it('has null as value of the ignored state before it was set', async () => {
            assert.deepEqual(await conn.getState(IGNORED), { val: null, ack: true });
            assert.equal(socket.requests.length, 0);
        });

        it('returns a placeholder as object of the ignored state', async () => {
            const obj = await conn.getObject(IGNORED);

            assert.equal(obj?._id, IGNORED);
            assert.equal(obj?.type, 'state');
            assert.equal(socket.requests.length, 0);
        });

        it('sets the ignored state to null', async () => {
            await conn.setState(IGNORED, null);

            assert.equal((await conn.getState(IGNORED))?.val, null);
        });
    });

    describe('getStates, getState and setState', () => {
        beforeEach(() => connect());

        it('getStates reads the states of a pattern', async () => {
            const promise = conn.getStates('a.0.*');

            assert.deepEqual(argsOf('getStates'), [['a.0.*']]);
            socket.lastAnswer('getStates')(null, { 'a.0.x': STATE });
            assert.deepEqual(await promise, { 'a.0.x': STATE });
        });

        it('getStates reads the states of an array of ids', async () => {
            const promise = conn.getStates(['a.0.x', 'a.0.y']);

            assert.deepEqual(argsOf('getStates'), [[['a.0.x', 'a.0.y']]]);
            socket.lastAnswer('getStates')(null, { 'a.0.x': STATE });
            assert.deepEqual(await promise, { 'a.0.x': STATE });
        });

        it('getStates resolves with an empty object for a missing answer', async () => {
            const promise = conn.getStates();
            socket.lastAnswer('getStates')(null);

            assert.deepEqual(await promise, {});
        });

        it('getStates rejects with the error of the server', async () => {
            const promise = conn.getStates('a.0.*');
            socket.lastAnswer('getStates')('permissionError');

            await assert.rejects(promise, error => error === 'permissionError');
        });

        it('getState reads one state', async () => {
            const promise = conn.getState('a.0.x');

            assert.deepEqual(argsOf('getState'), [['a.0.x']]);
            socket.lastAnswer('getState')(null, STATE);
            assert.deepEqual(await promise, STATE);
        });

        it('getState resolves with null for a missing state', async () => {
            const promise = conn.getState('a.0.x');
            socket.lastAnswer('getState')(null, null);

            assert.equal(await promise, null);
        });

        it('getState rejects with the error of the server', async () => {
            const promise = conn.getState('a.0.x');
            socket.lastAnswer('getState')('permissionError');

            await assert.rejects(promise, error => error === 'permissionError');
        });

        it('setState sends a value as it is', async () => {
            const promise = conn.setState('a.0.x', 5);

            assert.deepEqual(argsOf('setState'), [['a.0.x', 5]]);
            socket.lastAnswer('setState')(null);
            await promise;
        });

        it('setState makes a state of the value and the ack flag', async () => {
            socket.respond('setState', () => [null]);

            await conn.setState('a.0.x', 5, true);
            await conn.setState('a.0.x', 'text', false);

            assert.deepEqual(argsOf('setState'), [
                ['a.0.x', { val: 5, ack: true }],
                ['a.0.x', { val: 'text', ack: false }],
            ]);
        });

        it('setState sends a state as it is', async () => {
            socket.respond('setState', () => [null]);

            await conn.setState('a.0.x', { val: 1, ack: true, c: 'comment' });

            assert.deepEqual(argsOf('setState'), [['a.0.x', { val: 1, ack: true, c: 'comment' }]]);
        });

        it('setState rejects with the error of the server', async () => {
            const promise = conn.setState('a.0.x', 5);
            socket.lastAnswer('setState')('permissionError');

            await assert.rejects(promise, error => error === 'permissionError');
        });

        it('rejects the requests while disconnected', async () => {
            socket.fire('disconnect');

            await Promise.all([
                assert.rejects(conn.getStates('a.0.*'), { message: ERRORS.NOT_CONNECTED }),
                assert.rejects(conn.getState('a.0.x'), { message: ERRORS.NOT_CONNECTED }),
                assert.rejects(conn.setState('a.0.x', 1), { message: ERRORS.NOT_CONNECTED }),
            ]);
            assert.equal(socket.requests.length, 0);
        });
    });

    describe('getBinaryState and setBinaryState', () => {
        beforeEach(() => connect());

        it('getBinaryState resolves with the Base64 value', async () => {
            const promise = conn.getBinaryState('a.0.bin');

            assert.deepEqual(argsOf('getBinaryState'), [['a.0.bin']]);
            socket.lastAnswer('getBinaryState')(null, 'AAEC');
            assert.equal(await promise, 'AAEC');
        });

        it('getBinaryState rejects with the error of the server', async () => {
            const promise = conn.getBinaryState('a.0.bin');
            socket.lastAnswer('getBinaryState')('permissionError');

            await assert.rejects(promise, error => error === 'permissionError');
        });

        it('setBinaryState sends the Base64 value', async () => {
            const promise = conn.setBinaryState('a.0.bin', 'AAEC');

            assert.deepEqual(argsOf('setBinaryState'), [['a.0.bin', 'AAEC']]);
            socket.lastAnswer('setBinaryState')(null);
            await promise;
        });

        it('setBinaryState rejects with the error of the server', async () => {
            const promise = conn.setBinaryState('a.0.bin', 'AAEC');
            socket.lastAnswer('setBinaryState')('permissionError');

            await assert.rejects(promise, error => error === 'permissionError');
        });

        it('rejects the requests while disconnected', async () => {
            socket.fire('disconnect');

            await Promise.all([
                assert.rejects(conn.getBinaryState('a.0.bin'), { message: ERRORS.NOT_CONNECTED }),
                assert.rejects(conn.setBinaryState('a.0.bin', 'AAEC'), { message: ERRORS.NOT_CONNECTED }),
            ]);
            assert.equal(socket.requests.length, 0);
        });
    });

    describe('subscribeObject and unsubscribeObject', () => {
        let handler: ReturnType<typeof mock.fn<ObjectChangeHandler>>;

        beforeEach(async () => {
            await connect();
            handler = mock.fn<ObjectChangeHandler>();
        });

        it('subscribes only new ids at the server and does not read the objects', async () => {
            await conn.subscribeObject('a.0.x', handler);
            await conn.subscribeObject(['a.0.x', 'a.0.*'], mock.fn());

            assert.deepEqual(argsOf('subscribeObjects'), [[['a.0.x']], [['a.0.*']]]);
            assert.equal(socket.requestsOf('getObject').length, 0);
            assert.equal(handler.mock.callCount(), 0);
        });

        it('throws when the handler is not a function', () => {
            assert.throws(() => conn.subscribeObject('a.0.x', undefined as any), /must be a function/);
            assert.equal(socket.requests.length, 0);
        });

        it('only registers the handler while disconnected', async () => {
            socket.fire('disconnect');

            await conn.subscribeObject('a.0.x', handler);

            assert.equal(socket.requests.length, 0);
        });

        it('unsubscribes at the server only the ids without remaining handlers', async () => {
            const other = mock.fn<ObjectChangeHandler>();
            await conn.subscribeObject(['a.0.x', 'a.0.y'], handler);
            await conn.subscribeObject('a.0.x', other);
            socket.clearRequests();

            await conn.unsubscribeObject(['a.0.x', 'a.0.y', 'a.0.unknown'], handler);

            assert.deepEqual(argsOf('unsubscribeObjects'), [[['a.0.y']]]);
            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x'));
            assert.equal(handler.mock.callCount(), 0);
            assert.equal(other.mock.callCount(), 1);
        });

        it('removes all handlers of an id without a handler argument', async () => {
            await conn.subscribeObject('a.0.x', handler);
            await conn.subscribeObject('a.0.x', mock.fn());
            socket.clearRequests();

            await conn.unsubscribeObject('a.0.x');

            assert.deepEqual(argsOf('unsubscribeObjects'), [[['a.0.x']]]);
            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x'));
            assert.equal(handler.mock.callCount(), 0);
        });

        it('ignores unknown handlers', async () => {
            await conn.subscribeObject('a.0.x', handler);
            socket.clearRequests();

            await conn.unsubscribeObject('a.0.x', mock.fn<ObjectChangeHandler>());

            assert.equal(socket.requests.length, 0);
            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x'));
            assert.equal(handler.mock.callCount(), 1);
        });

        it('does not unsubscribe while disconnected', async () => {
            await conn.subscribeObject('a.0.x', handler);
            socket.clearRequests();
            socket.fire('disconnect');

            await conn.unsubscribeObject('a.0.x', handler);

            assert.equal(socket.requests.length, 0);
        });
    });

    describe('objectChange', () => {
        let handler: ReturnType<typeof mock.fn<ObjectChangeHandler>>;
        let onObjectChange: ReturnType<typeof mock.fn<ioBroker.ObjectChangeHandler>>;

        beforeEach(async () => {
            onObjectChange = mock.fn<ioBroker.ObjectChangeHandler>();
            await connect({ onObjectChange });
            handler = mock.fn<ObjectChangeHandler>();
        });

        it('calls the handlers of the id and of matching patterns after the current event', async () => {
            const pattern = mock.fn<ObjectChangeHandler>();
            const other = mock.fn<ObjectChangeHandler>();
            await conn.subscribeObject('a.0.x', handler);
            await conn.subscribeObject('a.0.*', pattern);
            await conn.subscribeObject(['b.*', 'a.0.xy'], other);
            const obj = stateObject('a.0.x');

            socket.fire('objectChange', 'a.0.x', obj);
            assert.equal(handler.mock.callCount(), 0);
            mock.timers.tick(0);

            assert.deepEqual(handler.mock.calls[0].arguments, ['a.0.x', obj, undefined]);
            assert.deepEqual(pattern.mock.calls[0].arguments, ['a.0.x', obj, undefined]);
            assert.equal(other.mock.callCount(), 0);
        });

        it('adds a new object to the cache and informs onObjectChange', async () => {
            const obj = stateObject('a.0.x');

            serverEvent('objectChange', 'a.0.x', obj);

            assert.equal((await conn.getObjects())['a.0.x'], obj);
            assert.deepEqual(onObjectChange.mock.calls[0].arguments, ['a.0.x', obj]);
            assert.equal(socket.requests.length, 0);
        });

        it('passes the id and the type of the cached object as old object', async () => {
            await conn.subscribeObject(['a.0.x', 'system.config'], handler);

            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x'));
            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x', { type: 'channel' }));
            serverEvent('objectChange', 'system.config', stateObject('system.config', { type: 'config' }));

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments[2]),
                [undefined, { _id: 'a.0.x', type: 'state' }, { _id: 'system.config', type: 'config' }],
            );
        });

        it('informs onObjectChange only about real changes', async () => {
            await conn.subscribeObject('a.0.x', handler);

            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x'));
            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x'));

            assert.equal(handler.mock.callCount(), 2);
            assert.equal(onObjectChange.mock.callCount(), 1);
        });

        it('takes a new _rev into the cache without calling it a change', async () => {
            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x', { _rev: '1' }));
            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x', { _rev: '2' }));

            assert.equal(onObjectChange.mock.callCount(), 1);
            assert.equal(((await conn.getObjects())['a.0.x'] as any)._rev, '2');
        });

        it('removes a deleted object from the cache', async () => {
            await conn.subscribeObject('a.0.x', handler);
            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x'));

            serverEvent('objectChange', 'a.0.x', null);

            assert.deepEqual(handler.mock.calls[1].arguments, ['a.0.x', null, { _id: 'a.0.x', type: 'state' }]);
            assert.equal('a.0.x' in (await conn.getObjects()), false);
            assert.deepEqual(onObjectChange.mock.calls[1].arguments, ['a.0.x', null]);
        });

        it('does not inform onObjectChange about the deletion of an unknown object', async () => {
            await conn.subscribeObject('a.0.x', handler);

            serverEvent('objectChange', 'a.0.x', null);

            assert.deepEqual(handler.mock.calls[0].arguments, ['a.0.x', null, undefined]);
            assert.equal(onObjectChange.mock.callCount(), 0);
        });

        it('calls the other handlers when one throws or rejects', async () => {
            await conn.subscribeObject('a.0.x', () => {
                throw new Error('thrown');
            });
            await conn.subscribeObject('a.0.x', () => Promise.reject(new Error('rejected')));
            await conn.subscribeObject('a.0.x', handler);

            serverEvent('objectChange', 'a.0.x', stateObject('a.0.x'));
            await flush();

            assert.equal(handler.mock.callCount(), 1);
            assert.deepEqual(
                consoleError.mock.calls.map(call => /thrown|rejected/.exec(String(call.arguments[0]))?.[0]),
                ['thrown', 'rejected'],
            );
        });
    });

    describe('subscribeFiles and unsubscribeFiles', () => {
        let handler: ReturnType<typeof mock.fn<FileChangeHandler>>;

        beforeEach(async () => {
            await connect();
            handler = mock.fn<FileChangeHandler>();
        });

        it('subscribes only the new file patterns of an id at the server', async () => {
            await conn.subscribeFiles('vis.0', 'main/*', handler);
            await conn.subscribeFiles('vis.0', ['main/*', 'other/*'], mock.fn());
            await conn.subscribeFiles('vis.1', 'main/*', handler);

            assert.deepEqual(argsOf('subscribeFiles'), [
                ['vis.0', ['main/*']],
                ['vis.0', ['other/*']],
                ['vis.1', ['main/*']],
            ]);
        });

        it('rejects a handler that is not a function', async () => {
            await assert.rejects(conn.subscribeFiles('vis.0', 'main/*', undefined as any), /must be a function/);
            assert.equal(socket.requests.length, 0);
        });

        it('only registers the handler while disconnected', async () => {
            socket.fire('disconnect');

            await conn.subscribeFiles('vis.0', 'main/*', handler);

            assert.equal(socket.requests.length, 0);
        });

        it('calls the handlers of the id and the file pattern after the current event', async () => {
            await conn.subscribeFiles('vis.0', 'main/*', handler);

            socket.fire('fileChange', 'vis.0', 'main/vis-views.json', 100);
            assert.equal(handler.mock.callCount(), 0);
            mock.timers.tick(0);
            serverEvent('fileChange', 'vis.0', 'main/deleted.json', null);
            serverEvent('fileChange', 'vis.0', 'other/vis-views.json', 100);
            serverEvent('fileChange', 'vis.1', 'main/vis-views.json', 100);

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments),
                [
                    ['vis.0', 'main/vis-views.json', 100],
                    ['vis.0', 'main/deleted.json', null],
                ],
            );
        });

        it('matches patterns of the id and exact file names', async () => {
            const exact = mock.fn<FileChangeHandler>();
            await conn.subscribeFiles('vis*', '*.json', handler);
            await conn.subscribeFiles('vis.0', 'main/vis-views.json', exact);

            serverEvent('fileChange', 'vis.0', 'main/vis-views.json', 1);
            serverEvent('fileChange', 'vis-2.0', 'a.json', 2);
            serverEvent('fileChange', 'vis.0', 'main/vis-views.json.bak', 3);
            serverEvent('fileChange', 'vis.0', 'main/vis-viewsXjson', 4);
            serverEvent('fileChange', 'web.0', 'a.json', 5);

            assert.deepEqual(
                handler.mock.calls.map(call => call.arguments[2]),
                [1, 2],
            );
            assert.deepEqual(
                exact.mock.calls.map(call => call.arguments[2]),
                [1],
            );
        });

        it('calls the other handlers when one throws', async () => {
            await conn.subscribeFiles('vis.0', 'main/*', () => {
                throw new Error('failed');
            });
            await conn.subscribeFiles('vis.0', 'main/*', handler);

            serverEvent('fileChange', 'vis.0', 'main/vis-views.json', 100);

            assert.equal(handler.mock.callCount(), 1);
            assert.match(String(consoleError.mock.calls[0].arguments[0]), /failed/);
        });

        it('unsubscribes at the server only the patterns without remaining handlers', async () => {
            const other = mock.fn<FileChangeHandler>();
            await conn.subscribeFiles('vis.0', ['main/*', 'other/*'], handler);
            await conn.subscribeFiles('vis.0', 'main/*', other);
            socket.clearRequests();

            conn.unsubscribeFiles('vis.0', ['main/*', 'other/*', 'unknown/*'], handler);

            assert.deepEqual(argsOf('unsubscribeFiles'), [['vis.0', ['other/*']]]);
            serverEvent('fileChange', 'vis.0', 'main/vis-views.json', 100);
            assert.equal(handler.mock.callCount(), 0);
            assert.equal(other.mock.callCount(), 1);
        });

        it('removes all handlers of a pattern without a handler argument', async () => {
            await conn.subscribeFiles('vis.0', 'main/*', handler);
            await conn.subscribeFiles('vis.0', 'main/*', mock.fn());
            socket.clearRequests();

            conn.unsubscribeFiles('vis.0', 'main/*');

            assert.deepEqual(argsOf('unsubscribeFiles'), [['vis.0', ['main/*']]]);
            serverEvent('fileChange', 'vis.0', 'main/vis-views.json', 100);
            assert.equal(handler.mock.callCount(), 0);
        });

        it('does not unsubscribe while disconnected', async () => {
            await conn.subscribeFiles('vis.0', 'main/*', handler);
            socket.clearRequests();
            socket.fire('disconnect');

            conn.unsubscribeFiles('vis.0', 'main/*', handler);

            assert.equal(socket.requests.length, 0);
        });
    });

    describe('subscriptions at the login', () => {
        const noop = (): void => {};

        it('sends the subscriptions that were made before the login', async () => {
            ({ conn, socket } = await createConnection(Connection));
            await conn.subscribeState(['a.0.x', 'a.0.*'], noop);
            await conn.subscribeObject('b.0.x', noop);
            await conn.subscribeFiles('vis.0', ['main/*', 'other/*'], noop);
            assert.equal(socket.requests.length, 0);

            await login(conn, socket);

            assert.deepEqual(idsOf('subscribe').sort(), ['a.0.*', 'a.0.x']);
            assert.deepEqual([...new Set(idsOf('subscribeObjects'))], ['b.0.x']);
            assert.deepEqual(filesOf('subscribeFiles'), [
                ['vis.0', 'main/*'],
                ['vis.0', 'other/*'],
            ]);
        });

        it('subscribes the objects of autoSubscribes and the log if autoSubscribeLog is set', async () => {
            ({ conn, socket } = await createConnection(Connection, {
                autoSubscribes: ['system.adapter.*', 'script.js.*'],
                autoSubscribeLog: true,
            }));

            await login(conn, socket);

            assert.deepEqual(idsOf('subscribeObjects'), ['system.adapter.*', 'script.js.*']);
            assert.deepEqual(argsOf('requireLog'), [[true]]);
        });

        it('subscribes nothing without subscriptions', async () => {
            ({ conn, socket } = await createConnection(Connection));

            await login(conn, socket);

            for (const name of ['subscribe', 'subscribeObjects', 'subscribeFiles', 'requireLog']) {
                assert.equal(socket.requestsOf(name).length, 0, name);
            }
        });
    });

    describe('subscriptions after a reconnect', () => {
        let handler: ReturnType<typeof mock.fn<ioBroker.StateChangeHandler>>;

        beforeEach(async () => {
            await connect({ autoSubscribes: ['system.adapter.*'], autoSubscribeLog: true });
            socket.respond('getForeignStates', () => [null, {}]);
            handler = mock.fn<ioBroker.StateChangeHandler>();
            await conn.subscribeState(['a.0.x', 'a.0.*'], handler);
            await conn.subscribeObject(['b.0.x', 'b.0.y'], () => {});
            await conn.subscribeFiles('vis.0', 'main/*', () => {});
            socket.clearRequests();
        });

        function assertSubscribedAgain(): void {
            assert.deepEqual(idsOf('subscribe').sort(), ['a.0.*', 'a.0.x']);
            assert.deepEqual([...new Set(idsOf('subscribeObjects'))].sort(), ['b.0.x', 'b.0.y', 'system.adapter.*']);
            assert.deepEqual(filesOf('subscribeFiles'), [['vis.0', 'main/*']]);
            assert.deepEqual(argsOf('requireLog'), [[true]]);
        }

        it('sends nothing on the disconnect', () => {
            socket.fire('disconnect');

            assert.equal(socket.requests.length, 0);
        });

        it('subscribes everything again after the new connect', async () => {
            await reconnect();

            assertSubscribedAgain();
        });

        it('subscribes everything again on "reconnect"', () => {
            socket.fire('disconnect');
            socket.fire('reconnect');

            assertSubscribedAgain();
        });

        it('subscribes each object only once', async () => {
            await reconnect();

            assert.deepEqual(idsOf('subscribeObjects').sort(), ['b.0.x', 'b.0.y', 'system.adapter.*']);
        });

        it('does not subscribe again without a disconnect in between', async () => {
            socket.fire('reconnect');
            socket.fire('connect', true);
            await flush();

            assert.equal(socket.requestsOf('subscribe').length, 0);
            assert.equal(socket.requestsOf('subscribeObjects').length, 0);
            assert.equal(socket.requestsOf('subscribeFiles').length, 0);
        });

        it('keeps the handlers over a reconnect', async () => {
            await reconnect();

            serverEvent('stateChange', 'a.0.y', STATE);

            assert.deepEqual(handler.mock.calls[0].arguments, ['a.0.y', STATE]);
        });

        it('does not subscribe the ignored state at the server', async () => {
            conn.setStateToIgnore(IGNORED);
            await conn.subscribeState(IGNORED, handler);

            await reconnect();

            assert.equal(idsOf('subscribe').includes(IGNORED), false);
        });
    });

    describe('requireLog', () => {
        let onLog: ReturnType<typeof mock.fn<(message: LogMessage) => void>>;

        beforeEach(async () => {
            onLog = mock.fn<(message: LogMessage) => void>();
            await connect({ onLog });
        });

        it('switches the log on and off', async () => {
            socket.respond('requireLog', () => [null]);

            await conn.requireLog(true);
            await conn.requireLog(false);

            assert.deepEqual(argsOf('requireLog'), [[true], [false]]);
        });

        it('rejects with the error of the server', async () => {
            const promise = conn.requireLog(true);
            socket.lastAnswer('requireLog')('permissionError');

            await assert.rejects(promise, error => error === 'permissionError');
        });

        it('rejects while disconnected', async () => {
            socket.fire('disconnect');

            await assert.rejects(conn.requireLog(true), { message: ERRORS.NOT_CONNECTED });
            assert.equal(socket.requests.length, 0);
        });

        it('passes the log messages to onLog and the registered handlers', () => {
            const handler = mock.fn<(message: LogMessage) => void>();
            const message: LogMessage = { message: 'text', from: 'host', ts: 1, severity: 'info', _id: 1 };
            conn.registerLogHandler(handler);

            socket.fire('log', message);
            conn.unregisterLogHandler(handler);
            socket.fire('log', message);

            assert.equal(onLog.mock.callCount(), 2);
            assert.deepEqual(handler.mock.calls[0].arguments, [message]);
            assert.equal(handler.mock.callCount(), 1);
        });
    });

    describe('subscribeOnInstance', () => {
        let callback: ReturnType<typeof mock.fn<InstanceMessageCallback>>;

        beforeEach(async () => {
            await connect();
            callback = mock.fn<InstanceMessageCallback>();
        });

        /** Subscribes and lets the instance accept */
        async function subscribe(
            cb: InstanceMessageCallback,
            messageType = MESSAGE_TYPE,
            instance = 'cameras.0',
        ): Promise<void> {
            const promise = conn.subscribeOnInstance(instance, messageType, null, cb);
            socket.lastAnswer('clientSubscribe')(null, { accepted: true, heartbeat: 30000 });
            await promise;
        }

        it('asks the instance and resolves with its answer', async () => {
            const promise = conn.subscribeOnInstance('cameras.0', MESSAGE_TYPE, { width: 640 }, callback);

            assert.deepEqual(argsOf('clientSubscribe'), [['cameras.0', MESSAGE_TYPE, { width: 640 }]]);
            socket.lastAnswer('clientSubscribe')(null, { accepted: true, heartbeat: 30000 });
            assert.deepEqual(await promise, { accepted: true, heartbeat: 30000 });
        });

        it('passes the messages of the type from the instance to the callback after the current event', async () => {
            await subscribe(callback);

            socket.fire('im', MESSAGE_TYPE, INSTANCE, { image: 'data' });
            assert.equal(callback.mock.callCount(), 0);
            mock.timers.tick(0);
            serverEvent('im', 'stopCamera/cam3', INSTANCE, 1);
            serverEvent('im', MESSAGE_TYPE, 'system.adapter.cameras.1', 2);

            assert.deepEqual(
                callback.mock.calls.map(call => call.arguments),
                [[{ image: 'data' }, INSTANCE, MESSAGE_TYPE]],
            );
        });

        it('accepts the instance with "system.adapter." in front', async () => {
            await subscribe(callback, MESSAGE_TYPE, INSTANCE);

            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);

            assert.equal(socket.lastRequest('clientSubscribe').args[0], INSTANCE);
            assert.equal(callback.mock.callCount(), 1);
        });

        it('registers a callback for a type only once, but different callbacks each', async () => {
            const other = mock.fn<InstanceMessageCallback>();
            await subscribe(callback);
            await subscribe(callback);
            await subscribe(other);

            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);

            assert.equal(callback.mock.callCount(), 1);
            assert.equal(other.mock.callCount(), 1);
        });

        it('rejects with the error of the server and registers nothing', async () => {
            const promise = conn.subscribeOnInstance('cameras.0', MESSAGE_TYPE, null, callback);
            socket.lastAnswer('clientSubscribe')('permissionError');

            await assert.rejects(promise, error => error === 'permissionError');
            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);
            assert.equal(callback.mock.callCount(), 0);
        });

        it('rejects with the error of the instance and registers nothing', async () => {
            const promise = conn.subscribeOnInstance('cameras.0', MESSAGE_TYPE, null, callback);
            socket.lastAnswer('clientSubscribe')(null, { error: 'Unknown camera' });

            await assert.rejects(promise, error => error === 'Unknown camera');
            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);
            assert.equal(callback.mock.callCount(), 0);
        });

        it('settles when the instance answers without a result', async () => {
            const promise = track(conn.subscribeOnInstance('cameras.0', MESSAGE_TYPE, null, callback));

            socket.lastAnswer('clientSubscribe')(null, null);
            await flush();

            assert.equal(promise.settled, true);
        });

        it('rejects while disconnected', async () => {
            socket.fire('disconnect');

            await assert.rejects(conn.subscribeOnInstance('cameras.0', MESSAGE_TYPE, null, callback), {
                message: ERRORS.NOT_CONNECTED,
            });
            assert.equal(socket.requests.length, 0);
        });

        it('catches the rejection of an async callback', async () => {
            await subscribe(() => Promise.reject(new Error('failed')));

            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);
            await flush();

            assert.match(String(consoleError.mock.calls[0].arguments[0]), /Cannot call instance message handler/);
        });

        it('calls the other callbacks when one throws', async () => {
            await subscribe(() => {
                throw new Error('failed');
            });
            await subscribe(callback);

            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);

            assert.equal(callback.mock.callCount(), 1);
        });

        it('keeps the callbacks over a reconnect', async () => {
            await subscribe(callback);

            await reconnect();
            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);

            assert.equal(callback.mock.callCount(), 1);
        });
    });

    describe('unsubscribeFromInstance', () => {
        let callback: ReturnType<typeof mock.fn<InstanceMessageCallback>>;
        let other: ReturnType<typeof mock.fn<InstanceMessageCallback>>;

        beforeEach(async () => {
            await connect();
            socket.respond('clientSubscribe', () => [null, { accepted: true }]);
            callback = mock.fn<InstanceMessageCallback>();
            other = mock.fn<InstanceMessageCallback>();
            await conn.subscribeOnInstance('cameras.0', MESSAGE_TYPE, null, callback);
            await conn.subscribeOnInstance('cameras.0', MESSAGE_TYPE, null, other);
            socket.clearRequests();
        });

        it('unsubscribes at the instance when the last callback of the type is removed', async () => {
            assert.equal(await conn.unsubscribeFromInstance('cameras.0', MESSAGE_TYPE, callback), false);
            assert.equal(socket.requests.length, 0);

            const promise = conn.unsubscribeFromInstance('cameras.0', MESSAGE_TYPE, other);

            assert.deepEqual(argsOf('clientUnsubscribe'), [[INSTANCE, MESSAGE_TYPE]]);
            socket.lastAnswer('clientUnsubscribe')(null, true);
            assert.equal(await promise, true);
        });

        it('passes no more messages to a removed callback', async () => {
            await conn.unsubscribeFromInstance(INSTANCE, MESSAGE_TYPE, callback);

            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);

            assert.equal(callback.mock.callCount(), 0);
            assert.equal(other.mock.callCount(), 1);
        });

        it('resolves with false for an unknown subscription', async () => {
            assert.equal(await conn.unsubscribeFromInstance('cameras.1', MESSAGE_TYPE, callback), false);
            assert.equal(await conn.unsubscribeFromInstance('cameras.0', 'other', callback), false);
            assert.equal(await conn.unsubscribeFromInstance('cameras.0', MESSAGE_TYPE, mock.fn()), false);

            assert.equal(socket.requests.length, 0);
        });

        it('removes all callbacks of the type without a callback', async () => {
            socket.respond('clientUnsubscribe', () => [null, true]);

            assert.equal(await conn.unsubscribeFromInstance('cameras.0', MESSAGE_TYPE, undefined as any), true);

            assert.deepEqual(argsOf('clientUnsubscribe'), [[INSTANCE, MESSAGE_TYPE]]);
            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);
            assert.equal(callback.mock.callCount() + other.mock.callCount(), 0);
        });

        it('removes the callback of all types without a type', async () => {
            socket.respond('clientUnsubscribe', () => [null, true]);
            await conn.subscribeOnInstance('cameras.0', 'stopCamera/cam3', null, callback);
            socket.clearRequests();

            assert.equal(await conn.unsubscribeFromInstance('cameras.0', '', callback), true);

            assert.equal(socket.requestsOf('clientUnsubscribe').length, 1);
            serverEvent('im', MESSAGE_TYPE, INSTANCE, 1);
            serverEvent('im', 'stopCamera/cam3', INSTANCE, 2);
            assert.equal(callback.mock.callCount(), 0);
            assert.equal(other.mock.callCount(), 1);
        });

        it('unsubscribes each removed type at the instance', async () => {
            socket.respond('clientUnsubscribe', () => [null, true]);
            await conn.subscribeOnInstance('cameras.0', 'stopCamera/cam3', null, callback);
            await conn.unsubscribeFromInstance('cameras.0', MESSAGE_TYPE, other);
            socket.clearRequests();

            await conn.unsubscribeFromInstance('cameras.0', '', callback);

            assert.deepEqual(argsOf('clientUnsubscribe'), [
                [INSTANCE, MESSAGE_TYPE],
                [INSTANCE, 'stopCamera/cam3'],
            ]);
        });

        it('rejects with the error of the server', async () => {
            await conn.unsubscribeFromInstance('cameras.0', MESSAGE_TYPE, callback);

            const promise = conn.unsubscribeFromInstance('cameras.0', MESSAGE_TYPE, other);
            socket.lastAnswer('clientUnsubscribe')('permissionError');

            await assert.rejects(promise, error => error === 'permissionError');
        });
    });
});
