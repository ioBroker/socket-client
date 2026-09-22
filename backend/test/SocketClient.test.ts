import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it, mock, type Mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

import { SocketClient, type ConnectOptions } from '../src/socket.io';
import * as backend from '../src/index';

const MESSAGE = 0;
const PING = 1;
const PONG = 2;
const CALLBACK = 3;
const READY = [MESSAGE, 0, '___ready___'];

/** Waits until the condition is true and fails with a readable error after `ms` milliseconds */
async function until(condition: () => boolean, what: string, ms = 2000): Promise<void> {
    // performance.now(), because some tests mock Date
    const end = performance.now() + ms;
    while (!condition()) {
        if (performance.now() >= end) {
            throw new Error(`Timeout waiting for ${what}`);
        }
        await delay(5);
    }
}

/** A connection of the client as the server sees it */
class ServerConnection {
    readonly messages: unknown[][] = [];
    readonly query: URLSearchParams;
    /** Answers every ping of the client with a pong */
    answerPings = false;

    constructor(
        readonly ws: WebSocket,
        readonly path: string,
    ) {
        this.query = new URL(path, 'http://127.0.0.1').searchParams;
        ws.on('error', () => {});
        ws.on('message', data => {
            const message = JSON.parse((data as Buffer).toString());
            this.messages.push(message);
            if (this.answerPings && message[0] === PING) {
                this.send([PONG]);
            }
        });
    }

    get isOpen(): boolean {
        return this.ws.readyState === WebSocket.OPEN;
    }

    get isClosed(): boolean {
        return this.ws.readyState === WebSocket.CLOSED;
    }

    send(message: unknown[]): void {
        this.ws.send(JSON.stringify(message));
    }

    ready(): void {
        this.send(READY);
    }

    /** Resolves with the first message that matches the filter, also if it was received before */
    async message(filter: (message: unknown[]) => boolean, what: string): Promise<unknown[]> {
        await until(() => this.messages.some(filter), what);
        return this.messages.find(filter)!;
    }
}

type Handlers = Record<'connect' | 'reconnect' | 'disconnect' | 'error', Mock<(...args: any[]) => void>>;

/** WebSocket server on a random port, which speaks the protocol of ioBroker.ws */
class TestServer {
    readonly connections: ServerConnection[] = [];
    /** Sends the ready message to every new connection at once */
    sendReady = true;
    private stopped = false;

    private constructor(
        private readonly http: Server,
        private readonly wss: WebSocketServer,
    ) {
        wss.on('connection', (ws, request) => {
            const connection = new ServerConnection(ws, request.url || '');
            this.connections.push(connection);
            if (this.sendReady) {
                connection.ready();
            }
        });
    }

    static async start(): Promise<TestServer> {
        const http = createServer();
        const server = new TestServer(http, new WebSocketServer({ server: http }));
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', () => resolve()));
        return server;
    }

    get url(): string {
        return `http://127.0.0.1:${(this.http.address() as AddressInfo).port}/`;
    }

    /** Resolves with the n-th connection, 1 is the first one */
    async connection(n: number): Promise<ServerConnection> {
        await until(() => this.connections.length >= n, `connection ${n}`);
        return this.connections[n - 1];
    }

    async stop(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.wss.clients.forEach(ws => ws.terminate());
        this.wss.close();
        this.http.closeAllConnections();
        await new Promise(resolve => this.http.close(resolve));
    }
}

/** WebSocket of ws, which remembers the URLs it was created with. It connects wss URLs without TLS */
class RecordingWebSocket extends WebSocket {
    static urls: string[] = [];
    static sockets: RecordingWebSocket[] = [];

    constructor(url: string) {
        RecordingWebSocket.urls.push(url);
        super(url.replace(/^wss:/, 'ws:'));
        RecordingWebSocket.sockets.push(this);
    }
}

