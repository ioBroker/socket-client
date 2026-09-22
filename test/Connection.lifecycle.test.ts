import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
    Connection,
    ERRORS,
    NOT_CONNECTED,
    PERMISSION_ERROR,
    PROGRESS,
    type RequestOptions,
    type SocketACL,
} from '../src/Connection.js';
import type { ConnectionProps, LogMessage } from '../src/ConnectionProps.js';
import * as index from '../src/index.js';
import { FakeSocket } from './lib/FakeSocket.js';
import {
    createConnection,
    createLoggedInConnection,
    flush,
    login,
    resetGlobals,
    setLocation,
    SYSTEM_CONFIG,
    track,
} from './lib/helpers.js';

const g = globalThis as any;

const ACL: SocketACL = { user: 'system.user.admin', groups: ['system.group.administrator'] };
const LOG: LogMessage = { message: 'hello', from: 'admin.0', ts: 1, severity: 'info', _id: 1 };

/** Makes the protected request method callable */
class RequestConnection extends Connection {
    call<T>(options: RequestOptions<T>): Promise<T> {
        return this.request(options);
    }
}

type MockFn<F extends (...args: any[]) => any> = ReturnType<typeof mock.fn<F>>;

/** The arguments of all calls of a mock */
function argsOf(fn: { mock: { calls: { arguments: unknown[] }[] } }): unknown[][] {
    return fn.mock.calls.map(call => call.arguments);
}

/** Lets chains of several requests and answers run */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await flush();
    }
}

/** A system config without language, so the connection has to take the one of the browser */
function configWithoutLanguage(): ioBroker.SystemConfigObject {
    return {
        _id: 'system.config',
        type: 'config',
        common: { defaultHistory: 'history.0' },
        native: {},
    } as unknown as ioBroker.SystemConfigObject;
}