describe('SocketClient', () => {
    const clients: SocketClient[] = [];
    let server: TestServer;
    let consoleWarn: ReturnType<typeof mock.method>;
    let consoleError: ReturnType<typeof mock.method>;
    let markers = 0;

    /** Creates a client with spies as connect, reconnect, disconnect and error handlers and connects it */
    function connectClient(
        options: ConnectOptions = {},
        url = server.url,
    ): { client: SocketClient; handlers: Handlers } {
        const client = new SocketClient();
        clients.push(client);
        const handlers = { connect: mock.fn(), reconnect: mock.fn(), disconnect: mock.fn(), error: mock.fn() };
        Object.entries(handlers).forEach(([name, handler]) => client.on(name, handler));
        client.connect(url, { WebSocket, connectInterval: 10, ...options });
        return { client, handlers };
    }

    /** Connects a client and waits for the ready message */
    async function connectedClient(
        options: ConnectOptions = {},
    ): Promise<{ client: SocketClient; connection: ServerConnection; handlers: Handlers }> {
        const { client, handlers } = connectClient(options);
        const connection = await server.connection(1);
        await until(() => client.connected, 'the ready message');
        return { client, connection, handlers };
    }

    /** Sends an event and waits until the client got it, so all messages sent before are processed too */
    async function processed(client: SocketClient, connection: ServerConnection): Promise<void> {
        const name = `marker${++markers}`;
        const marker = mock.fn();
        client.on(name, marker);
        connection.send([MESSAGE, 0, name]);
        await until(() => marker.mock.callCount() > 0, 'the marker event');
        client.off(name, marker);
    }

    function logged(spy: ReturnType<typeof mock.method>, text: string): number {
        return spy.mock.calls.filter(call => String(call.arguments[0]).includes(text)).length;
    }

    function errors(handlers: Handlers): string[] {
        return handlers.error.mock.calls.map(call => String(call.arguments[0]));
    }

    before(() => {
        // The client logs every step
        mock.method(console, 'log', () => {});
        consoleWarn = mock.method(console, 'warn', () => {});
        consoleError = mock.method(console, 'error', () => {});
    });

    beforeEach(async () => {
        consoleWarn.mock.resetCalls();
        consoleError.mock.resetCalls();
        RecordingWebSocket.urls = [];
        RecordingWebSocket.sockets = [];
        server = await TestServer.start();
    });

    afterEach(async () => {
        clients.splice(0).forEach(client => client.destroy());
        await server.stop();
        mock.timers.reset();
    });

    after(async () => {
        // The client sockets of the last test log their close event a moment after the server stopped
        await delay(50);
        mock.restoreAll();
    });

    describe('connect', () => {
        it('connects with a new sid, the name and the token and without the hash', async () => {
            connectClient({ name: 'my app', token: 'abc.def' }, `${server.url}path?sid=123#hash`);

            const connection = await server.connection(1);

            assert.match(connection.path, /^\/path\?sid=\d+&name=my%20app&token=abc\.def$/);
            assert.notEqual(connection.query.get('sid'), '123');
        });

        it('keeps the other query parameters of the URL', async () => {
            connectClient({ name: 'option' }, `${server.url}?a=1&name=url`);

            const connection = await server.connection(1);

            assert.equal(connection.query.get('a'), '1');
            assert.deepEqual(connection.query.getAll('name'), ['url']);
        });

        it('replaces a sid without value and keeps a name without value of the URL', async () => {
            connectClient({ name: 'option' }, `${server.url}?sid&name=`);

            const connection = await server.connection(1);

            assert.equal(connection.query.getAll('sid').length, 1);
            assert.match(connection.query.get('sid') ?? '', /^\d+$/);
            assert.deepEqual(connection.query.getAll('name'), ['']);
        });

        it('connects to the ws URL of an http URL and to the wss URL of an https URL', async () => {
            const { client: http } = connectClient({ WebSocket: RecordingWebSocket });
            const { client: https } = connectClient(
                { WebSocket: RecordingWebSocket },
                server.url.replace(/^http:/, 'https:'),
            );

            await until(() => http.connected && https.connected, 'both connections');

            const host = new URL(server.url).host;
            assert.ok(RecordingWebSocket.urls[0].startsWith(`ws://${host}/?sid=`), RecordingWebSocket.urls[0]);
            assert.ok(RecordingWebSocket.urls[1].startsWith(`wss://${host}/?sid=`), RecordingWebSocket.urls[1]);
        });

        it('is connected only after the ready message and then calls the connect handlers with true', async () => {
            server.sendReady = false;
            const { client, handlers } = connectClient();
            const connection = await server.connection(1);

            await delay(20);
            assert.equal(client.connected, false);
            assert.equal(handlers.connect.mock.callCount(), 0);

            connection.ready();
            await until(() => client.connected, 'the ready message');

            assert.deepEqual(
                handlers.connect.mock.calls.map(call => call.arguments),
                [[true]],
            );
            assert.equal(handlers.reconnect.mock.callCount(), 0);
        });
    });

    describe('emit', () => {
        it('sends a message with and without arguments', async () => {
            const { client, connection } = await connectedClient();

            client.emit('noArgs');
            client.emit('withArgs', 1, 'two', { three: 3 });

            await until(() => connection.messages.length === 2, 'the messages');
            assert.deepEqual(connection.messages, [
                [MESSAGE, 1, 'noArgs'],
                [MESSAGE, 2, 'withArgs', [1, 'two', { three: 3 }]],
            ]);
        });

        it('routes the answers by id to the callbacks', async () => {
            const { client, connection } = await connectedClient();
            const first = mock.fn();
            const second = mock.fn();

            client.emit('getState', 'system.adapter.admin.0.alive', first);
            client.emit('getVersion', second);

            await until(() => connection.messages.length === 2, 'the requests');
            assert.deepEqual(connection.messages, [
                [CALLBACK, 1, 'getState', ['system.adapter.admin.0.alive']],
                [CALLBACK, 2, 'getVersion', []],
            ]);

            connection.send([CALLBACK, 2, 'getVersion', [null, '7.0.1', 'admin']]);
            connection.send([CALLBACK, 1, 'getState', [null, { val: true }]]);
            await until(() => first.mock.callCount() === 1, 'the answers');

            assert.deepEqual(
                first.mock.calls.map(call => call.arguments),
                [[null, { val: true }]],
            );
            assert.deepEqual(
                second.mock.calls.map(call => call.arguments),
                [[null, '7.0.1', 'admin']],
            );
        });

        it('ignores a second answer and answers with an unknown id', async () => {
            const { client, connection } = await connectedClient();
            const callback = mock.fn();
            client.emit('getState', 'id', callback);
            await connection.message(message => message[2] === 'getState', 'the request');

            connection.send([CALLBACK, 1, 'getState', ['first']]);
            connection.send([CALLBACK, 1, 'getState', ['second']]);
            connection.send([CALLBACK, 99, 'getState', ['unknown']]);
            await processed(client, connection);

            assert.deepEqual(
                callback.mock.calls.map(call => call.arguments),
                [['first']],
            );
        });

        it('queues emits before the ready message and sends them after it', async () => {
            server.sendReady = false;
            const { client } = connectClient();
            const callback = mock.fn();

            client.emit('first', 'x');
            client.emit('second', callback);
            const connection = await server.connection(1);
            await delay(20);
            assert.deepEqual(connection.messages, []);

            connection.ready();
            await until(() => connection.messages.length === 2, 'the queued messages');
            assert.deepEqual(connection.messages, [
                [MESSAGE, 1, 'first', ['x']],
                [CALLBACK, 2, 'second', []],
            ]);

            connection.send([CALLBACK, 2, 'second', ['answer']]);
            await until(() => callback.mock.callCount() === 1, 'the answer');
            assert.deepEqual(callback.mock.calls[0].arguments, ['answer']);
        });

        it('drops emits while the lost connection is established again', async () => {
            const { client, connection, handlers } = await connectedClient();
            server.sendReady = false;

            connection.ws.terminate();
            const second = await server.connection(2);
            client.emit('lost', 1);
            second.ready();
            await until(() => handlers.reconnect.mock.callCount() === 1, 'the reconnect');
            client.emit('after', 2);

            await second.message(message => message[2] === 'after', 'the emit after the reconnect');
            assert.deepEqual(second.messages, [[MESSAGE, 1, 'after', [2]]]);
            assert.equal(logged(consoleWarn, 'Not connected'), 1);
        });

        it('sends binary data of writeFile as base64', async () => {
            const { client, connection } = await connectedClient();

            client.emit('writeFile', 'vis.0', 'main/image.bin', Buffer.from([1, 2, 3]), () => {});
            client.emit('writeFile', 'vis.0', 'main/text.txt', 'text', () => {});

            await until(() => connection.messages.length === 2, 'the requests');
            assert.deepEqual(connection.messages, [
                [CALLBACK, 1, 'writeFile', ['vis.0', 'main/image.bin', 'AQID']],
                [CALLBACK, 2, 'writeFile', ['vis.0', 'main/text.txt', 'text']],
            ]);
        });
    });

    describe('answers without arguments', () => {
        it('calls the callback without arguments and keeps the connection', async () => {
            const { client, connection } = await connectedClient();
            const callback = mock.fn();

            client.emit('logout', callback);
            await connection.message(message => message[2] === 'logout', 'the request');
            // what the server sends if its callback is called without arguments
            connection.send([CALLBACK, 1, 'logout']);

            await until(() => callback.mock.callCount() === 1, 'the answer');
            assert.deepEqual(callback.mock.calls[0].arguments, []);
            assert.equal(client.connected, true);
        });
    });

    describe('events of the server', () => {
        it('calls the handlers of an event with its arguments', async () => {
            const { client, connection } = await connectedClient();
            const first = mock.fn();
            const second = mock.fn();
            client.on('stateChange', first);
            client.on('stateChange', second);

            connection.send([MESSAGE, 7, 'stateChange', ['system.adapter.admin.0.alive', { val: true }]]);

            await until(() => second.mock.callCount() === 1, 'the event');
            for (const handler of [first, second]) {
                assert.deepEqual(
                    handler.mock.calls.map(call => call.arguments),
                    [['system.adapter.admin.0.alive', { val: true }]],
                );
            }
        });

        it('calls the handlers without arguments when the event has none', async () => {
            const { client, connection } = await connectedClient();
            const handler = mock.fn();
            client.on('reauthenticate', handler);

            connection.send([MESSAGE, 8, 'reauthenticate']);

            await until(() => handler.mock.callCount() === 1, 'the event');
            assert.deepEqual(handler.mock.calls[0].arguments, []);
        });

        it('does not call an event handler removed by off()', async () => {
            const { client, connection } = await connectedClient();
            const removed = mock.fn();
            const kept = mock.fn();
            client.on('objectChange', removed);
            client.on('objectChange', kept);

            client.off('objectChange', removed);
            connection.send([MESSAGE, 9, 'objectChange', ['id', null]]);
            await until(() => kept.mock.callCount() === 1, 'the event');

            client.off('objectChange', kept);
            connection.send([MESSAGE, 10, 'objectChange', ['id', null]]);
            await processed(client, connection);

            assert.equal(removed.mock.callCount(), 0);
            assert.equal(kept.mock.callCount(), 1);
        });

        it('does not call connect and disconnect handlers removed by off()', async () => {
            server.sendReady = false;
            const { client, handlers } = connectClient();
            client.off('connect', handlers.connect);
            client.off('disconnect', handlers.disconnect);

            (await server.connection(1)).ready();
            await until(() => client.connected, 'the ready message');
            client.close(true);

            assert.equal(handlers.connect.mock.callCount(), 0);
            assert.equal(handlers.disconnect.mock.callCount(), 0);
        });

        it('ignores invalid messages', async () => {
            const { client, connection } = await connectedClient();
            const handler = mock.fn();
            client.on('valid', handler);

            connection.ws.send('no json');
            connection.ws.send(Buffer.from([1, 2, 3]));
            connection.send([7, 1, 'valid', ['unknown type']]);
            connection.send([MESSAGE, 2, 'valid', ['ok']]);

            await until(() => handler.mock.callCount() === 1, 'the valid message');
            assert.deepEqual(handler.mock.calls[0].arguments, ['ok']);
            assert.equal(logged(consoleError, 'Received invalid message'), 2);
            assert.equal(logged(consoleWarn, 'Received unknown message type: 7'), 1);
            assert.equal(client.connected, true);
        });

        it('ignores a message that is valid JSON but no array', async () => {
            const { client } = connectClient({ WebSocket: RecordingWebSocket });
            await until(() => client.connected, 'the ready message');

            // Sending "null" from the server would crash the whole test process, so the message is emitted locally
            assert.doesNotThrow(() => RecordingWebSocket.sockets[0].emit('message', Buffer.from('null'), false));
            assert.equal(client.connected, true);
        });
    });

    describe('ping and pong', () => {
        it('answers the ping of the server with a pong', async () => {
            const { connection } = await connectedClient();

            connection.send([PING]);

            assert.deepEqual(await connection.message(message => message[0] === PONG, 'the pong'), [PONG]);
        });

        it('sends pings and keeps the connection while the server answers them', async () => {
            mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
            const { client, connection, handlers } = await connectedClient({ pingInterval: 20, pongTimeout: 100 });
            connection.answerPings = true;
            const pings = (): number => connection.messages.filter(message => message[0] === PING).length;
            // Every message counts as pong for the client, so no other message may be sent here
            const lastPong = (): number => (client as unknown as { lastPong: number }).lastPong;

            // 10 intervals are twice the pong timeout: without the pongs the client would close the connection
            for (let i = 1; i <= 10; i++) {
                mock.timers.tick(20);
                await until(() => pings() >= i, `ping ${i}`);
                await until(() => lastPong() === Date.now(), `pong ${i}`);
            }

            assert.equal(pings(), 10);
            assert.equal(handlers.disconnect.mock.callCount(), 0);
            assert.equal(server.connections.length, 1);
            assert.equal(connection.isOpen, true);
        });

        it('reconnects when the server does not answer the pings within pongTimeout', async () => {
            const { connection, handlers } = await connectedClient({ pingInterval: 20, pongTimeout: 100 });

            await until(() => connection.isClosed, 'the close after the pong timeout');

            assert.ok(connection.messages.some(message => message[0] === PING));
            assert.ok(handlers.disconnect.mock.callCount() >= 1);
            await until(() => handlers.reconnect.mock.callCount() >= 1, 'the reconnect');
        });
    });

    describe('reconnect', () => {
        it('calls the disconnect handlers, reconnects with a new sid and then calls the reconnect handlers', async () => {
            const { connection, handlers } = await connectedClient();

            connection.ws.close();
            const second = await server.connection(2);
            await until(() => handlers.reconnect.mock.callCount() === 1, 'the reconnect');

            assert.equal(handlers.disconnect.mock.callCount(), 1);
            assert.deepEqual(
                handlers.connect.mock.calls.map(call => call.arguments),
                [[true]],
            );
            assert.deepEqual(
                handlers.reconnect.mock.calls.map(call => call.arguments),
                [[true]],
            );
            assert.notEqual(second.query.get('sid'), connection.query.get('sid'));
        });

        it('reconnects when no ready message arrives within connectTimeout', async () => {
            server.sendReady = false;
            const { client, handlers } = connectClient({ connectTimeout: 100 });
            const first = await server.connection(1);
            server.sendReady = true;

            await until(() => first.isClosed, 'the close after the connect timeout');
            await until(() => client.connected, 'the ready message of the next connection');

            assert.deepEqual(
                handlers.connect.mock.calls.map(call => call.arguments),
                [[true]],
            );
        });

        it('reconnects after close() without noReconnect', async () => {
            const { client, connection, handlers } = await connectedClient();

            client.close();

            assert.equal(client.connected, false);
            assert.equal(handlers.disconnect.mock.callCount(), 1);
            await until(() => connection.isClosed, 'the close');
            await until(() => client.connected && handlers.reconnect.mock.callCount() >= 1, 'the reconnect');
        });

        it('keeps the new connection when the old one finishes closing after the reconnect', async () => {
            const { client, connection, handlers } = await connectedClient();
            // The server reads the close frame of the client only after the reconnect
            connection.ws.pause();

            client.close();
            const second = await server.connection(2);
            await until(() => handlers.reconnect.mock.callCount() === 1, 'the reconnect');
            connection.ws.resume();
            await until(() => connection.isClosed, 'the close of the first connection');
            await delay(50);

            assert.equal(second.isOpen, true);
            assert.equal(client.connected, true);
            assert.equal(handlers.disconnect.mock.callCount(), 1);
        });

        it('gives up after connectMaxAttempt failed attempts and reports it to the error handlers', async () => {
            const { client, handlers } = await connectedClient({ WebSocket: RecordingWebSocket, connectMaxAttempt: 3 });

            await server.stop();
            await until(() => errors(handlers).includes('connection error. too many attempts'), 'giving up');
            await delay(100);

            // The first connection and 3 attempts
            assert.equal(RecordingWebSocket.urls.length, 4);
            assert.equal(errors(handlers).filter(error => error.includes('ECONNREFUSED')).length, 3);
            assert.equal(client.closing, true);
        });

        it('reports "too many attempts" only once', async () => {
            const { handlers } = await connectedClient({ connectMaxAttempt: 2 });

            await server.stop();
            await until(() => errors(handlers).includes('connection error. too many attempts'), 'giving up');
            await delay(100);

            assert.equal(errors(handlers).filter(error => error === 'connection error. too many attempts').length, 1);
        });

        it('gives up after connectMaxAttempt attempts when the WebSocket cannot be created', async () => {
            const { client, handlers } = connectClient(
                { WebSocket: RecordingWebSocket, connectMaxAttempt: 3 },
                'ftp://127.0.0.1/',
            );

            await until(() => errors(handlers).includes('connection error. too many attempts'), 'giving up');
            await delay(50);

            assert.equal(RecordingWebSocket.urls.length, 4);
            assert.equal(client.closing, true);
        });

        it('reports the error of the WebSocket constructor to the error handlers', async () => {
            const { handlers } = connectClient(
                { WebSocket: RecordingWebSocket, connectMaxAttempt: 1 },
                'ftp://127.0.0.1/',
            );

            await until(() => errors(handlers).includes('connection error. too many attempts'), 'giving up');

            assert.match(errors(handlers)[0], /protocol/);
        });

        it('does not reconnect after close(true)', async () => {
            const { client, connection, handlers } = await connectedClient();

            client.close(true);

            assert.equal(client.connected, false);
            assert.equal(client.closing, true);
            assert.equal(handlers.disconnect.mock.callCount(), 1);
            await until(() => connection.isClosed, 'the close');
            await delay(100);
            assert.equal(server.connections.length, 1);
            assert.equal(handlers.error.mock.callCount(), 0);
        });

        it('does not reconnect after destroy() and removes all handlers', async () => {
            const { client, connection, handlers } = await connectedClient();
            const event = mock.fn();
            client.on('stateChange', event);

            client.destroy();

            assert.equal(handlers.disconnect.mock.callCount(), 1);
            await until(() => connection.isClosed, 'the close');
            await delay(100);
            assert.equal(server.connections.length, 1);
            assert.equal(handlers.error.mock.callCount(), 0);

            // The handlers are gone, even if the client is connected again
            client.connect();
            const second = await server.connection(2);
            second.send([MESSAGE, 1, 'stateChange', ['id', null]]);
            await until(() => client.connected, 'the ready message');
            await delay(20);
            assert.equal(event.mock.callCount(), 0);
            assert.equal(handlers.connect.mock.callCount(), 1);
            assert.equal(handlers.reconnect.mock.callCount(), 0);
        });
    });

    describe('authenticate', () => {
        it('closes the connection and reconnects when authenticate is not answered within authTimeout', async () => {
            const { client, connection, handlers } = await connectedClient({ authTimeout: 50 });
            const callback = mock.fn();

            client.emit('authenticate', callback);

            assert.deepEqual(await connection.message(message => message[2] === 'authenticate', 'the request'), [
                CALLBACK,
                1,
                'authenticate',
                [],
            ]);
            await until(() => connection.isClosed, 'the close after the authenticate timeout');
            assert.ok(handlers.disconnect.mock.callCount() >= 1);
            await until(() => handlers.reconnect.mock.callCount() >= 1, 'the reconnect');
            assert.equal(callback.mock.callCount(), 0);
        });

        it('reports the authenticate timeout to the error handlers', async () => {
            const { client, connection, handlers } = await connectedClient({ authTimeout: 50 });

            client.emit('authenticate', () => {});

            await until(() => connection.isClosed, 'the close after the authenticate timeout');
            assert.ok(errors(handlers).includes('Authenticate timeout'), JSON.stringify(errors(handlers)));
        });

        it('keeps the connection when authenticate is sent twice and answered', async () => {
            const { client, connection, handlers } = await connectedClient({ authTimeout: 500 });
            const callback = mock.fn();

            client.emit('authenticate', callback);
            client.emit('authenticate', callback);
            await until(
                () => connection.messages.filter(message => message[2] === 'authenticate').length === 2,
                'both requests',
            );
            connection.send([CALLBACK, 1, 'authenticate', [true, false]]);
            connection.send([CALLBACK, 2, 'authenticate', [true, false]]);
            await until(() => callback.mock.callCount() === 2, 'both answers');
            // the timer of the first authenticate would close the connection now
            await delay(700);

            assert.equal(handlers.disconnect.mock.callCount(), 0);
            assert.equal(connection.isOpen, true);
        });

        it('keeps the connection when authenticate is answered in time', async () => {
            const { client, connection, handlers } = await connectedClient({ authTimeout: 500 });
            const callback = mock.fn();

            client.emit('authenticate', 'user', 'secret', callback);
            await connection.message(message => message[2] === 'authenticate', 'the request');
            connection.send([CALLBACK, 1, 'authenticate', [true, false]]);
            await until(() => callback.mock.callCount() === 1, 'the answer');
            await delay(600);

            assert.deepEqual(connection.messages, [[CALLBACK, 1, 'authenticate', ['user', 'secret']]]);
            assert.deepEqual(callback.mock.calls[0].arguments, [true, false]);
            assert.equal(handlers.disconnect.mock.callCount(), 0);
            assert.equal(connection.isOpen, true);
        });
    });

    describe('callbacks without answer', () => {
        // The garbage collection of the callbacks runs every pingInterval (5 seconds by default)
        beforeEach(() => mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() }));

        it('waits for a late answer without callbackTimeout', async () => {
            const { client, connection } = await connectedClient();
            const callback = mock.fn();
            client.emit('getStates', '*', callback);
            await connection.message(message => message[2] === 'getStates', 'the request');

            // longer than the 30 seconds of the browser client, but shorter than pongTimeout (60 seconds)
            mock.timers.tick(50_000);
            connection.send([CALLBACK, 1, 'getStates', [null, {}]]);
            await until(() => callback.mock.callCount() === 1, 'the late answer');

            assert.deepEqual(
                callback.mock.calls.map(call => call.arguments),
                [[null, {}]],
            );
        });

        it('calls a callback with "timeout" after callbackTimeout and ignores the late answer', async () => {
            const { client, connection } = await connectedClient({ callbackTimeout: 30_000 });
            const callback = mock.fn();
            client.emit('getStates', '*', callback);
            await connection.message(message => message[2] === 'getStates', 'the request');

            mock.timers.tick(35_000);

            await until(() => callback.mock.callCount() > 0, 'the timeout of the callback', 200);
            connection.send([CALLBACK, 1, 'getStates', [null, {}]]);
            await processed(client, connection);
            assert.deepEqual(
                callback.mock.calls.map(call => call.arguments),
                [['timeout']],
            );
        });

        it('does not call a callback with "timeout" when the answer arrives within callbackTimeout', async () => {
            const { client, connection } = await connectedClient({ callbackTimeout: 30_000 });
            const callback = mock.fn();
            client.emit('getStates', '*', callback);
            await connection.message(message => message[2] === 'getStates', 'the request');

            mock.timers.tick(25_000);
            connection.send([CALLBACK, 1, 'getStates', [null, {}]]);
            await until(() => callback.mock.callCount() === 1, 'the answer');
            mock.timers.tick(20_000);
            await delay(20);

            assert.deepEqual(
                callback.mock.calls.map(call => call.arguments),
                [[null, {}]],
            );
            assert.equal(connection.isOpen, true);
        });
    });

    describe('in Node.js', () => {
        it('provides a location stub', () => {
            assert.equal(globalThis.location.href, 'http://localhost:8081/');
            assert.equal(globalThis.location.protocol, 'http:');
            assert.equal(globalThis.location.host, 'localhost:8081');
            assert.equal(globalThis.location.hostname, 'localhost');
            assert.equal(globalThis.location.pathname, '/');
            assert.equal(typeof globalThis.location.reload, 'function');
        });

        it('connects to location.href when no URL is given', async () => {
            const location = globalThis.location;
            (globalThis as any).location = { ...location, href: server.url };
            try {
                const client = new SocketClient();
                clients.push(client);
                client.connect(undefined, { WebSocket });
            } finally {
                (globalThis as any).location = location;
            }

            const connection = await server.connection(1);
            assert.match(connection.path, /^\/\?sid=\d+$/);
        });

        it('connects to the path of the location for the URL "/"', async () => {
            const location = globalThis.location;
            const host = new URL(server.url).host;
            (globalThis as any).location = {
                ...location,
                href: `http://${host}/vis/index.html`,
                host,
                hostname: '127.0.0.1',
                pathname: '/vis/index.html',
            };
            try {
                connectClient({}, '/');
            } finally {
                (globalThis as any).location = location;
            }

            const connection = await server.connection(1);
            assert.match(connection.path, /^\/vis\/?\?sid=\d+$/);
        });

        it('provides io.connect(), which creates a connected client', async () => {
            const client: SocketClient = (globalThis as any).io.connect(server.url, { WebSocket });
            clients.push(client);

            assert.ok(client instanceof SocketClient);
            await until(() => client.connected, 'the ready message');
            assert.equal(server.connections.length, 1);
        });

        it('exports SocketClient, Connection and AdminConnection from the index', () => {
            assert.equal(backend.SocketClient, SocketClient);
            assert.equal(typeof backend.Connection, 'function');
            assert.equal(typeof backend.AdminConnection, 'function');
        });
    });
});