describe('Connection.lifecycle', () => {
    let conn: Connection;
    let socket: FakeSocket;
    let reload: MockFn<() => void>;
    let alert: MockFn<(message: string) => void>;
    let consoleError: ReturnType<typeof mock.method>;

    beforeEach(() => {
        resetGlobals();
        mock.timers.enable({ apis: ['setTimeout'] });
        reload = mock.fn<() => void>();
        setLocation({ reload });
        alert = mock.fn<(message: string) => void>();
        g.alert = alert;
        consoleError = mock.method(console, 'error', () => {});
        mock.method(console, 'log', () => {});
        mock.method(console, 'warn', () => {});
    });

    afterEach(() => {
        conn?.destroy();
        mock.timers.reset();
        mock.restoreAll();
        delete g.alert;
    });

    describe('constants', () => {
        it('numbers the progress steps in their order', () => {
            assert.deepEqual(
                [PROGRESS.CONNECTING, PROGRESS.CONNECTED, PROGRESS.OBJECTS_LOADED, PROGRESS.READY],
                [0, 1, 2, 3],
            );
        });

        it('uses the error texts of the server and of the connection', () => {
            assert.deepEqual(
                [ERRORS.PERMISSION_ERROR, ERRORS.NOT_CONNECTED, ERRORS.TIMEOUT, ERRORS.NOT_ADMIN, ERRORS.NOT_SUPPORTED],
                ['permissionError', 'notConnectedError', 'timeout', 'Allowed only in admin', 'Not supported'],
            );
        });

        it('keeps the deprecated error constants as aliases', () => {
            assert.equal(PERMISSION_ERROR, ERRORS.PERMISSION_ERROR);
            assert.equal(NOT_CONNECTED, ERRORS.NOT_CONNECTED);
        });

        it('exports the connection and the constants from the package index', () => {
            assert.equal(index.Connection, Connection);
            assert.equal(index.PROGRESS, PROGRESS);
            assert.equal(index.ERRORS, ERRORS);
            assert.equal(index.PERMISSION_ERROR, PERMISSION_ERROR);
            assert.equal(index.NOT_CONNECTED, NOT_CONNECTED);
        });
    });

    describe('constructor', () => {
        function propsOf(connection: Connection): ConnectionProps {
            return (connection as any).props;
        }

        it('applies the defaults for the options that are not given', async () => {
            ({ conn } = await createConnection(Connection));
            const props = propsOf(conn);

            assert.deepEqual(
                {
                    protocol: props.protocol,
                    host: props.host,
                    port: props.port,
                    ioTimeout: props.ioTimeout,
                    cmdTimeout: props.cmdTimeout,
                    admin5only: props.admin5only,
                    autoSubscribes: props.autoSubscribes,
                    autoSubscribeLog: props.autoSubscribeLog,
                    doNotLoadACL: props.doNotLoadACL,
                    doNotLoadAllObjects: props.doNotLoadAllObjects,
                },
                {
                    protocol: 'http:',
                    host: 'localhost',
                    port: '8081',
                    ioTimeout: 20000,
                    cmdTimeout: 5000,
                    admin5only: false,
                    autoSubscribes: [],
                    autoSubscribeLog: false,
                    doNotLoadACL: true,
                    doNotLoadAllObjects: true,
                },
            );
        });

        it('keeps the given options', async () => {
            const given: Partial<ConnectionProps> = {
                protocol: 'https:',
                host: 'example.com',
                port: 8443,
                ioTimeout: 30000,
                cmdTimeout: 10000,
                admin5only: true,
                autoSubscribes: ['system.adapter.*'],
                autoSubscribeLog: true,
                doNotLoadACL: false,
                doNotLoadAllObjects: false,
                uuid: 'uuid',
            };
            ({ conn } = await createConnection(Connection, given));

            assert.deepEqual(propsOf(conn), { ...propsOf(conn), ...given });
        });

        it('raises ioTimeout to 20 s and cmdTimeout to 5 s at least', async () => {
            ({ conn } = await createConnection(Connection, { ioTimeout: 1000, cmdTimeout: 100 }));

            assert.equal(propsOf(conn).ioTimeout, 20000);
            assert.equal(propsOf(conn).cmdTimeout, 5000);
        });

        it('builds the ID of the connection from the name and six random digits', async () => {
            mock.method(Math, 'random', () => 0.000042);
            ({ conn } = await createConnection(Connection, { name: 'vis' }));

            assert.equal(conn.connId, 'vis-000042');
        });

        it('uses only the random digits as ID without a name', async () => {
            mock.method(Math, 'random', () => 0.123456);
            ({ conn } = await createConnection(Connection, { name: undefined }));

            assert.equal(conn.connId, '123456');
        });
    });

    describe('loading the socket library', () => {
        let connect: MockFn<(url: string, options: any) => FakeSocket>;

        beforeEach(() => {
            socket = new FakeSocket();
            connect = mock.fn((_url: string, _options: any) => socket);
        });

        it('uses the connect function of the props even if a socket library is loaded', async () => {
            const ioConnect = mock.fn(() => new FakeSocket());
            g.io = { connect: ioConnect };
            conn = new Connection({ name: 'test', connect });
            await flush();

            assert.equal(connect.mock.callCount(), 1);
            assert.equal(ioConnect.mock.callCount(), 0);
            assert.equal(conn.getRawSocket(), socket);
        });

        it('connects with io.connect of a loaded socket.io', async () => {
            g.io = { connect };
            conn = new Connection({ name: 'test' });
            await flush();

            assert.equal(connect.mock.callCount(), 1);
            assert.equal(conn.getRawSocket(), socket);
        });

        it('connects with iob.connect of a loaded ws client of ioBroker', async () => {
            g.iob = { connect };
            conn = new Connection({ name: 'test' });
            await flush();

            assert.equal(connect.mock.callCount(), 1);
        });

        it('waits for registerSocketOnLoad before it connects', async () => {
            let onLoad: (() => void) | undefined;
            g.registerSocketOnLoad = (cb: () => void) => {
                onLoad = cb;
            };
            conn = new Connection({ name: 'test' });
            await flush();
            mock.timers.tick(10_000);
            await flush();

            assert.equal(connect.mock.callCount(), 0);
            assert.equal(conn.getRawSocket(), undefined);

            g.iob = { connect };
            onLoad!();
            await flush();

            assert.equal(connect.mock.callCount(), 1);
            assert.equal(alert.mock.callCount(), 0);
        });

        it('polls every 100 ms until the socket library is loaded', async () => {
            conn = new Connection({ name: 'test' });
            for (let i = 0; i < 5; i++) {
                mock.timers.tick(100);
                await flush();
            }
            assert.equal(connect.mock.callCount(), 0);

            g.io = { connect };
            mock.timers.tick(99);
            await flush();
            assert.equal(connect.mock.callCount(), 0);

            mock.timers.tick(1);
            await flush();
            assert.equal(connect.mock.callCount(), 1);
            assert.equal(alert.mock.callCount(), 0);
        });

        it('gives up after 30 polls and alerts the user', async () => {
            conn = new Connection({ name: 'test' });
            for (let i = 0; i < 29; i++) {
                mock.timers.tick(100);
                await flush();
            }
            assert.equal(alert.mock.callCount(), 0);

            mock.timers.tick(100);
            await flush();

            assert.deepEqual(argsOf(alert), [
                ['Socket connection could not be initialized: Error: Socket library could not be loaded!'],
            ]);
            assert.equal(conn.getRawSocket(), undefined);
        });

        it('does not alert the user after destroy', async () => {
            conn = new Connection({ name: 'test' });
            conn.destroy();
            for (let i = 0; i < 30; i++) {
                mock.timers.tick(100);
                await flush();
            }

            assert.equal(alert.mock.callCount(), 0);
        });
    });

    describe('socket URL and options', () => {
        async function start(props: Partial<ConnectionProps> = {}): Promise<void> {
            ({ conn, socket } = await createConnection(Connection, props));
        }

        it('connects to the location of the page by default', async () => {
            await start();

            assert.equal(socket.url, 'http://localhost:8081');
            assert.deepEqual(socket.options, {
                path: '/socket.io',
                query: 'ws=true',
                name: 'test',
                timeout: 20000,
                uuid: undefined,
                token: undefined,
                transports: undefined,
            });
        });

        it('connects to protocol, host and port of the props', async () => {
            await start({ protocol: 'https:', host: 'example.com', port: 8443 });

            assert.equal(socket.url, 'https://example.com:8443');
        });

        it('connects to port 8081 while the page is served on port 3000', async () => {
            setLocation({ port: '3000', host: 'localhost:3000' });
            await start();

            assert.equal(socket.url, 'http://localhost:8081');
        });

        it('leaves out the port if the page has none', async () => {
            setLocation({ protocol: 'https:', port: '', host: 'example.com', hostname: 'example.com' });
            await start();

            assert.equal(socket.url, 'https://example.com');
        });

        it('passes ioTimeout, uuid and token to the socket', async () => {
            await start({ ioTimeout: 30000, uuid: 'the-uuid', token: 'the-token' });

            assert.equal(socket.options.timeout, 30000);
            assert.equal(socket.options.uuid, 'the-uuid');
            assert.equal(socket.options.token, 'the-token');
        });

        it('passes at least 20 s as ioTimeout', async () => {
            await start({ ioTimeout: 1000 });

            assert.equal(socket.options.timeout, 20000);
        });

        it('appends socketPath to the URL', async () => {
            g.socketPath = '/proxy';
            await start();

            assert.equal(socket.url, 'http://localhost:8081/proxy');
        });

        it('forces websockets if socketForceWebSockets is set', async () => {
            g.socketForceWebSockets = true;
            await start();

            assert.deepEqual(socket.options.transports, ['websocket']);
        });

        it('takes the directory of the page as path', async () => {
            setLocation({ pathname: '/admin/index.html' });
            await start();

            assert.equal(socket.options.path, '/admin/socket.io');
        });

        it('ignores the path of the page on iobroker.net and iobroker.pro', async () => {
            setLocation({ protocol: 'https:', hostname: 'iobroker.pro', port: '', pathname: '/some/dir/index.html' });
            await start();

            assert.equal(socket.url, 'https://iobroker.pro');
            assert.equal(socket.options.path, '/socket.io');
        });

        it('connects to socketUrl in a web adapter', async () => {
            g.socketUrl = 'https://other.local:8082';
            setLocation({ port: '8082', pathname: '/vis/index.html' });
            await start();

            assert.equal(socket.url, 'https://other.local:8082');
            assert.equal(socket.options.path, '/socket.io');
        });

        it('leaves out the port if socketUrl has none', async () => {
            g.socketUrl = 'https://other.local';
            await start();

            assert.equal(socket.url, 'https://other.local');
        });

        const webPaths: [pathname: string, path: string][] = [
            ['/index.html', '/socket.io'],
            ['/echarts/index.html', '/socket.io'],
            ['/material/1.3.0/index.html', '/socket.io'],
            ['/vis/main/index.html', '/socket.io'],
            ['/proxy/echarts/index.html', '/proxy/socket.io'],
            ['/proxy/material/1.3.0/index.html', '/proxy/socket.io'],
        ];
        for (const [pathname, path] of webPaths) {
            it(`uses the path ${path} in a web adapter for the page ${pathname}`, async () => {
                g.socketUrl = 'http://localhost:8082';
                setLocation({ port: '8082', pathname });
                await start();

                assert.equal(socket.options.path, path);
            });
        }

        it('creates the socket only once', async () => {
            const connect = mock.fn((_url: string, _options: any) => new FakeSocket());
            conn = new Connection({ name: 'test', connect });
            await flush();

            await conn.startSocket();

            assert.equal(connect.mock.callCount(), 1);
        });
    });

    describe('isWeb and isCloud', () => {
        it('isWeb is true as soon as socketUrl is defined', () => {
            assert.equal(Connection.isWeb(), false);

            g.socketUrl = '';
            assert.equal(Connection.isWeb(), true);
        });

        it('isCloud recognizes the cloud by the host name of the page', () => {
            for (const hostname of ['eu-west-1.amazonaws.com', 'iobroker.in', 'eu.iobroker.in']) {
                setLocation({ hostname });
                assert.equal(Connection.isCloud(), true, hostname);
            }
        });

        it('isCloud recognizes the cloud by socketUrl', () => {
            for (const socketUrl of ['https://iobroker.in:443', 'wss://abc.execute-api.amazonaws.com']) {
                g.socketUrl = socketUrl;
                assert.equal(Connection.isCloud(), true, socketUrl);
            }
        });

        it('isCloud is false for a local installation', () => {
            assert.equal(Connection.isCloud(), false);

            g.socketUrl = 'http://192.168.1.10:8082';
            assert.equal(Connection.isCloud(), false);
        });

        it('isCloud is false for a local host name that starts like a cloud domain', () => {
            setLocation({ hostname: 'iobroker.internal' });
            assert.equal(Connection.isCloud(), false);
        });
    });

    describe('on connect', () => {
        let onError: MockFn<(error: any) => void>;

        beforeEach(async () => {
            onError = mock.fn<(error: any) => void>();
            ({ conn, socket } = await createConnection(Connection, { onError }));
            socket.respond('getObject', (id: string) =>
                id === 'system.config' ? [null, SYSTEM_CONFIG] : [null, null],
            );
        });

        it('authenticates at once with the ws client of ioBroker', () => {
            socket.fire('connect', true);

            assert.equal(socket.requestsOf('authenticate').length, 1);
            assert.equal(socket.requestsOf('getVersion').length, 0);
        });

        it('is connected after the authentication with the ws client of ioBroker', async () => {
            socket.fire('connect', true);
            assert.equal(conn.isConnected(), false);

            socket.lastAnswer('authenticate')(true, true);
            await flush();

            assert.equal(conn.isConnected(), true);
            assert.equal(conn.isSecure, true);
        });

        it('asks socket.io for the version 500 ms after the connect and authenticates then', async () => {
            socket.fire('connect');
            mock.timers.tick(499);
            assert.equal(socket.requestsOf('getVersion').length, 0);

            mock.timers.tick(1);
            assert.equal(socket.requestsOf('getVersion').length, 1);
            assert.equal(socket.requestsOf('authenticate').length, 0);

            socket.lastAnswer('getVersion')(null, '4.1.2', 'admin');
            await flush();
            assert.equal(socket.requestsOf('authenticate').length, 1);
        });

        it('is connected at once with socket.io', () => {
            socket.fire('connect');

            assert.equal(conn.isConnected(), true);
        });

        it('does not authenticate at a server older than 4.1.2', async () => {
            socket.fire('connect');
            mock.timers.tick(500);
            socket.lastAnswer('getVersion')(null, '4.1.1', 'admin');
            await settle();

            assert.equal(socket.requestsOf('authenticate').length, 0);
            assert.equal(conn.onReadyDone, true);
            assert.equal(conn.isSecure, false);
        });

        it('reports a failed version request', async () => {
            socket.fire('connect');
            mock.timers.tick(500);
            socket.lastAnswer('getVersion')('permissionError');
            await flush();

            assert.deepEqual(argsOf(onError), [[{ message: 'permissionError', operation: 'getVersion' }]]);
            assert.equal(socket.requestsOf('authenticate').length, 0);
        });
    });

    describe('loading the data', () => {
        let onProgress: MockFn<(progress: number) => void>;
        let onReady: MockFn<(objects: Record<string, ioBroker.Object>) => void>;
        let onError: MockFn<(error: any) => void>;
        let onLanguage: MockFn<(lang: ioBroker.Languages) => void>;

        async function create(props: Partial<ConnectionProps> = {}): Promise<void> {
            ({ conn, socket } = await createConnection(Connection, {
                onProgress,
                onReady,
                onError,
                onLanguage,
                ...props,
            }));
        }

        /** Lets the socket connect, but leaves the answers of the data requests to the test */
        async function connectOnly(): Promise<void> {
            socket.respond('authenticate', () => [true, false]);
            socket.fire('connect', true);
            await settle();
        }

        beforeEach(() => {
            onProgress = mock.fn<(progress: number) => void>();
            onReady = mock.fn<(objects: Record<string, ioBroker.Object>) => void>();
            onError = mock.fn<(error: any) => void>();
            onLanguage = mock.fn<(lang: ioBroker.Languages) => void>();
        });

        it('reports CONNECTED and READY and passes the system config to onReady', async () => {
            await create();
            await login(conn, socket);

            assert.deepEqual(argsOf(onProgress), [[PROGRESS.CONNECTED], [PROGRESS.READY]]);
            assert.deepEqual(argsOf(onReady), [[{ 'system.config': SYSTEM_CONFIG }]]);
            assert.deepEqual(argsOf(onLanguage), [['de']]);
            assert.deepEqual(conn.systemConfig, SYSTEM_CONFIG);
            assert.equal(conn.systemLang, 'de');
            assert.equal(conn.loaded, true);
            assert.equal(onError.mock.callCount(), 0);
        });

        it('calls onReady only once', async () => {
            await create();
            await login(conn, socket);
            mock.timers.tick(20_000);
            await settle();

            assert.equal(onReady.mock.callCount(), 1);
            assert.equal(socket.requestsOf('getObject').length, 1);
        });

        it('does not load the permissions of the user by default', async () => {
            await create();
            await login(conn, socket);

            assert.equal(socket.requestsOf('getUserPermissions').length, 0);
            assert.equal(conn.acl, null);
        });

        it('loads the permissions of the user first if doNotLoadACL is false', async () => {
            await create({ doNotLoadACL: false });
            socket.respond('getUserPermissions', () => [null, ACL]);
            await login(conn, socket);

            assert.deepEqual(conn.acl, ACL);
            assert.deepEqual(
                socket.requests.map(request => request.name),
                ['authenticate', 'getUserPermissions', 'getObject'],
            );
        });

        it('reports a failed permission request and tries again a second later', async () => {
            await create({ doNotLoadACL: false });
            socket.respond('getObject', () => [null, SYSTEM_CONFIG]);
            await connectOnly();

            socket.lastAnswer('getUserPermissions')('permissionError');
            await settle();
            assert.deepEqual(argsOf(onError), [['Cannot read user permissions: permissionError']]);
            assert.equal(socket.requestsOf('getObject').length, 0);

            mock.timers.tick(999);
            await settle();
            assert.equal(socket.requestsOf('getUserPermissions').length, 1);

            mock.timers.tick(1);
            await settle();
            assert.equal(socket.requestsOf('getUserPermissions').length, 2);

            socket.lastAnswer('getUserPermissions')(null, ACL);
            await settle();
            assert.deepEqual(conn.acl, ACL);
            assert.equal(onReady.mock.callCount(), 1);
        });

        it('reports a failed system config request and tries again a second later', async () => {
            await create();
            await connectOnly();

            socket.lastAnswer('getObject')('permissionError');
            await settle();
            assert.deepEqual(argsOf(onError), [['Cannot read system config: Error: permissionError']]);
            assert.equal(onReady.mock.callCount(), 0);

            mock.timers.tick(1000);
            await settle();
            assert.equal(socket.requestsOf('getObject').length, 2);

            socket.lastAnswer('getObject')(null, SYSTEM_CONFIG);
            await settle();
            assert.equal(onReady.mock.callCount(), 1);
        });

        it('gives up after ten attempts', async () => {
            await create({ doNotLoadACL: false });
            socket.respond('getUserPermissions', () => ['permissionError']);
            await connectOnly();
            for (let i = 0; i < 15; i++) {
                mock.timers.tick(1000);
                await settle();
            }

            assert.equal(socket.requestsOf('getUserPermissions').length, 10);
            assert.equal(onError.mock.callCount(), 10);
            assert.equal(conn.loaded, false);
        });

        it('waits 5 s between the attempts in the cloud', async () => {
            setLocation({ hostname: 'eu-west-1.amazonaws.com' });
            await create({ doNotLoadACL: false });
            socket.respond('getUserPermissions', () => ['permissionError']);
            await connectOnly();

            mock.timers.tick(4999);
            await settle();
            assert.equal(socket.requestsOf('getUserPermissions').length, 1);

            mock.timers.tick(1);
            await settle();
            assert.equal(socket.requestsOf('getUserPermissions').length, 2);
        });

        it('loads the compact system config and no objects with admin5only', async () => {
            await create({ admin5only: true });
            socket.respond('getCompactSystemConfig', () => [null, SYSTEM_CONFIG]);
            await login(conn, socket);

            assert.equal(socket.requestsOf('getCompactSystemConfig').length, 1);
            assert.equal(socket.requestsOf('getObject').length, 0);
            assert.deepEqual(argsOf(onReady), [[{}]]);
            assert.deepEqual(conn.systemConfig, SYSTEM_CONFIG);
        });

        it('loads the compact system config with admin5only if the vendor prefix is the placeholder', async () => {
            g.vendorPrefix = '@@vendorPrefix@@';
            await create({ admin5only: true });
            socket.respond('getCompactSystemConfig', () => [null, SYSTEM_CONFIG]);
            await login(conn, socket);

            assert.equal(socket.requestsOf('getCompactSystemConfig').length, 1);
        });

        it('loads the full system config with admin5only if a vendor prefix is set', async () => {
            g.vendorPrefix = 'MyVendor';
            await create({ admin5only: true });
            await login(conn, socket);

            assert.equal(socket.requestsOf('getCompactSystemConfig').length, 0);
            assert.equal(socket.requestsOf('getObject').length, 1);
        });

        it('loads the full system config with admin5only in a web adapter', async () => {
            await create({ admin5only: true });
            g.socketUrl = 'http://localhost:8082';
            await login(conn, socket);

            assert.equal(socket.requestsOf('getCompactSystemConfig').length, 0);
            assert.equal(socket.requestsOf('getObject').length, 1);
        });

        it('asks for the compact system config again after an error', async () => {
            await create({ admin5only: true });
            await connectOnly();
            socket.lastAnswer('getCompactSystemConfig')('permissionError');
            await settle();

            mock.timers.tick(1000);
            await settle();
            assert.equal(socket.requestsOf('getCompactSystemConfig').length, 2);

            socket.lastAnswer('getCompactSystemConfig')(null, SYSTEM_CONFIG);
            await settle();
            assert.equal(onReady.mock.callCount(), 1);
        });

        it('loads all objects if doNotLoadAllObjects is false', async () => {
            const objects = {
                'system.config': SYSTEM_CONFIG,
                'system.adapter.admin.0': { _id: 'system.adapter.admin.0', type: 'instance' },
            } as unknown as Record<string, ioBroker.Object>;
            await create({ doNotLoadAllObjects: false });
            socket.respond('getAllObjects', () => [null, objects]);
            await login(conn, socket);

            assert.equal(socket.requestsOf('getAllObjects').length, 1);
            assert.deepEqual(argsOf(onProgress), [[PROGRESS.CONNECTED], [PROGRESS.OBJECTS_LOADED], [PROGRESS.READY]]);
            assert.deepEqual(argsOf(onReady), [[objects]]);
        });

        it('reports an error of loading all objects and gets ready anyway', async () => {
            await create({ doNotLoadAllObjects: false });
            socket.respond('getAllObjects', () => ['permissionError']);
            await login(conn, socket);

            assert.deepEqual(argsOf(onError), [['Cannot read all objects: permissionError']]);
            assert.deepEqual(argsOf(onReady), [[{}]]);
            assert.equal(onProgress.mock.calls.at(-1)?.arguments[0], PROGRESS.READY);
        });

        it('loads the data only once when the system config comes after the next retry', async () => {
            await create({ doNotLoadAllObjects: false });
            socket.respond('getAllObjects', () => [null, { 'system.config': SYSTEM_CONFIG }]);
            await connectOnly();
            // the retries of loadData wait for the same system config
            mock.timers.tick(1000);
            await settle();
            mock.timers.tick(1000);
            await settle();

            socket.lastAnswer('getObject')(null, SYSTEM_CONFIG);
            await settle();

            assert.equal(socket.requestsOf('getAllObjects').length, 1);
            assert.equal(onLanguage.mock.callCount(), 1);
            assert.deepEqual(argsOf(onProgress), [[PROGRESS.CONNECTED], [PROGRESS.OBJECTS_LOADED], [PROGRESS.READY]]);
            assert.equal(onReady.mock.callCount(), 1);
        });

        it('reloads the page instead of loading the data while waiting for a restart', async () => {
            await create();
            conn.waitForRestart = true;
            const firstConnection = track(conn.waitForFirstConnection());
            await connectOnly();

            assert.equal(reload.mock.callCount(), 1);
            assert.equal(socket.requestsOf('getObject').length, 0);
            assert.equal(onReady.mock.callCount(), 0);
            assert.equal(firstConnection.settled, true);
        });

        it('resolves waitForFirstConnection after the authentication', async () => {
            await create();
            const firstConnection = track(conn.waitForFirstConnection());
            socket.fire('connect', true);
            await flush();
            assert.equal(firstConnection.settled, false);

            socket.lastAnswer('authenticate')(true, false);
            await flush();
            assert.equal(firstConnection.settled, true);
        });

        it('reports only READY on the next connect and does not load the data again', async () => {
            await create();
            await login(conn, socket);
            socket.fire('disconnect');
            onProgress.mock.resetCalls();

            socket.fire('connect', true);
            await settle();

            assert.deepEqual(argsOf(onProgress), [[PROGRESS.READY]]);
            assert.equal(socket.requestsOf('getObject').length, 1);
            assert.equal(onReady.mock.callCount(), 1);
            assert.equal(conn.isConnected(), true);
        });
    });

    describe('system language', () => {
        let onLanguage: MockFn<(lang: ioBroker.Languages) => void>;

        function setNavigator(navigator: Record<string, string>): void {
            mock.getter(g, 'navigator', () => navigator);
        }

        async function loginWith(systemConfig: ioBroker.SystemConfigObject): Promise<void> {
            ({ conn, socket } = await createConnection(Connection, { onLanguage }));
            await login(conn, socket, { systemConfig });
        }

        beforeEach(() => {
            onLanguage = mock.fn<(lang: ioBroker.Languages) => void>();
        });

        it('takes the language of the system config', async () => {
            setNavigator({ language: 'de-DE' });
            const systemConfig = configWithoutLanguage();
            systemConfig.common.language = 'ru';
            await loginWith(systemConfig);

            assert.equal(conn.systemLang, 'ru');
            assert.deepEqual(argsOf(onLanguage), [['ru']]);
        });

        it('takes the language of the browser without the region if the system config has none', async () => {
            setNavigator({ language: 'de-DE' });
            await loginWith(configWithoutLanguage());

            assert.equal(conn.systemLang, 'de');
            assert.equal(conn.systemConfig?.common.language, 'de');
            assert.deepEqual(argsOf(onLanguage), [['de']]);
        });

        it('prefers userLanguage of old browsers', async () => {
            setNavigator({ userLanguage: 'fr', language: 'de-DE' });
            await loginWith(configWithoutLanguage());

            assert.equal(conn.systemLang, 'fr');
        });

        it('keeps zh-cn', async () => {
            setNavigator({ language: 'zh-cn' });
            await loginWith(configWithoutLanguage());

            assert.equal(conn.systemLang, 'zh-cn');
        });

        it('falls back to English for other languages', async () => {
            setNavigator({ language: 'ja-JP' });
            await loginWith(configWithoutLanguage());

            assert.equal(conn.systemLang, 'en');
        });

        it('takes the language of the browser if there is no system.config', async () => {
            setNavigator({ language: 'it-IT' });
            ({ conn, socket } = await createConnection(Connection, { onLanguage }));
            socket.respond('getObject', () => [null, null]);
            await login(conn, socket);

            assert.equal(conn.systemLang, 'it');
            assert.deepEqual(conn.systemConfig, { common: { language: 'it' }, native: {} });
        });

        it('recognizes zh-CN as the browsers report it', async () => {
            setNavigator({ language: 'zh-CN' });
            await loginWith(configWithoutLanguage());

            assert.equal(conn.systemLang, 'zh-cn');
        });
    });

    describe('reconnect and disconnect', () => {
        let onProgress: MockFn<(progress: number) => void>;
        let handler: MockFn<(connected: boolean) => void>;

        beforeEach(async () => {
            onProgress = mock.fn<(progress: number) => void>();
            handler = mock.fn<(connected: boolean) => void>();
            ({ conn, socket } = await createConnection(Connection, { onProgress }));
            conn.registerConnectionHandler(handler);
            await login(conn, socket);
            onProgress.mock.resetCalls();
        });

        it('informs the connection handlers about the connect', () => {
            assert.deepEqual(argsOf(handler), [[true]]);
            assert.equal(conn.isConnected(), true);
        });

        it('is not connected and not ready after a disconnect and reports CONNECTING', () => {
            socket.fire('disconnect');

            assert.equal(conn.isConnected(), false);
            assert.equal(conn.onReadyDone, false);
            assert.deepEqual(argsOf(onProgress), [[PROGRESS.CONNECTING]]);
            assert.deepEqual(argsOf(handler), [[true], [false]]);
        });

        it('is connected again after a reconnect and reports READY', () => {
            socket.fire('disconnect');
            socket.fire('reconnect');

            assert.equal(conn.isConnected(), true);
            assert.deepEqual(argsOf(onProgress), [[PROGRESS.CONNECTING], [PROGRESS.READY]]);
            assert.deepEqual(argsOf(handler), [[true], [false], [true]]);
            assert.equal(reload.mock.callCount(), 0);
        });

        it('registers a connection handler only once', () => {
            conn.registerConnectionHandler(handler);
            socket.fire('disconnect');

            assert.deepEqual(argsOf(handler), [[true], [false]]);
        });

        it('does not call an unregistered connection handler', () => {
            conn.unregisterConnectionHandler(handler);
            socket.fire('disconnect');
            socket.fire('reconnect');

            assert.deepEqual(argsOf(handler), [[true]]);
        });

        it('reloads the page on a reconnect while waiting for a restart', () => {
            conn.waitForRestart = true;
            socket.fire('disconnect');
            socket.fire('reconnect');

            assert.equal(reload.mock.callCount(), 1);
            assert.deepEqual(argsOf(handler), [[true], [false]]);
        });

        it('reloads the page on the next connect while waiting for a restart', async () => {
            conn.waitForRestart = true;
            socket.fire('disconnect');
            socket.fire('connect', true);
            await settle();

            assert.equal(reload.mock.callCount(), 1);
            assert.deepEqual(argsOf(handler), [[true], [false]]);
        });
    });

    describe('automatic subscriptions', () => {
        beforeEach(async () => {
            ({ conn, socket } = await createLoggedInConnection(Connection, {
                autoSubscribes: ['system.adapter.*'],
                autoSubscribeLog: true,
            }));
        });

        it('subscribes autoSubscribes and the log after the login', () => {
            assert.deepEqual(
                socket.requestsOf('subscribeObjects').map(request => request.args),
                [[['system.adapter.*']]],
            );
            assert.deepEqual(
                socket.requestsOf('requireLog').map(request => request.args),
                [[true]],
            );
        });

        it('subscribes them again after a disconnect and reconnect', () => {
            socket.fire('reconnect');
            assert.equal(socket.requestsOf('subscribeObjects').length, 1);

            socket.fire('disconnect');
            socket.fire('reconnect');
            assert.equal(socket.requestsOf('subscribeObjects').length, 2);
            assert.equal(socket.requestsOf('requireLog').length, 2);
        });
    });

    describe('server events', () => {
        let onError: MockFn<(error: any) => void>;
        let onLog: MockFn<(message: LogMessage) => void>;

        beforeEach(async () => {
            onError = mock.fn<(error: any) => void>();
            onLog = mock.fn<(message: LogMessage) => void>();
            ({ conn, socket } = await createLoggedInConnection(Connection, { onError, onLog }));
            consoleError.mock.resetCalls();
        });

        it('sends the user to the login page if the user is not authorized', () => {
            setLocation({ pathname: '/index.html', search: '?a=1', hash: '#tab' });
            socket.fire('error', 'User not authorized');

            assert.equal(g.location.href, 'http://localhost:8081/index.html?login&href=%3Fa%3D1%23tab');
        });

        it('keeps the login URL if it already has a href', () => {
            setLocation({ search: '?login&href=%23tab' });
            socket.fire('error', new Error('User not authorized'));

            assert.equal(g.location.href, 'http://localhost:8081/?login&href=%23tab');
        });

        it('reloads the page on a websocket error', () => {
            socket.fire('error', 'websocket error');

            assert.equal(reload.mock.callCount(), 1);
            assert.deepEqual(argsOf(consoleError), [['Socket Error => reload: websocket error']]);
        });

        it('only logs other errors', () => {
            socket.fire('error', 'something');
            socket.fire('error');

            assert.deepEqual(argsOf(consoleError), [['Socket Error: something'], ['Socket Error: undefined']]);
            assert.equal(reload.mock.callCount(), 0);
            assert.equal(g.location.href, 'http://localhost:8081/');
        });

        it('logs an error object that has no toString', () => {
            const error = Object.assign(Object.create(null), { code: 42 });

            assert.doesNotThrow(() => socket.fire('error', error));
            assert.deepEqual(argsOf(consoleError)[0], ['Received strange error: {"code":42}']);
        });

        it('logs connect errors', () => {
            socket.fire('connect_error', new Error('refused'));

            assert.deepEqual(argsOf(consoleError), [['Connect error: Error: refused']]);
        });

        it('reports a permission error to onError', () => {
            socket.fire('permissionError', { operation: 'read', type: 'object', id: 'a.0.b' });
            socket.fire('permissionError', { operation: 'write', type: 'state' });

            assert.deepEqual(argsOf(onError), [
                [{ message: 'no permission', operation: 'read', type: 'object', id: 'a.0.b' }],
                [{ message: 'no permission', operation: 'write', type: 'state', id: '' }],
            ]);
        });

        it('logs a permission error without onError', async () => {
            conn.destroy();
            ({ conn, socket } = await createLoggedInConnection(Connection));
            socket.fire('permissionError', { operation: 'read', type: 'object', id: 'a.0.b' });

            const calls = argsOf(consoleError);
            assert.deepEqual(calls[calls.length - 1], [
                { message: 'no permission', operation: 'read', type: 'object', id: 'a.0.b' },
            ]);
        });

        it('passes log messages to onLog and to the registered log handlers', () => {
            const handler = mock.fn<(message: LogMessage) => void>();
            conn.registerLogHandler(handler);
            conn.registerLogHandler(handler);
            socket.fire('log', LOG);

            assert.deepEqual(argsOf(onLog), [[LOG]]);
            assert.deepEqual(argsOf(handler), [[LOG]]);

            conn.unregisterLogHandler(handler);
            socket.fire('log', LOG);

            assert.equal(onLog.mock.callCount(), 2);
            assert.equal(handler.mock.callCount(), 1);
        });

        it('passes the output and the exit code of a command to the registered handlers', () => {
            const stdout = mock.fn<(id: string, text: string) => void>();
            const stderr = mock.fn<(id: string, text: string) => void>();
            const exit = mock.fn<(id: string, exitCode: number) => void>();
            conn.registerCmdStdoutHandler(stdout);
            conn.registerCmdStderrHandler(stderr);
            conn.registerCmdExitHandler(exit);

            socket.fire('cmdStdout', 'cmd1', 'out');
            socket.fire('cmdStderr', 'cmd1', 'err');
            socket.fire('cmdExit', 'cmd1', 1);

            assert.deepEqual(argsOf(stdout), [['cmd1', 'out']]);
            assert.deepEqual(argsOf(stderr), [['cmd1', 'err']]);
            assert.deepEqual(argsOf(exit), [['cmd1', 1]]);
        });

        it('ignores the output of a command after the handlers were unregistered', () => {
            const handler = mock.fn();
            conn.registerCmdStdoutHandler(handler);
            conn.registerCmdStderrHandler(handler);
            conn.registerCmdExitHandler(handler);
            conn.unregisterCmdStdoutHandler();
            conn.unregisterCmdStderrHandler();
            conn.unregisterCmdExitHandler();

            socket.fire('cmdStdout', 'cmd1', 'out');
            socket.fire('cmdStderr', 'cmd1', 'err');
            socket.fire('cmdExit', 'cmd1', 0);

            assert.equal(handler.mock.callCount(), 0);
        });

        it('replaces the previous command handler', () => {
            const first = mock.fn<(id: string, text: string) => void>();
            const second = mock.fn<(id: string, text: string) => void>();
            conn.registerCmdStdoutHandler(first);
            conn.registerCmdStdoutHandler(second);

            socket.fire('cmdStdout', 'cmd1', 'out');

            assert.equal(first.mock.callCount(), 0);
            assert.equal(second.mock.callCount(), 1);
        });
    });

    describe('request', () => {
        let rconn: RequestConnection;

        async function setup(props: Partial<ConnectionProps> = {}): Promise<void> {
            ({ conn: rconn, socket } = await createLoggedInConnection(RequestConnection, props));
            conn = rconn;
        }

        it('rejects before the socket is connected', async () => {
            ({ conn, socket } = await createConnection(Connection));

            await assert.rejects(conn.getState('a.0.b'), { name: 'Error', message: ERRORS.NOT_CONNECTED });
            assert.equal(socket.requestsOf('getState').length, 0);
        });

        it('rejects after a disconnect', async () => {
            await setup();
            socket.fire('disconnect');

            await assert.rejects(conn.getState('a.0.b'), { message: ERRORS.NOT_CONNECTED });
        });

        it('asks the server every time without cacheKey', async () => {
            await setup();
            socket.respond('getState', () => [null, { val: 1 }]);

            assert.deepEqual(await conn.getState('a.0.b'), { val: 1 });
            assert.deepEqual(await conn.getState('a.0.b'), { val: 1 });
            assert.equal(socket.requestsOf('getState').length, 2);
        });

        it('answers from the cache until an update is forced', async () => {
            await setup();
            assert.deepEqual(await conn.getSystemConfig(), SYSTEM_CONFIG);
            assert.equal(socket.requestsOf('getObject').length, 1);

            const updated = { ...SYSTEM_CONFIG, common: { ...SYSTEM_CONFIG.common, language: 'en' } };
            socket.respond('getObject', () => [null, updated]);

            assert.deepEqual(await conn.getSystemConfig(true), updated);
            assert.deepEqual(await conn.getSystemConfig(), updated);
            assert.equal(socket.requestsOf('getObject').length, 2);
        });

        it('answers from the cache while not connected', async () => {
            await setup();
            socket.fire('disconnect');

            assert.deepEqual(await conn.getSystemConfig(), SYSTEM_CONFIG);
            await assert.rejects(conn.getSystemConfig(true), { message: ERRORS.NOT_CONNECTED });
        });

        it('rejects with TIMEOUT after cmdTimeout and does not cache it', async () => {
            await setup();
            const onTimeout = mock.fn();
            const executor = mock.fn<RequestOptions<string>['executor']>();
            const first = track(rconn.call({ cacheKey: 'slow', onTimeout, executor }));

            mock.timers.tick(4999);
            await flush();
            assert.equal(first.settled, false);

            mock.timers.tick(1);
            await flush();
            assert.equal((first.error as Error).message, ERRORS.TIMEOUT);
            assert.equal(onTimeout.mock.callCount(), 1);
            assert.equal(executor.mock.calls[0].arguments[2].elapsed, true);

            void rconn.call({ cacheKey: 'slow', executor });
            assert.equal(executor.mock.callCount(), 2);
        });

        it('times out after cmdTimeout of the props', async () => {
            await setup({ cmdTimeout: 8000 });
            const request = track(rconn.call({ executor: () => {} }));

            mock.timers.tick(7999);
            await flush();
            assert.equal(request.settled, false);

            mock.timers.tick(1);
            await flush();
            assert.equal((request.error as Error).message, ERRORS.TIMEOUT);
        });

        it('waits at least 5 s even with a shorter cmdTimeout', async () => {
            await setup({ cmdTimeout: 1000 });
            const request = track(rconn.call({ executor: () => {} }));

            mock.timers.tick(4999);
            await flush();
            assert.equal(request.settled, false);

            mock.timers.tick(1);
            await flush();
            assert.equal((request.error as Error).message, ERRORS.TIMEOUT);
        });

        it('times out after the commandTimeout of the request', async () => {
            await setup();
            const request = track(rconn.call({ commandTimeout: 100, executor: () => {} }));

            mock.timers.tick(100);
            await flush();
            assert.equal((request.error as Error).message, ERRORS.TIMEOUT);
        });

        it('never times out with commandTimeout false or after the executor stopped the timeout', async () => {
            await setup();
            const withoutTimeout = track(rconn.call({ commandTimeout: false, executor: () => {} }));
            const stopped = track(rconn.call({ executor: (_resolve, _reject, timeout) => timeout.clearTimeout() }));

            mock.timers.tick(60_000);
            await flush();

            assert.equal(withoutTimeout.settled, false);
            assert.equal(stopped.settled, false);
        });

        it('rejects with NOT_ADMIN in a web adapter if the request requires the admin', async () => {
            await setup();
            g.socketUrl = 'http://localhost:8082';
            const executor = mock.fn<RequestOptions<string>['executor']>(resolve => resolve('done'));

            await assert.rejects(rconn.call({ requireAdmin: true, executor }), { message: ERRORS.NOT_ADMIN });
            assert.equal(executor.mock.callCount(), 0);
        });

        it('runs a request that requires the admin outside of a web adapter', async () => {
            await setup();

            assert.equal(await rconn.call({ requireAdmin: true, executor: resolve => resolve('done') }), 'done');
        });

        it('checks every required feature once before the request', async () => {
            await setup();
            socket.respond('checkFeatureSupported', () => [null, true]);
            const executor = mock.fn<RequestOptions<string>['executor']>(resolve => resolve('done'));

            assert.equal(await rconn.call({ requireFeatures: ['A', 'B'], executor }), 'done');
            assert.equal(await rconn.call({ requireFeatures: ['A'], executor }), 'done');

            assert.deepEqual(
                socket.requestsOf('checkFeatureSupported').map(request => request.args),
                [['A'], ['B']],
            );
            assert.equal(executor.mock.callCount(), 2);
        });

        it('rejects with NOT_SUPPORTED if a required feature is missing', async () => {
            await setup();
            socket.respond('checkFeatureSupported', (feature: string) => [null, feature !== 'MISSING']);
            const executor = mock.fn<RequestOptions<string>['executor']>(resolve => resolve('done'));

            await assert.rejects(rconn.call({ requireFeatures: ['A', 'MISSING', 'C'], executor }), {
                message: ERRORS.NOT_SUPPORTED,
            });
            assert.equal(executor.mock.callCount(), 0);
            assert.deepEqual(
                socket.requestsOf('checkFeatureSupported').map(request => request.args),
                [['A'], ['MISSING']],
            );
        });

        it('rejects with the error of a failing executor and does not cache it', async () => {
            await setup();
            socket.respond('getState', () => ['permissionError']);
            const executor = mock.fn<RequestOptions<unknown>['executor']>(async resolve => {
                resolve(await conn.getState('a.0.b'));
            });

            await assert.rejects(rconn.call({ cacheKey: 'nested', executor }), {
                name: 'Error',
                message: 'permissionError',
            });
            await assert.rejects(rconn.call({ cacheKey: 'nested', executor }));
            assert.equal(executor.mock.callCount(), 2);
        });

        it('keeps the message of an Error of a failing executor', async () => {
            await setup();
            const outer = track(
                rconn.call<unknown>({
                    commandTimeout: false,
                    executor: async resolve => {
                        resolve(await rconn.call({ commandTimeout: 100, executor: () => {} }));
                    },
                }),
            );

            mock.timers.tick(100);
            await flush();

            assert.equal((outer.error as Error).message, ERRORS.TIMEOUT);
        });

        it('does not cache a request that the server rejected', async () => {
            await setup();
            socket.respond('checkFeatureSupported', () => ['permissionError']);
            await assert.rejects(conn.checkFeatureSupported('A'));

            socket.respond('checkFeatureSupported', () => [null, true]);
            assert.equal(await conn.checkFeatureSupported('A'), true);
        });

        it('resetCache deletes one cached request', async () => {
            await setup();
            socket.respond('checkFeatureSupported', () => [null, true]);
            await conn.checkFeatureSupported('A');
            await conn.checkFeatureSupported('B');

            conn.resetCache('supportedFeatures_A');
            await conn.checkFeatureSupported('A');
            await conn.checkFeatureSupported('B');

            assert.deepEqual(
                socket.requestsOf('checkFeatureSupported').map(request => request.args),
                [['A'], ['B'], ['A']],
            );
        });

        it('resetCache with isAll deletes all cached requests that start with the key', async () => {
            await setup();
            socket.respond('checkFeatureSupported', () => [null, true]);
            await conn.checkFeatureSupported('A');
            await conn.checkFeatureSupported('B');

            conn.resetCache('supportedFeatures_', true);
            await conn.checkFeatureSupported('A');
            await conn.checkFeatureSupported('B');
            await conn.getSystemConfig();

            assert.equal(socket.requestsOf('checkFeatureSupported').length, 4);
            assert.equal(socket.requestsOf('getObject').length, 1);
        });
    });

    describe('state and log', () => {
        it('returns the socket of the connect function as raw socket', async () => {
            ({ conn, socket } = await createConnection(Connection));

            assert.equal(conn.getRawSocket(), socket);
        });

        it('is not connected before the login', async () => {
            ({ conn, socket } = await createConnection(Connection));

            assert.equal(conn.isConnected(), false);
            assert.equal(conn.onReadyDone, false);
        });

        it('sends a log text with its level to the server', async () => {
            ({ conn, socket } = await createLoggedInConnection(Connection));

            assert.equal(await conn.log('hello', 'warn'), null);
            assert.deepEqual(socket.lastRequest('log').args, ['hello', 'warn']);
        });

        it('does not send an empty log text', async () => {
            ({ conn, socket } = await createConnection(Connection));

            assert.equal(await conn.log(''), null);
            assert.equal(socket.requestsOf('log').length, 0);
        });

        it('rejects a log text while not connected', async () => {
            ({ conn, socket } = await createConnection(Connection));

            await assert.rejects(conn.log('hello'), { message: ERRORS.NOT_CONNECTED });
            assert.equal(socket.requestsOf('log').length, 0);
        });
    });

    describe('destroy', () => {
        it('destroys the socket', async () => {
            ({ conn, socket } = await createLoggedInConnection(Connection));
            conn.destroy();

            assert.equal(socket.destroyed, true);
            assert.equal(socket.closed, false);
        });

        it('closes the socket without reconnect if it cannot be destroyed', async () => {
            ({ conn, socket } = await createLoggedInConnection(Connection));
            (socket as any).destroy = undefined;
            const close = mock.method(socket, 'close');
            conn.destroy();

            assert.deepEqual(argsOf(close), [[true]]);
        });

        it('ignores an error of the socket', async () => {
            ({ conn, socket } = await createLoggedInConnection(Connection));
            mock.method(socket, 'destroy', () => {
                throw new Error('already closed');
            });

            assert.doesNotThrow(() => conn.destroy());
            assert.equal(conn.isConnected(), false);
        });

        it('is neither connected nor ready afterwards', async () => {
            ({ conn, socket } = await createLoggedInConnection(Connection));
            conn.destroy();

            assert.equal(conn.isConnected(), false);
            assert.equal(conn.onReadyDone, false);
        });

        it('removes the connection and log handlers and the subscriptions', async () => {
            const onLog = mock.fn<(message: LogMessage) => void>();
            ({ conn, socket } = await createLoggedInConnection(Connection, { onLog }));
            const connectionHandler = mock.fn<(connected: boolean) => void>();
            const logHandler = mock.fn<(message: LogMessage) => void>();
            const objectHandler = mock.fn();
            conn.registerConnectionHandler(connectionHandler);
            conn.registerLogHandler(logHandler);
            await conn.subscribeObject('a.0.b', objectHandler);
            conn.destroy();

            socket.fire('disconnect');
            socket.fire('log', LOG);
            socket.fire('objectChange', 'a.0.b', { _id: 'a.0.b', type: 'state' });
            mock.timers.tick(1);

            assert.equal(connectionHandler.mock.callCount(), 0);
            assert.equal(logHandler.mock.callCount(), 0);
            assert.equal(objectHandler.mock.callCount(), 0);
        });

        it('stops the timer that refreshes the access token', async () => {
            mock.timers.reset();
            mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
            const fetch = mock.method(globalThis, 'fetch', () => Promise.reject(new Error('offline')));
            Connection.saveTokensStatic(
                {
                    access_token: 'access',
                    refresh_token: 'refresh',
                    expires_in: 60,
                    refresh_token_expires_in: 3600,
                    token_type: 'Bearer',
                },
                true,
            );
            ({ conn, socket } = await createConnection(Connection));
            await login(conn, socket, { isSecure: true });

            conn.destroy();
            mock.timers.tick(60_000);
            await settle();

            assert.equal(fetch.mock.callCount(), 0);
        });

        it('can be called before the socket exists and twice', async () => {
            g.registerSocketOnLoad = () => {};
            conn = new Connection({ name: 'test' });
            await flush();

            assert.doesNotThrow(() => conn.destroy());
            assert.doesNotThrow(() => conn.destroy());
        });

        it('does not open the socket if destroyed right after the construction', async () => {
            const connect = mock.fn((_url: string, _options: any) => new FakeSocket());
            conn = new Connection({ name: 'test', connect });
            conn.destroy();
            await flush();

            assert.equal(connect.mock.callCount(), 0);
        });

        it('does not report an error of the version request after destroy', async () => {
            const onError = mock.fn<(error: any) => void>();
            ({ conn, socket } = await createConnection(Connection, { onError }));
            socket.fire('connect');
            conn.destroy();

            mock.timers.tick(500);
            await flush();

            assert.equal(onError.mock.callCount(), 0);
        });
    });
});
