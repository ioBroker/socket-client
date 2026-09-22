import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type Mock } from 'node:test';

import { AdminConnection } from '../src/AdminConnection.js';
import { ERRORS, type RequestOptions } from '../src/Connection.js';
import type { ConnectionProps } from '../src/ConnectionProps.js';
import type { FakeSocket } from './lib/FakeSocket.js';
import { createLoggedInConnection, flush, resetGlobals, track, type Tracked } from './lib/helpers.js';

const HOST_INFO = { Platform: 'linux', os: 'linux', Architecture: 'x64', CPUs: 4, RAM: 8_000_000_000 };
const REPOSITORY = {
    admin: { version: '7.6.1', extIcon: 'https://example.com/admin.png', titleLang: { en: 'Admin' } },
};
const INSTALLED = { admin: { version: '7.6.1', enabled: 1, count: 1 } };
const BASE_SETTINGS = { system: { hostname: '' }, objects: { type: 'jsonl' } } as unknown as ioBroker.IoBrokerJson;
const WEBSERVER_OPTIONS = { version: '7.6.1', adapterName: 'admin', port: 8091 };
const LICENSE = { id: 'l1', product: 'iobroker.vis-2.commercial' };
const LOG_FILES = [{ fileName: 'iobroker.2024-01-01.log', size: 1024 }];
const CHANGED_FILES = [{ path: 'main', file: 'vis-views.json', stats: {}, isDir: false, acl: {} }];
const NOTIFICATIONS = { result: { system: { categories: {} } } };
const DIAG_DATA = { uuid: 'abc', hosts: [] };
const EASY_MODE = { strict: false, configs: [{ id: 'system.adapter.admin.0', title: 'Admin' }] };
const RATINGS = { uuid: 'abc', admin: { rating: { r: 4.5, c: 10 } } };
const INSTANCE = { _id: 'system.adapter.hm-rpc.0', type: 'instance', common: { name: 'hm-rpc' }, native: {} };
const ADAPTER = { _id: 'system.adapter.hm-rpc', type: 'adapter', common: { name: 'hm-rpc' }, native: {} };
const USER = { _id: 'system.user.admin', type: 'user', common: { name: 'admin' }, native: {} };

const HOST_OBJECT = {
    _id: 'system.host.a',
    type: 'host',
    common: { name: 'a', hostname: 'a', address: ['192.168.1.10', 'fe80::1'] },
    native: {
        hardware: {
            networkInterfaces: {
                eth0: [
                    { family: 'IPv4', address: '192.168.1.10' },
                    { family: 'IPv6', address: 'fe80::1' },
                ],
                lo: [{ family: 'IPv4', address: '127.0.0.1' }],
            },
        },
    },
};

const LISTEN_ON_ALL_IPV4 = { name: '[IPv4] 0.0.0.0 - Listen on all IPs', address: '0.0.0.0', family: 'ipv4' };
const LISTEN_ON_ALL_IPV6 = { name: '[IPv6] :: - Listen on all IPs', address: '::', family: 'ipv6' };

const PRIVATE_RSA_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkq\n-----END PRIVATE KEY-----\n';
const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE\n-----END CERTIFICATE-----\n';
const CA_CERTIFICATE = '-----BEGIN CERTIFICATE-----\nMIIFazCCA1OgAwIBAgIR\n-----END CERTIFICATE-----\n';

let conn: AdminConnection;
let socket: FakeSocket;

async function connect(props: Partial<ConnectionProps> = {}): Promise<void> {
    ({ conn, socket } = await createLoggedInConnection(AdminConnection, props));
    socket.clearRequests();
}

/** Every test gets a logged-in AdminConnection with faked setTimeout */
function useConnection(): void {
    beforeEach(async () => {
        resetGlobals();
        mock.timers.enable({ apis: ['setTimeout'] });
        await connect();
    });

    afterEach(() => {
        conn?.destroy();
        mock.timers.reset();
        mock.restoreAll();
    });
}

/** For the plain error texts of the server */
function is(expected: unknown): (error: unknown) => boolean {
    return error => error === expected;
}

function isError(message: string): (error: unknown) => boolean {
    return error => error instanceof Error && error.message === message;
}

function assertTimedOut(state: Tracked<unknown>): void {
    assert.ok(state.error instanceof Error, 'The request did not time out');
    assert.equal(state.error.message, ERRORS.TIMEOUT);
}

/** Counts the requests with this name whose first arguments are the given ones */
function countRequests(name: string, ...args: unknown[]): number {
    return socket.requestsOf(name).filter(request => args.every((arg, i) => request.args[i] === arg)).length;
}

type FetchImplementation = (url: string, init: RequestInit) => Promise<unknown>;

function mockFetch(implementation: FetchImplementation): Mock<FetchImplementation> {
    return mock.method(globalThis as unknown as { fetch: FetchImplementation }, 'fetch', implementation);
}

type Call = (c: AdminConnection) => Promise<unknown>;

/** Every public request method, called with typical arguments */
const ALL_METHODS: Record<string, Call> = {
    getCertificates: c => c.getCertificates(),
    getLogs: c => c.getLogs('system.host.a'),
    upgradeAdapterWithWebserver: c => c.upgradeAdapterWithWebserver('system.host.a', WEBSERVER_OPTIONS),
    upgradeController: c => c.upgradeController('system.host.a', '7.1.0', 1),
    updateLicenses: c => c.updateLicenses('user@example.com', 'secret'),
    upgradeOsPackages: c => c.upgradeOsPackages('system.host.a', [{ name: 'git' }]),
    getLogsFiles: c => c.getLogsFiles('system.host.a'),
    delLogs: c => c.delLogs('system.host.a'),
    deleteFile: c => c.deleteFile('vis.0', 'main/old.json'),
    deleteFolder: c => c.deleteFolder('vis.0', 'main/img'),
    rename: c => c.rename('vis.0', 'main/a.json', 'main/b.json'),
    renameFile: c => c.renameFile('vis.0', 'main/a.json', 'main/b.json'),
    getHosts: c => c.getHosts(),
    getUsers: c => c.getUsers(),
    renameGroup: c => c.renameGroup('system.group.a', 'system.group.b', 'B'),
    getHostInfo: c => c.getHostInfo('a'),
    getHostInfoShort: c => c.getHostInfoShort('a'),
    getRepository: c => c.getRepository('a'),
    getInstalled: c => c.getInstalled('a'),
    cmdExec: c => c.cmdExec('a', 'ls', 1),
    readBaseSettings: c => c.readBaseSettings('a'),
    writeBaseSettings: c => c.writeBaseSettings('a', BASE_SETTINGS),
    restartController: c => c.restartController('a'),
    getDiagData: c => c.getDiagData('a', 'normal'),
    changePassword: c => c.changePassword('system.user.admin', 'secret'),
    getIpAddresses: c => c.getIpAddresses('a'),
    getHostByIp: c => c.getHostByIp('a'),
    encrypt: c => c.encrypt('plain'),
    decrypt: c => c.decrypt('crypted'),
    chmodFile: c => c.chmodFile('vis.0', 'main/*', { mode: 0o644 }),
    chownFile: c => c.chownFile('vis.0', 'main/*', { owner: 'system.user.admin' }),
    getNotifications: c => c.getNotifications('system.host.a'),
    clearNotifications: c => c.clearNotifications('system.host.a', 'system'),
    getIsEasyModeStrict: c => c.getIsEasyModeStrict(),
    getEasyMode: c => c.getEasyMode(),
    getRatings: c => c.getRatings(),
    getCurrentSession: c => c.getCurrentSession(),
    getCurrentInstance: c => c.getCurrentInstance(),
    getAdapterInstances: c => c.getAdapterInstances(),
    getAdapters: c => c.getAdapters(),
    getCompactAdapters: c => c.getCompactAdapters(),
    getCompactInstances: c => c.getCompactInstances(),
    getCompactInstalled: c => c.getCompactInstalled('a'),
    getCompactRepository: c => c.getCompactRepository('a'),
    getCompactHosts: c => c.getCompactHosts(),
    getCompactSystemRepositories: c => c.getCompactSystemRepositories(),
};

interface WrapperCase {
    method: string;
    call: Call;
    /** The emitted event and its arguments without the callback */
    request: [string, ...unknown[]];
    /** The arguments of the answer of the server */
    answer: unknown[];
    result: unknown;
    error?: { answer: unknown[]; rejection: (error: unknown) => boolean };
}

const WRAPPERS: WrapperCase[] = [
    {
        method: 'getLogs',
        call: c => c.getLogs('system.host.a', 100),
        request: ['sendToHost', 'system.host.a', 'getLogs', 100],
        answer: [['line 1', 'line 2', 2048]],
        result: ['line 1', 'line 2', 2048],
    },
    {
        method: 'upgradeAdapterWithWebserver',
        call: ALL_METHODS.upgradeAdapterWithWebserver,
        request: ['sendToHost', 'system.host.a', 'upgradeAdapterWithWebserver', WEBSERVER_OPTIONS],
        answer: [{ result: true }],
        result: { result: true },
    },
    {
        method: 'upgradeController',
        call: ALL_METHODS.upgradeController,
        request: ['sendToHost', 'system.host.a', 'upgradeController', { version: '7.1.0', adminInstance: 1 }],
        answer: [{ result: 'started' }],
        result: 'started',
        error: { answer: [{ error: 'Update is running' }], rejection: is('Update is running') },
    },
    {
        method: 'updateLicenses',
        call: ALL_METHODS.updateLicenses,
        request: ['updateLicenses', 'user@example.com', 'secret'],
        answer: [null, [LICENSE]],
        result: [LICENSE],
        error: { answer: ['Cannot login'], rejection: is('Cannot login') },
    },
    {
        method: 'upgradeOsPackages',
        call: c => c.upgradeOsPackages('system.host.a', [{ name: 'git', version: '2.40' }]),
        request: [
            'sendToHost',
            'system.host.a',
            'upgradeOsPackages',
            { packages: [{ name: 'git', version: '2.40' }], restart: false },
        ],
        answer: [{ success: true }],
        result: { success: true },
    },
    {
        method: 'getLogsFiles',
        call: ALL_METHODS.getLogsFiles,
        request: ['readLogs', 'system.host.a'],
        answer: [null, LOG_FILES],
        result: LOG_FILES,
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'delLogs',
        call: ALL_METHODS.delLogs,
        request: ['sendToHost', 'system.host.a', 'delLogs', null],
        answer: [null],
        result: undefined,
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'deleteFile',
        call: ALL_METHODS.deleteFile,
        request: ['deleteFile', 'vis.0', 'main/old.json'],
        answer: [null],
        result: undefined,
        error: { answer: ['Not exists'], rejection: is('Not exists') },
    },
    {
        method: 'deleteFolder',
        call: ALL_METHODS.deleteFolder,
        request: ['deleteFolder', 'vis.0', 'main/img'],
        answer: [null],
        result: undefined,
        error: { answer: ['Not exists'], rejection: is('Not exists') },
    },
    {
        method: 'rename',
        call: ALL_METHODS.rename,
        request: ['rename', 'vis.0', 'main/a.json', 'main/b.json'],
        answer: [null],
        result: undefined,
        error: { answer: ['Not exists'], rejection: is('Not exists') },
    },
    {
        method: 'renameFile',
        call: ALL_METHODS.renameFile,
        request: ['renameFile', 'vis.0', 'main/a.json', 'main/b.json'],
        answer: [null],
        result: undefined,
        error: { answer: ['Not exists'], rejection: is('Not exists') },
    },
    {
        method: 'getHosts',
        call: ALL_METHODS.getHosts,
        request: ['getObjectView', 'system', 'host', { startkey: 'system.host.', endkey: 'system.host.\u9999' }],
        answer: [null, { rows: [{ id: 'system.host.a', value: HOST_OBJECT }] }],
        result: [HOST_OBJECT],
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getUsers',
        call: ALL_METHODS.getUsers,
        request: ['getObjectView', 'system', 'user', { startkey: 'system.user.', endkey: 'system.user.\u9999' }],
        answer: [null, { rows: [{ id: 'system.user.admin', value: USER }] }],
        result: [USER],
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'cmdExec',
        call: c => c.cmdExec('a', 'ls -la', 7),
        request: ['cmdExec', 'system.host.a', 7, 'ls -la'],
        answer: [null],
        result: undefined,
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'readBaseSettings',
        call: c => c.readBaseSettings('system.host.a'),
        request: ['sendToHost', 'a', 'readBaseSettings', null],
        answer: [{ config: BASE_SETTINGS, isActive: true }],
        result: { config: BASE_SETTINGS, isActive: true },
        error: { answer: ['permissionError'], rejection: is('May not read "BaseSettings"') },
    },
    {
        method: 'writeBaseSettings',
        call: c => c.writeBaseSettings('system.host.a', BASE_SETTINGS),
        request: ['sendToHost', 'a', 'writeBaseSettings', BASE_SETTINGS],
        answer: [{ result: 'ok' }],
        result: { result: 'ok' },
        error: { answer: ['permissionError'], rejection: is('May not write "BaseSettings"') },
    },
    {
        method: 'restartController',
        call: c => c.restartController('system.host.a'),
        request: ['sendToHost', 'a', 'restartController', null],
        answer: [''],
        result: true,
    },
    {
        method: 'getDiagData',
        call: c => c.getDiagData('system.host.a', 'extended'),
        request: ['sendToHost', 'a', 'getDiagData', 'extended'],
        answer: [DIAG_DATA],
        result: DIAG_DATA,
    },
    {
        method: 'changePassword',
        call: ALL_METHODS.changePassword,
        request: ['changePassword', 'system.user.admin', 'secret'],
        answer: [null],
        result: undefined,
        error: { answer: ['Password is too short'], rejection: is('Password is too short') },
    },
    {
        method: 'encrypt',
        call: ALL_METHODS.encrypt,
        request: ['encrypt', 'plain'],
        answer: [null, 'crypted'],
        result: 'crypted',
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'decrypt',
        call: ALL_METHODS.decrypt,
        request: ['decrypt', 'crypted'],
        answer: [null, 'plain'],
        result: 'plain',
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'chmodFile',
        call: ALL_METHODS.chmodFile,
        request: ['chmodFile', 'vis.0', 'main/*', { mode: 0o644 }],
        answer: [null, CHANGED_FILES],
        result: CHANGED_FILES,
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'chownFile',
        call: ALL_METHODS.chownFile,
        request: ['chownFile', 'vis.0', 'main/*', { owner: 'system.user.admin' }],
        answer: [null, CHANGED_FILES],
        result: CHANGED_FILES,
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getNotifications',
        call: c => c.getNotifications('system.host.a', 'system'),
        request: ['sendToHost', 'system.host.a', 'getNotifications', { category: 'system' }],
        answer: [NOTIFICATIONS],
        result: NOTIFICATIONS,
    },
    {
        method: 'clearNotifications',
        call: ALL_METHODS.clearNotifications,
        request: ['sendToHost', 'system.host.a', 'clearNotifications', { category: 'system' }],
        answer: [{ result: 'ok' }],
        result: { result: 'ok' },
    },
    {
        method: 'getIsEasyModeStrict',
        call: ALL_METHODS.getIsEasyModeStrict,
        request: ['getIsEasyModeStrict'],
        answer: [null, true],
        result: true,
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getEasyMode',
        call: ALL_METHODS.getEasyMode,
        request: ['getEasyMode'],
        answer: [null, EASY_MODE],
        result: EASY_MODE,
        error: { answer: ['permissionError'], rejection: isError('permissionError') },
    },
    {
        method: 'getRatings',
        call: c => c.getRatings(true),
        request: ['getRatings', true],
        answer: [null, RATINGS],
        result: RATINGS,
        error: { answer: ['Cannot read ratings'], rejection: isError('Cannot read ratings') },
    },
    {
        method: 'getCurrentInstance',
        call: ALL_METHODS.getCurrentInstance,
        request: ['getCurrentInstance'],
        answer: [null, 'admin.0'],
        result: 'admin.0',
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getAdapterInstances',
        call: c => c.getAdapterInstances('hm-rpc'),
        request: ['getAdapterInstances', 'hm-rpc'],
        answer: [null, [INSTANCE]],
        result: [INSTANCE],
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getAdapters',
        call: c => c.getAdapters('hm-rpc'),
        request: ['getAdapters', 'hm-rpc'],
        answer: [null, [ADAPTER]],
        result: [ADAPTER],
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getCompactAdapters',
        call: ALL_METHODS.getCompactAdapters,
        request: ['getCompactAdapters'],
        answer: [null, { admin: { icon: 'admin.png', v: '7.6.1' } }],
        result: { admin: { icon: 'admin.png', v: '7.6.1' } },
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getCompactInstances',
        call: ALL_METHODS.getCompactInstances,
        request: ['getCompactInstances'],
        answer: [null, { 'system.adapter.admin.0': { adminTab: null, name: 'admin', icon: 'admin.png' } }],
        result: { 'system.adapter.admin.0': { adminTab: null, name: 'admin', icon: 'admin.png' } },
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getCompactHosts',
        call: ALL_METHODS.getCompactHosts,
        request: ['getCompactHosts'],
        answer: [null, [{ _id: 'system.host.a', common: { name: 'a' }, native: { hardware: {} } }]],
        result: [{ _id: 'system.host.a', common: { name: 'a' }, native: { hardware: {} } }],
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
    {
        method: 'getCompactSystemRepositories',
        call: ALL_METHODS.getCompactSystemRepositories,
        request: ['getCompactSystemRepositories'],
        answer: [null, { _id: 'system.repositories', native: { repositories: {} } }],
        result: { _id: 'system.repositories', native: { repositories: {} } },
        error: { answer: ['permissionError'], rejection: is('permissionError') },
    },
];

describe('AdminConnection request wrappers', () => {
    useConnection();
    beforeEach(() => socket.respond('checkFeatureSupported', () => [null, true]));

    for (const { method, call, request, answer, result, error } of WRAPPERS) {
        const [event, ...args] = request;

        it(`${method} sends "${event}" and resolves with the answer`, async () => {
            socket.respond(event, () => answer);

            assert.deepEqual(await call(conn), result);
            assert.equal(socket.requestsOf(event).length, 1);
            assert.deepEqual(socket.lastRequest(event).args, args);
        });

        if (error) {
            it(`${method} rejects with the error of the server`, async () => {
                socket.respond(event, () => error.answer);

                await assert.rejects(call(conn), error.rejection);
            });
        }
    }
});

interface HostCommandCase {
    method: string;
    call: (c: AdminConnection, host: string, timeoutMs?: number) => Promise<unknown>;
    event: string;
    /** The arguments of the request for the host "a" */
    args: unknown[];
    answer: unknown;
}

/** The methods that check the answer of the host and accept a timeout */
const HOST_COMMANDS: HostCommandCase[] = [
    {
        method: 'getHostInfo',
        call: (c, host, timeoutMs) => c.getHostInfo(host, false, timeoutMs),
        event: 'sendToHost',
        args: ['system.host.a', 'getHostInfo', null],
        answer: HOST_INFO,
    },
    {
        method: 'getHostInfoShort',
        call: (c, host, timeoutMs) => c.getHostInfoShort(host, false, timeoutMs),
        event: 'sendToHost',
        args: ['system.host.a', 'getHostInfoShort', null],
        answer: HOST_INFO,
    },
    {
        method: 'getRepository',
        call: (c, host, timeoutMs) => c.getRepository(host, { repo: 'stable', update: true }, false, timeoutMs),
        event: 'sendToHost',
        args: ['a', 'getRepository', { repo: 'stable', update: true }],
        answer: REPOSITORY,
    },
    {
        method: 'getInstalled',
        call: (c, host, timeoutMs) => c.getInstalled(host, false, timeoutMs),
        event: 'sendToHost',
        args: ['system.host.a', 'getInstalled', null],
        answer: INSTALLED,
    },
    {
        method: 'getCompactInstalled',
        call: (c, host, timeoutMs) => c.getCompactInstalled(host, false, timeoutMs),
        event: 'getCompactInstalled',
        args: ['system.host.a'],
        answer: { admin: { version: '7.6.1' } },
    },
    {
        method: 'getCompactRepository',
        call: (c, host, timeoutMs) => c.getCompactRepository(host, false, timeoutMs),
        event: 'getCompactRepository',
        args: ['system.host.a'],
        answer: { admin: { icon: 'admin.png', version: '7.6.1' } },
    },
];

describe('AdminConnection host commands with checked answers', () => {
    useConnection();

    for (const { method, call, event, args, answer } of HOST_COMMANDS) {
        it(`${method} sends "${event}" and resolves with the answer`, async () => {
            const promise = call(conn, 'a');
            assert.deepEqual(socket.lastRequest(event).args, args);

            socket.lastAnswer(event)(answer);

            assert.deepEqual(await promise, answer);
        });

        it(`${method} rejects on a permission error`, async () => {
            const promise = call(conn, 'a');
            socket.lastAnswer(event)(ERRORS.PERMISSION_ERROR);

            await assert.rejects(promise, is(`May not read "${method}"`));
        });

        it(`${method} rejects on the permission error of socket-classes 2.x`, async () => {
            const promise = call(conn, 'a');
            socket.lastAnswer(event)({ error: ERRORS.PERMISSION_ERROR });

            await assert.rejects(promise, is(`May not read "${method}"`));
        });

        it(`${method} rejects with an error that came instead of the data and asks anew on the next call`, async () => {
            const promise = call(conn, 'a');
            socket.lastAnswer(event)({ error: 'Cannot reach the host' });
            await assert.rejects(promise, is('Cannot reach the host'));

            void call(conn, 'a').catch(() => {});
            assert.equal(socket.requestsOf(event).length, 2);
        });

        it(`${method} rejects on an empty answer`, async () => {
            const promise = call(conn, 'a');
            socket.lastAnswer(event)(null);

            await assert.rejects(promise, is(`Cannot read "${method}"`));
        });

        it(`${method} times out after the given time and asks anew on the next call`, async () => {
            const promise = track(call(conn, 'a', 1000));

            mock.timers.tick(999);
            await flush();
            assert.equal(promise.settled, false);
            mock.timers.tick(1);
            await flush();
            assertTimedOut(promise);

            socket.lastAnswer(event)(answer);
            const next = call(conn, 'a');
            assert.equal(socket.requestsOf(event).length, 2);
            socket.lastAnswer(event)(answer);
            assert.deepEqual(await next, answer);
        });
    }

    it('getRepository sends the arguments as they are', () => {
        void conn.getRepository('system.host.a', 'stable').catch(() => {});
        void conn.getRepository('system.host.b').catch(() => {});

        assert.deepEqual(socket.requestsOf('sendToHost')[0].args, ['system.host.a', 'getRepository', 'stable']);
        assert.deepEqual(socket.requestsOf('sendToHost')[1].args, ['system.host.b', 'getRepository', undefined]);
    });

    it('uses the cmdTimeout of the connection as the default timeout', async () => {
        conn.destroy();
        await connect({ cmdTimeout: 10_000 });

        const promise = track(conn.getHostInfo('a'));
        mock.timers.tick(9999);
        await flush();
        assert.equal(promise.settled, false);
        mock.timers.tick(1);
        await flush();
        assertTimedOut(promise);
    });

    it('asks the server again after a rejected answer', async () => {
        const first = conn.getHostInfo('a');
        socket.lastAnswer('sendToHost')(null);
        await assert.rejects(first);

        const next = track(conn.getHostInfo('a'));
        assert.equal(socket.requestsOf('sendToHost').length, 2);
        socket.lastAnswer('sendToHost')(HOST_INFO);
        await flush();
        assert.deepEqual(next.value, HOST_INFO);
    });
});

describe('AdminConnection host ids', () => {
    useConnection();
    beforeEach(() => socket.respond('checkFeatureSupported', () => [null, true]));

    /** The request that carries the host and the index of the host in its arguments. Cached methods update, to ask twice */
    const HOST_ARGUMENT: {
        method: string;
        call: (c: AdminConnection, host: string) => Promise<unknown>;
        event: string;
        index: number;
        handling: 'object id' | 'host name' | 'as given';
    }[] = [
        {
            method: 'getHostInfo',
            call: (c, h) => c.getHostInfo(h, true),
            event: 'sendToHost',
            index: 0,
            handling: 'object id',
        },
        {
            method: 'getHostInfoShort',
            call: (c, h) => c.getHostInfoShort(h, true),
            event: 'sendToHost',
            index: 0,
            handling: 'object id',
        },
        {
            method: 'getInstalled',
            call: (c, h) => c.getInstalled(h, true),
            event: 'sendToHost',
            index: 0,
            handling: 'object id',
        },
        {
            method: 'getCompactInstalled',
            call: (c, h) => c.getCompactInstalled(h, true),
            event: 'getCompactInstalled',
            index: 0,
            handling: 'object id',
        },
        {
            method: 'getCompactRepository',
            call: (c, h) => c.getCompactRepository(h, true),
            event: 'getCompactRepository',
            index: 0,
            handling: 'object id',
        },
        { method: 'cmdExec', call: (c, h) => c.cmdExec(h, 'ls', 1), event: 'cmdExec', index: 0, handling: 'object id' },
        {
            method: 'getIpAddresses',
            call: (c, h) => c.getIpAddresses(h, true),
            event: 'getObject',
            index: 0,
            handling: 'object id',
        },
        {
            method: 'readBaseSettings',
            call: (c, h) => c.readBaseSettings(h),
            event: 'sendToHost',
            index: 0,
            handling: 'host name',
        },
        {
            method: 'writeBaseSettings',
            call: (c, h) => c.writeBaseSettings(h, BASE_SETTINGS),
            event: 'sendToHost',
            index: 0,
            handling: 'host name',
        },
        {
            method: 'restartController',
            call: (c, h) => c.restartController(h),
            event: 'sendToHost',
            index: 0,
            handling: 'host name',
        },
        {
            method: 'getDiagData',
            call: (c, h) => c.getDiagData(h, 'none'),
            event: 'sendToHost',
            index: 0,
            handling: 'host name',
        },
        {
            method: 'getHostByIp',
            call: (c, h) => c.getHostByIp(h, true),
            event: 'getHostByIp',
            index: 0,
            handling: 'host name',
        },
        {
            method: 'getRepository',
            call: (c, h) => c.getRepository(h, null, true),
            event: 'sendToHost',
            index: 0,
            handling: 'as given',
        },
        { method: 'getLogs', call: (c, h) => c.getLogs(h), event: 'sendToHost', index: 0, handling: 'as given' },
        {
            method: 'getLogsFiles',
            call: (c, h) => c.getLogsFiles(h),
            event: 'readLogs',
            index: 0,
            handling: 'as given',
        },
        { method: 'delLogs', call: (c, h) => c.delLogs(h), event: 'sendToHost', index: 0, handling: 'as given' },
        {
            method: 'upgradeController',
            call: (c, h) => c.upgradeController(h, '7.1.0', 1),
            event: 'sendToHost',
            index: 0,
            handling: 'as given',
        },
        {
            method: 'getNotifications',
            call: (c, h) => c.getNotifications(h),
            event: 'sendToHost',
            index: 0,
            handling: 'as given',
        },
        {
            method: 'clearNotifications',
            call: (c, h) => c.clearNotifications(h, 'system'),
            event: 'sendToHost',
            index: 0,
            handling: 'as given',
        },
    ];

    const EXPECTED = {
        'object id': ['system.host.a', 'system.host.a'],
        'host name': ['a', 'a'],
        'as given': ['a', 'system.host.a'],
    };

    for (const { method, call, event, index, handling } of HOST_ARGUMENT) {
        it(`${method} sends a host name and a host object id as ${handling}`, async () => {
            void call(conn, 'a').catch(() => {});
            void call(conn, 'system.host.a').catch(() => {});
            await flush();

            assert.deepEqual(
                socket.requestsOf(event).map(request => request.args[index]),
                EXPECTED[handling],
            );
        });
    }

    const CACHED_PER_HOST: {
        method: string;
        call: (c: AdminConnection, host: string) => Promise<unknown>;
        event: string;
    }[] = [
        { method: 'getHostInfo', call: (c, h) => c.getHostInfo(h), event: 'sendToHost' },
        { method: 'getHostInfoShort', call: (c, h) => c.getHostInfoShort(h), event: 'sendToHost' },
        { method: 'getInstalled', call: (c, h) => c.getInstalled(h), event: 'sendToHost' },
        { method: 'getCompactInstalled', call: (c, h) => c.getCompactInstalled(h), event: 'getCompactInstalled' },
        { method: 'getCompactRepository', call: (c, h) => c.getCompactRepository(h), event: 'getCompactRepository' },
        { method: 'getIpAddresses', call: (c, h) => c.getIpAddresses(h), event: 'getObject' },
        { method: 'getHostByIp', call: (c, h) => c.getHostByIp(h), event: 'getHostByIp' },
    ];

    for (const { method, call, event } of CACHED_PER_HOST) {
        it(`${method} caches per host and shares the cache of a host name and its object id`, () => {
            void call(conn, 'a').catch(() => {});
            void call(conn, 'system.host.a').catch(() => {});
            void call(conn, 'b').catch(() => {});

            assert.equal(socket.requestsOf(event).length, 2);
        });
    }

    it('getRepository shares the cache of a host name and its object id', () => {
        void conn.getRepository('a').catch(() => {});
        void conn.getRepository('system.host.a').catch(() => {});

        assert.equal(socket.requestsOf('sendToHost').length, 1);
    });
});

describe('AdminConnection caching', () => {
    useConnection();

    const CACHED: {
        method: string;
        call: (c: AdminConnection, update?: boolean) => Promise<unknown>;
        event: string;
        answer: unknown[];
    }[] = [
        { method: 'getCertificates', call: (c, u) => c.getCertificates(u), event: 'getObject', answer: [null, null] },
        { method: 'getHosts', call: (c, u) => c.getHosts(u), event: 'getObjectView', answer: [null, { rows: [] }] },
        { method: 'getUsers', call: (c, u) => c.getUsers(u), event: 'getObjectView', answer: [null, { rows: [] }] },
        { method: 'getHostInfo', call: (c, u) => c.getHostInfo('a', u), event: 'sendToHost', answer: [HOST_INFO] },
        {
            method: 'getHostInfoShort',
            call: (c, u) => c.getHostInfoShort('a', u),
            event: 'sendToHost',
            answer: [HOST_INFO],
        },
        {
            method: 'getRepository',
            call: (c, u) => c.getRepository('a', null, u),
            event: 'sendToHost',
            answer: [REPOSITORY],
        },
        { method: 'getInstalled', call: (c, u) => c.getInstalled('a', u), event: 'sendToHost', answer: [INSTALLED] },
        {
            method: 'getIpAddresses',
            call: (c, u) => c.getIpAddresses('a', u),
            event: 'getObject',
            answer: [null, HOST_OBJECT],
        },
        {
            method: 'getHostByIp',
            call: (c, u) => c.getHostByIp('a', u),
            event: 'getHostByIp',
            answer: ['a', HOST_OBJECT],
        },
        {
            method: 'getAdapterInstances',
            call: (c, u) => c.getAdapterInstances('hm-rpc', u),
            event: 'getAdapterInstances',
            answer: [null, [INSTANCE]],
        },
        {
            method: 'getAdapters',
            call: (c, u) => c.getAdapters('hm-rpc', u),
            event: 'getAdapters',
            answer: [null, [ADAPTER]],
        },
        {
            method: 'getCompactAdapters',
            call: (c, u) => c.getCompactAdapters(u),
            event: 'getCompactAdapters',
            answer: [null, {}],
        },
        {
            method: 'getCompactInstances',
            call: (c, u) => c.getCompactInstances(u),
            event: 'getCompactInstances',
            answer: [null, {}],
        },
        {
            method: 'getCompactInstalled',
            call: (c, u) => c.getCompactInstalled('a', u),
            event: 'getCompactInstalled',
            answer: [{}],
        },
        {
            method: 'getCompactRepository',
            call: (c, u) => c.getCompactRepository('a', u),
            event: 'getCompactRepository',
            answer: [{}],
        },
        {
            method: 'getCompactHosts',
            call: (c, u) => c.getCompactHosts(u),
            event: 'getCompactHosts',
            answer: [null, []],
        },
        {
            method: 'getCompactSystemRepositories',
            call: (c, u) => c.getCompactSystemRepositories(u),
            event: 'getCompactSystemRepositories',
            answer: [null, {}],
        },
    ];

    for (const { method, call, event, answer } of CACHED) {
        it(`${method} answers from the cache until an update is forced`, async () => {
            socket.respond(event, () => answer);

            const first = await call(conn);
            const second = await call(conn);
            assert.equal(socket.requestsOf(event).length, 1);
            assert.equal(second, first);

            await call(conn, true);
            assert.equal(socket.requestsOf(event).length, 2);
        });
    }

    it('getCurrentInstance asks only once until its cache is reset', async () => {
        socket.respond('getCurrentInstance', () => [null, 'admin.0']);

        assert.equal(await conn.getCurrentInstance(), 'admin.0');
        assert.equal(await conn.getCurrentInstance(), 'admin.0');
        assert.equal(socket.requestsOf('getCurrentInstance').length, 1);

        conn.resetCache('currentInstance');
        socket.respond('getCurrentInstance', () => [null, 'admin.1']);
        assert.equal(await conn.getCurrentInstance(), 'admin.1');
    });

    const NOT_CACHED: [string, Call, string, unknown[]][] = [
        ['getLogs', ALL_METHODS.getLogs, 'sendToHost', [[]]],
        ['getLogsFiles', ALL_METHODS.getLogsFiles, 'readLogs', [null, []]],
        ['getNotifications', ALL_METHODS.getNotifications, 'sendToHost', [NOTIFICATIONS]],
        ['getDiagData', ALL_METHODS.getDiagData, 'sendToHost', [DIAG_DATA]],
        ['getIsEasyModeStrict', ALL_METHODS.getIsEasyModeStrict, 'getIsEasyModeStrict', [null, true]],
        ['getEasyMode', ALL_METHODS.getEasyMode, 'getEasyMode', [null, EASY_MODE]],
        ['getRatings', ALL_METHODS.getRatings, 'getRatings', [null, RATINGS]],
        ['readBaseSettings', ALL_METHODS.readBaseSettings, 'sendToHost', [{ config: BASE_SETTINGS }]],
    ];

    for (const [method, call, event, answer] of NOT_CACHED) {
        it(`${method} asks the server on every call`, async () => {
            socket.respond('checkFeatureSupported', () => [null, true]);
            socket.respond(event, () => answer);

            await call(conn);
            await call(conn);

            assert.equal(socket.requestsOf(event).length, 2);
        });
    }

    it('keeps the cached values while disconnected', async () => {
        socket.respond('getCompactHosts', () => [null, []]);
        const hosts = await conn.getCompactHosts();

        socket.fire('disconnect');

        assert.equal(await conn.getCompactHosts(), hosts);
        await assert.rejects(conn.getCompactHosts(true), isError(ERRORS.NOT_CONNECTED));
    });
});

describe('AdminConnection cache resets', () => {
    useConnection();
    beforeEach(() => {
        socket.respond('sendToHost', (host, command) => [{ host, command }]);
        socket.respond('getCompactInstalled', host => [{ host }]);
        socket.respond('getCompactRepository', host => [{ host }]);
        socket.respond('getAdapters', () => [null, []]);
        socket.respond('getCompactAdapters', () => [null, {}]);
        socket.respond('getAdapterInstances', () => [null, []]);
        socket.respond('getCompactInstances', () => [null, {}]);
    });

    async function loadInstalled(hosts: string[]): Promise<void> {
        for (const host of hosts) {
            await conn.getInstalled(host);
            await conn.getCompactInstalled(host);
        }
    }

    async function loadRepositories(hosts: string[]): Promise<void> {
        for (const host of hosts) {
            await conn.getRepository(host);
            await conn.getCompactRepository(host);
        }
    }

    function installedRequests(host: string): [number, number] {
        return [countRequests('sendToHost', host, 'getInstalled'), countRequests('getCompactInstalled', host)];
    }

    function repositoryRequests(host: string, compactHost = host): [number, number] {
        return [countRequests('sendToHost', host, 'getRepository'), countRequests('getCompactRepository', compactHost)];
    }

    it('getInstalledResetCache resets the installed and compact installed info of one host', async () => {
        const hosts = ['system.host.a', 'system.host.b'];
        await loadInstalled(hosts);

        conn.getInstalledResetCache('system.host.a');
        await loadInstalled(hosts);

        assert.deepEqual(installedRequests('system.host.a'), [2, 2]);
        assert.deepEqual(installedRequests('system.host.b'), [1, 1]);
    });

    it('getInstalledResetCache without a host resets the info of all hosts', async () => {
        const hosts = ['system.host.a', 'system.host.b'];
        await loadInstalled(hosts);

        conn.getInstalledResetCache();
        await loadInstalled(hosts);

        assert.deepEqual(installedRequests('system.host.a'), [2, 2]);
        assert.deepEqual(installedRequests('system.host.b'), [2, 2]);
    });

    it('getInstalledResetCache accepts a host name like getInstalled', async () => {
        await loadInstalled(['a']);

        conn.getInstalledResetCache('a');
        await loadInstalled(['a']);

        assert.deepEqual(installedRequests('system.host.a'), [2, 2]);
    });

    it('getRepositoryResetCache resets the repository and compact repository of one host', async () => {
        const hosts = ['system.host.a', 'system.host.b'];
        await loadRepositories(hosts);

        conn.getRepositoryResetCache('system.host.a');
        await loadRepositories(hosts);

        assert.deepEqual(repositoryRequests('system.host.a'), [2, 2]);
        assert.deepEqual(repositoryRequests('system.host.b'), [1, 1]);
    });

    it('getRepositoryResetCache without a host resets the repositories of all hosts', async () => {
        const hosts = ['system.host.a', 'system.host.b'];
        await loadRepositories(hosts);

        conn.getRepositoryResetCache('');
        await loadRepositories(hosts);

        assert.deepEqual(repositoryRequests('system.host.a'), [2, 2]);
        assert.deepEqual(repositoryRequests('system.host.b'), [2, 2]);
    });

    it('getRepositoryResetCache accepts a host name like getCompactRepository', async () => {
        await loadRepositories(['a']);

        conn.getRepositoryResetCache('a');
        await loadRepositories(['a']);

        assert.deepEqual(repositoryRequests('a', 'system.host.a'), [2, 2]);
    });

    it('getAdaptersResetCache resets one adapter and the compact adapters', async () => {
        const load = async (): Promise<void> => {
            await conn.getAdapters();
            await conn.getAdapters('hm-rpc');
            await conn.getAdapters('zigbee');
            await conn.getCompactAdapters();
        };
        await load();

        conn.getAdaptersResetCache('hm-rpc');
        await load();

        assert.equal(countRequests('getAdapters', ''), 1);
        assert.equal(countRequests('getAdapters', 'hm-rpc'), 2);
        assert.equal(countRequests('getAdapters', 'zigbee'), 1);
        assert.equal(countRequests('getCompactAdapters'), 2);

        conn.getAdaptersResetCache();
        await load();

        assert.equal(countRequests('getAdapters', ''), 2);
        assert.equal(countRequests('getAdapters', 'hm-rpc'), 2);
        assert.equal(countRequests('getCompactAdapters'), 3);
    });

    it('getAdapterInstancesResetCache resets one adapter and the compact instances', async () => {
        const load = async (): Promise<void> => {
            await conn.getAdapterInstances();
            await conn.getAdapterInstances('hm-rpc');
            await conn.getAdapterInstances('zigbee');
            await conn.getCompactInstances();
        };
        await load();

        conn.getAdapterInstancesResetCache('hm-rpc');
        await load();

        assert.equal(countRequests('getAdapterInstances', ''), 1);
        assert.equal(countRequests('getAdapterInstances', 'hm-rpc'), 2);
        assert.equal(countRequests('getAdapterInstances', 'zigbee'), 1);
        assert.equal(countRequests('getCompactInstances'), 2);

        conn.getAdapterInstancesResetCache();
        await load();

        assert.equal(countRequests('getAdapterInstances', ''), 2);
        assert.equal(countRequests('getAdapterInstances', 'hm-rpc'), 2);
        assert.equal(countRequests('getCompactInstances'), 3);
    });
});

describe('AdminConnection timeouts', () => {
    useConnection();
    beforeEach(() => {
        socket.respond('checkFeatureSupported', () => [null, true]);
        delete socket.responders.getObject;
    });

    const WITH_DEFAULT_TIMEOUT = [
        'getHostInfo',
        'getHostInfoShort',
        'getRepository',
        'getInstalled',
        'cmdExec',
        'readBaseSettings',
        'writeBaseSettings',
        'restartController',
        'getDiagData',
        'changePassword',
        'getHostByIp',
        'encrypt',
        'decrypt',
        'chmodFile',
        'chownFile',
        'getNotifications',
        'clearNotifications',
        'getIsEasyModeStrict',
        'getEasyMode',
        'getRatings',
        'getCurrentInstance',
        'getAdapterInstances',
        'getAdapters',
        'getCompactAdapters',
        'getCompactInstances',
        'getCompactInstalled',
        'getCompactRepository',
        'getCompactHosts',
        'getCompactSystemRepositories',
    ];

    const WITHOUT_TIMEOUT = [
        'getCertificates',
        'getLogs',
        'upgradeAdapterWithWebserver',
        'upgradeController',
        'updateLicenses',
        'upgradeOsPackages',
        'getLogsFiles',
        'delLogs',
        'deleteFile',
        'deleteFolder',
        'rename',
        'renameFile',
        'getHosts',
        'getUsers',
        'renameGroup',
        'getIpAddresses',
    ];

    for (const method of WITH_DEFAULT_TIMEOUT) {
        it(`${method} rejects with a timeout after 5 seconds without an answer`, async () => {
            const promise = track(ALL_METHODS[method](conn));
            await flush();

            mock.timers.tick(4999);
            await flush();
            assert.equal(promise.settled, false);

            mock.timers.tick(1);
            await flush();
            assertTimedOut(promise);
        });
    }

    for (const method of WITHOUT_TIMEOUT) {
        it(`${method} waits for the answer without a timeout`, async () => {
            const promise = track(ALL_METHODS[method](conn));
            await flush();

            mock.timers.tick(3_600_000);
            await flush();

            assert.equal(promise.settled, false);
        });
    }

    it('lists every method in one of the timeout groups', () => {
        assert.deepEqual(
            [...WITH_DEFAULT_TIMEOUT, ...WITHOUT_TIMEOUT, 'getCurrentSession'].sort(),
            Object.keys(ALL_METHODS).sort(),
        );
    });
});

describe('AdminConnection in a web adapter', () => {
    useConnection();
    let fetchMock: Mock<FetchImplementation>;

    beforeEach(() => {
        (globalThis as any).socketUrl = 'http://localhost:8082';
        fetchMock = mockFetch(() => Promise.reject(new Error('fetch is not expected')));
    });

    afterEach(() => {
        delete (globalThis as any).socketUrl;
    });

    for (const [method, call] of Object.entries(ALL_METHODS)) {
        it(`${method} rejects with NOT_ADMIN without asking the server`, async () => {
            await assert.rejects(call(conn), isError(ERRORS.NOT_ADMIN));

            assert.equal(socket.requests.length, 0);
            assert.equal(fetchMock.mock.callCount(), 0);
        });
    }
});

describe('AdminConnection while disconnected', () => {
    useConnection();
    let fetchMock: Mock<FetchImplementation>;

    beforeEach(() => {
        socket.fire('disconnect');
        fetchMock = mockFetch(() => Promise.reject(new Error('fetch is not expected')));
    });

    for (const [method, call] of Object.entries(ALL_METHODS)) {
        it(`${method} rejects with NOT_CONNECTED without asking the server`, async () => {
            await assert.rejects(call(conn), isError(ERRORS.NOT_CONNECTED));

            assert.equal(socket.requests.length, 0);
            assert.equal(fetchMock.mock.callCount(), 0);
        });
    }
});

describe('AdminConnection.request', () => {
    class TestAdminConnection extends AdminConnection {
        send<T>(options: RequestOptions<T>): Promise<T> {
            return this.request(options);
        }
    }

    let testConn: TestAdminConnection;

    beforeEach(async () => {
        resetGlobals();
        mock.timers.enable({ apis: ['setTimeout'] });
        ({ conn: testConn, socket } = await createLoggedInConnection(TestAdminConnection));
        conn = testConn;
        socket.clearRequests();
    });

    afterEach(() => {
        conn?.destroy();
        mock.timers.reset();
        mock.restoreAll();
        delete (globalThis as any).socketUrl;
    });

    it('works outside of a web adapter', async () => {
        assert.equal(await testConn.send({ executor: resolve => resolve(42) }), 42);
    });

    it('requires the admin adapter for its own and the inherited requests', async () => {
        (globalThis as any).socketUrl = 'http://localhost:8082';

        await assert.rejects(testConn.send({ executor: resolve => resolve(42) }), isError(ERRORS.NOT_ADMIN));
        await assert.rejects(testConn.getObject('system.config'), isError(ERRORS.NOT_ADMIN));
        assert.equal(socket.requests.length, 0);
    });

    it('keeps requireAdmin false if a request sets it', async () => {
        (globalThis as any).socketUrl = 'http://localhost:8082';

        assert.equal(await testConn.send({ requireAdmin: false, executor: resolve => resolve(42) }), 42);
    });

    it('rejects in a web adapter even if the value is cached', async () => {
        socket.respond('getCompactHosts', () => [null, []]);
        await testConn.getCompactHosts();

        (globalThis as any).socketUrl = 'http://localhost:8082';

        await assert.rejects(testConn.getCompactHosts(), isError(ERRORS.NOT_ADMIN));
    });
});

describe('AdminConnection.getCertificates', () => {
    useConnection();

    function answerCertificates(certificates: Record<string, string> | undefined): void {
        socket.respond('getObject', id =>
            id === 'system.certificates'
                ? [null, { _id: id, type: 'config', common: {}, native: { certificates } }]
                : [null, null],
        );
    }

    it('reads system.certificates and classifies PEM keys and certificates', async () => {
        answerCertificates({
            rsaKey: PRIVATE_RSA_KEY,
            key: PRIVATE_KEY,
            cert: CERTIFICATE,
            chain: CERTIFICATE + CA_CERTIFICATE,
        });

        assert.deepEqual(await conn.getCertificates(), [
            { name: 'rsaKey', type: 'private' },
            { name: 'key', type: 'private' },
            { name: 'cert', type: 'public' },
            { name: 'chain', type: 'chained' },
        ]);
        assert.deepEqual(socket.lastRequest('getObject').args, ['system.certificates']);
    });

    it('classifies a file name by the name of the entry, then by the path', async () => {
        answerCertificates({
            defaultPrivate: '/opt/certs/key.pem',
            defaultPublic: '/opt/certs/cert.pem',
            defaultChained: '/opt/certs/ca.pem',
            otherKey: 'C:\\certs\\private.pem',
            otherCert: '/etc/ssl/public.crt',
            otherChain: '/etc/ssl/fullchain.pem',
        });

        assert.deepEqual(await conn.getCertificates(), [
            { name: 'defaultPrivate', type: 'private' },
            { name: 'defaultPublic', type: 'public' },
            { name: 'defaultChained', type: 'chained' },
            { name: 'otherKey', type: 'private' },
            { name: 'otherCert', type: 'public' },
            { name: 'otherChain', type: 'chained' },
        ]);
    });

    it('skips empty entries and file names without a hint of the type', async () => {
        answerCertificates({ empty: '', unknown: '/opt/certs/server.pem', cert: CERTIFICATE });

        assert.deepEqual(await conn.getCertificates(), [{ name: 'cert', type: 'public' }]);
    });

    it('resolves an empty list without certificates', async () => {
        answerCertificates(undefined);
        assert.deepEqual(await conn.getCertificates(), []);

        socket.respond('getObject', () => [null, null]);
        assert.deepEqual(await conn.getCertificates(true), []);
    });

    it('rejects with the error of getObject and asks anew on the next call', async () => {
        socket.respond('getObject', () => ['permissionError']);
        await assert.rejects(conn.getCertificates(), isError('permissionError'));

        answerCertificates({ cert: CERTIFICATE });
        assert.deepEqual(await conn.getCertificates(), [{ name: 'cert', type: 'public' }]);
    });

    it('recognizes a short PEM certificate whose base64 contains a slash', async () => {
        answerCertificates({ myCert: CERTIFICATE.replace('MIID', 'MI/D') });

        assert.deepEqual(await conn.getCertificates(), [{ name: 'myCert', type: 'public' }]);
    });

    it('recognizes EC, encrypted and indented private keys, also with a slash in the base64', async () => {
        answerCertificates({
            ec: '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEI/Ab\n-----END EC PRIVATE KEY-----\n',
            encrypted: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFH/zBJ\n-----END ENCRYPTED PRIVATE KEY-----\n',
            indented: `\n  ${PRIVATE_KEY.replace('MIIE', 'MI/E')}`,
            longIndented: `\n${PRIVATE_RSA_KEY.replace('MIIEowIBAAKCAQEA', 'A'.repeat(800))}`,
        });

        assert.deepEqual(await conn.getCertificates(), [
            { name: 'ec', type: 'private' },
            { name: 'encrypted', type: 'private' },
            { name: 'indented', type: 'private' },
            { name: 'longIndented', type: 'private' },
        ]);
    });
});

describe('AdminConnection.getHosts and getUsers', () => {
    useConnection();

    for (const [method, call] of [
        ['getHosts', ALL_METHODS.getHosts],
        ['getUsers', ALL_METHODS.getUsers],
    ] as const) {
        it(`${method} leaves out rows without an object`, async () => {
            socket.respond('getObjectView', () => [
                null,
                {
                    rows: [
                        { id: 'x.1', value: HOST_OBJECT },
                        { id: 'x.2', value: null },
                        { id: 'x.3', value: USER },
                    ],
                },
            ]);

            assert.deepEqual(await call(conn), [HOST_OBJECT, USER]);
        });

        it(`${method} resolves an empty list without a result`, async () => {
            socket.respond('getObjectView', () => [null, undefined]);

            assert.deepEqual(await call(conn), []);
        });
    }
});

describe('AdminConnection.renameGroup', () => {
    useConnection();

    function group(id: string, name?: string): Record<string, unknown> {
        return { _id: id, type: 'group', common: { name: name ?? id, members: [] }, native: {} };
    }

    let groups: Record<string, unknown>[];

    beforeEach(() => {
        groups = [
            group('system.group.a', 'A'),
            group('system.group.a.sub', 'Sub'),
            group('system.group.a.sub.deep', 'Deep'),
            group('system.group.ab', 'AB'),
        ];
        socket.respond('getObjectView', () => [
            null,
            { rows: groups.map(value => ({ id: value._id, value: JSON.parse(JSON.stringify(value)) })) },
        ]);
        socket.respond('setObject', () => [null]);
        socket.respond('delObject', () => [null]);
    });

    function changes(): [string, string][] {
        return socket.requests
            .filter(request => request.name === 'setObject' || request.name === 'delObject')
            .map(request => [request.name, request.args[0]]);
    }

    function written(id: string): unknown {
        return socket.requestsOf('setObject').find(request => request.args[0] === id)?.args[1];
    }

    it('moves the sub groups first, then the group, and leaves other groups alone', async () => {
        await conn.renameGroup('system.group.a', 'system.group.b', 'B');

        assert.deepEqual(changes(), [
            ['setObject', 'system.group.b.sub'],
            ['delObject', 'system.group.a.sub'],
            ['setObject', 'system.group.b.sub.deep'],
            ['delObject', 'system.group.a.sub.deep'],
            ['setObject', 'system.group.b'],
            ['delObject', 'system.group.a'],
        ]);
    });

    it('writes the objects under the new ids and gives only the group the new name', async () => {
        await conn.renameGroup('system.group.a', 'system.group.b', { en: 'B', de: 'B' });

        assert.deepEqual(written('system.group.b'), {
            ...group('system.group.b'),
            common: { name: { en: 'B', de: 'B' }, members: [] },
        });
        assert.deepEqual(written('system.group.b.sub'), group('system.group.b.sub', 'Sub'));
    });

    it('keeps the name if no new name is given', async () => {
        await conn.renameGroup('system.group.a', 'system.group.b', undefined as unknown as string);

        assert.deepEqual(written('system.group.b'), group('system.group.b', 'A'));
    });

    it('creates common for a group without it', async () => {
        groups = [{ _id: 'system.group.a', type: 'group', native: {} }];

        await conn.renameGroup('system.group.a', 'system.group.b', 'B');

        assert.deepEqual(written('system.group.b'), {
            _id: 'system.group.b',
            type: 'group',
            native: {},
            common: { name: 'B' },
        });
    });

    it('reads the groups anew even if they are cached', async () => {
        await conn.getGroups();

        await conn.renameGroup('system.group.a', 'system.group.b', 'B');

        assert.equal(socket.requestsOf('getObjectView').length, 2);
        assert.deepEqual(socket.lastRequest('getObjectView').args, [
            'system',
            'group',
            { startkey: 'system.group.', endkey: 'system.group.\u9999' },
        ]);
    });

    it('resolves without changes if the group does not exist', async () => {
        await conn.renameGroup('system.group.x', 'system.group.y', 'Y');

        assert.deepEqual(changes(), []);
    });

    it('stops and rejects if a new object cannot be written', async () => {
        socket.respond('setObject', () => ['permissionError']);

        await assert.rejects(conn.renameGroup('system.group.a', 'system.group.b', 'B'), isError('permissionError'));
        assert.deepEqual(changes(), [['setObject', 'system.group.b.sub']]);
    });

    it('stops and rejects if an old object cannot be deleted', async () => {
        socket.respond('delObject', () => ['permissionError']);

        await assert.rejects(conn.renameGroup('system.group.a', 'system.group.b', 'B'), isError('permissionError'));
        assert.deepEqual(changes(), [
            ['setObject', 'system.group.b.sub'],
            ['delObject', 'system.group.a.sub'],
        ]);
    });
});

describe('AdminConnection.cmdExec', () => {
    useConnection();

    const FILES = [{ name: 'script.sh', file: 'ZWNobyBoaQ==' }];

    it('sends the files before the callback', async () => {
        socket.respond('cmdExec', () => [null]);

        await conn.cmdExec('system.host.a', 'sh script.sh', 3, undefined, FILES);

        assert.deepEqual(socket.lastRequest('cmdExec').args, ['system.host.a', 3, 'sh script.sh', FILES]);
    });

    it('leaves out an empty list of files', async () => {
        socket.respond('cmdExec', () => [null]);

        await conn.cmdExec('a', 'ls', 3, undefined, []);

        assert.deepEqual(socket.lastRequest('cmdExec').args, ['system.host.a', 3, 'ls']);
    });

    it('times out after the given time', async () => {
        const promise = track(conn.cmdExec('a', 'ls', 3, 20_000));

        mock.timers.tick(19_999);
        await flush();
        assert.equal(promise.settled, false);
        mock.timers.tick(1);
        await flush();
        assertTimedOut(promise);
    });

    it('passes the output and the exit code of the command to the registered handlers', async () => {
        const stdout = mock.fn();
        const stderr = mock.fn();
        const exit = mock.fn();
        conn.registerCmdStdoutHandler(stdout);
        conn.registerCmdStderrHandler(stderr);
        conn.registerCmdExitHandler(exit);
        socket.respond('cmdExec', () => [null]);

        await conn.cmdExec('a', 'npm ls', 3);
        socket.fire('cmdStdout', 3, 'iobroker@1.0.0');
        socket.fire('cmdStderr', 3, 'npm warn');
        socket.fire('cmdExit', 3, 0);

        assert.deepEqual(stdout.mock.calls[0].arguments, [3, 'iobroker@1.0.0']);
        assert.deepEqual(stderr.mock.calls[0].arguments, [3, 'npm warn']);
        assert.deepEqual(exit.mock.calls[0].arguments, [3, 0]);

        conn.unregisterCmdStdoutHandler();
        conn.unregisterCmdStderrHandler();
        conn.unregisterCmdExitHandler();
        socket.fire('cmdStdout', 3, 'more');
        socket.fire('cmdStderr', 3, 'more');
        socket.fire('cmdExit', 3, 1);
        assert.equal(stdout.mock.callCount() + stderr.mock.callCount() + exit.mock.callCount(), 3);
    });
});

describe('AdminConnection.readBaseSettings and writeBaseSettings', () => {
    useConnection();
    beforeEach(() => socket.respond('checkFeatureSupported', () => [null, true]));

    it('rejects on the permission error of socket-classes 2.x', async () => {
        socket.respond('sendToHost', () => [{ error: ERRORS.PERMISSION_ERROR }]);

        await assert.rejects(conn.readBaseSettings('a'), is('May not read "BaseSettings"'));
        await assert.rejects(conn.writeBaseSettings('a', BASE_SETTINGS), is('May not write "BaseSettings"'));
    });

    it('checks the controller feature before reading', async () => {
        socket.respond('sendToHost', () => [{ config: BASE_SETTINGS }]);

        await conn.readBaseSettings('a');

        assert.deepEqual(
            socket.requests.map(request => request.name),
            ['checkFeatureSupported', 'sendToHost'],
        );
        assert.deepEqual(socket.lastRequest('checkFeatureSupported').args, ['CONTROLLER_READWRITE_BASE_SETTINGS']);
    });

    it('checks the controller feature only once', async () => {
        socket.respond('sendToHost', () => [{ config: BASE_SETTINGS }]);

        await conn.readBaseSettings('a');
        await conn.writeBaseSettings('a', BASE_SETTINGS);
        await conn.readBaseSettings('b');

        assert.equal(socket.requestsOf('checkFeatureSupported').length, 1);
        assert.equal(socket.requestsOf('sendToHost').length, 3);
    });

    for (const method of ['readBaseSettings', 'writeBaseSettings']) {
        it(`${method} rejects with NOT_SUPPORTED for an older controller`, async () => {
            socket.respond('checkFeatureSupported', () => [null, false]);

            await assert.rejects(ALL_METHODS[method](conn), isError(ERRORS.NOT_SUPPORTED));
            assert.equal(socket.requestsOf('sendToHost').length, 0);
        });
    }

    it('readBaseSettings rejects with the error of the host', async () => {
        socket.respond('sendToHost', () => [{ error: 'Cannot read iobroker.json' }]);

        await assert.rejects(conn.readBaseSettings('a'), isError('Cannot read iobroker.json'));
    });

    it('readBaseSettings rejects on an empty answer', async () => {
        socket.respond('sendToHost', () => [null]);

        await assert.rejects(conn.readBaseSettings('a'), is('Cannot read "BaseSettings"'));
    });

    it('writeBaseSettings rejects on an empty answer', async () => {
        socket.respond('sendToHost', () => [null]);

        await assert.rejects(conn.writeBaseSettings('a', BASE_SETTINGS), is('Cannot write "BaseSettings"'));
    });

    it('writeBaseSettings resolves with the error of the host', async () => {
        socket.respond('sendToHost', () => [{ error: 'Cannot write iobroker.json' }]);

        assert.deepEqual(await conn.writeBaseSettings('a', BASE_SETTINGS), { error: 'Cannot write iobroker.json' });
    });
});

describe('AdminConnection.getHostByIp and getIpAddresses', () => {
    useConnection();

    it('getHostByIp lists the listen-on-all addresses and the addresses of all interfaces', async () => {
        socket.respond('getHostByIp', ip => [ip, HOST_OBJECT]);

        assert.deepEqual(await conn.getHostByIp('192.168.1.10'), [
            LISTEN_ON_ALL_IPV4,
            { name: '[IPv4] 192.168.1.10 - eth0', address: '192.168.1.10', family: 'ipv4' },
            { name: '[IPv4] 127.0.0.1 - lo', address: '127.0.0.1', family: 'ipv4' },
            LISTEN_ON_ALL_IPV6,
            { name: '[IPv6] fe80::1 - eth0', address: 'fe80::1', family: 'ipv6' },
        ]);
        assert.deepEqual(socket.lastRequest('getHostByIp').args, ['192.168.1.10']);
    });

    it('getHostByIp lists only the listen-on-all addresses for a host without network interfaces', async () => {
        socket.respond('getHostByIp', ip => [ip, { ...HOST_OBJECT, native: {} }]);

        assert.deepEqual(await conn.getHostByIp('a'), [LISTEN_ON_ALL_IPV4, LISTEN_ON_ALL_IPV6]);
    });

    it('getHostByIp lists the listen-on-all addresses if no host has the IP', async () => {
        const promise = track(conn.getHostByIp('10.0.0.1'));

        socket.lastAnswer('getHostByIp')('10.0.0.1', null);
        await flush();

        assert.deepEqual(promise.value, [LISTEN_ON_ALL_IPV4, LISTEN_ON_ALL_IPV6]);
    });

    it('getHostByIp rejects on a permission error and asks again on the next call', async () => {
        // the server calls back with the error only
        socket.respond('getHostByIp', () => [ERRORS.PERMISSION_ERROR]);
        await assert.rejects(conn.getHostByIp('10.0.0.1'), error => error === ERRORS.PERMISSION_ERROR);

        socket.respond('getHostByIp', ip => [ip, null]);
        assert.deepEqual(await conn.getHostByIp('10.0.0.1'), [LISTEN_ON_ALL_IPV4, LISTEN_ON_ALL_IPV6]);
        assert.equal(socket.requestsOf('getHostByIp').length, 2);
    });

    it('getIpAddresses reads the addresses from the host object', async () => {
        socket.respond('getObject', id => [null, id === 'system.host.a' ? HOST_OBJECT : null]);

        assert.deepEqual(await conn.getIpAddresses('a'), ['192.168.1.10', 'fe80::1']);
        assert.deepEqual(socket.lastRequest('getObject').args, ['system.host.a']);
    });

    it('getIpAddresses resolves an empty list without the host object or its addresses', async () => {
        socket.respond('getObject', () => [null, null]);
        assert.deepEqual(await conn.getIpAddresses('a'), []);

        socket.respond('getObject', () => [null, { ...HOST_OBJECT, common: { name: 'b' } }]);
        assert.deepEqual(await conn.getIpAddresses('b'), []);
    });
});

describe('AdminConnection.getCurrentSession', () => {
    useConnection();

    const SESSION = { expireInSec: 3600 };

    it('fetches ./session and resolves with the JSON', async () => {
        const fetchMock = mockFetch(() => Promise.resolve({ json: () => Promise.resolve(SESSION) }));

        assert.deepEqual(await conn.getCurrentSession(), SESSION);

        const [url, init] = fetchMock.mock.calls[0].arguments;
        assert.equal(url, './session');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(socket.requests.length, 0);
    });

    it('rejects with the text of a fetch error', async () => {
        mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));

        await assert.rejects(conn.getCurrentSession(), is('getCurrentSession: TypeError: Failed to fetch'));
    });

    it('rejects if the answer is no JSON', async () => {
        mockFetch(() => Promise.resolve({ json: () => Promise.reject(new SyntaxError('Unexpected token <')) }));

        await assert.rejects(conn.getCurrentSession(), is('getCurrentSession: SyntaxError: Unexpected token <'));
    });

    it('aborts the fetch and rejects with a timeout after 5 seconds', async () => {
        let signal: AbortSignal | undefined;
        mockFetch((_url, init) => {
            signal = init.signal!;
            return new Promise((_resolve, reject) =>
                signal!.addEventListener('abort', () => reject(new Error('aborted'))),
            );
        });

        const promise = track(conn.getCurrentSession());
        mock.timers.tick(4999);
        await flush();
        assert.equal(promise.settled, false);
        assert.equal(signal?.aborted, false);

        mock.timers.tick(1);
        await flush();
        assert.equal(signal?.aborted, true);
        assertTimedOut(promise);
    });

    it('uses the given timeout, also if the connection has a longer cmdTimeout', async () => {
        conn.destroy();
        await connect({ cmdTimeout: 30_000 });
        mockFetch(() => new Promise(() => {}));

        const short = track(conn.getCurrentSession(1000));
        const byDefault = track(conn.getCurrentSession());
        mock.timers.tick(1000);
        await flush();
        assertTimedOut(short);
        assert.equal(byDefault.settled, false);

        mock.timers.tick(4000);
        await flush();
        assertTimedOut(byDefault);
    });

    it('ignores an answer that comes after the timeout', async () => {
        let resolveFetch!: (response: unknown) => void;
        mockFetch(() => new Promise(resolve => (resolveFetch = resolve)));
        const json = mock.fn(() => Promise.resolve(SESSION));

        const promise = track(conn.getCurrentSession());
        mock.timers.tick(5000);
        resolveFetch({ json });
        await flush();

        assertTimedOut(promise);
        assert.equal(json.mock.callCount(), 0);
    });

    it('fetches the session on every call', async () => {
        const fetchMock = mockFetch(() => Promise.resolve({ json: () => Promise.resolve(SESSION) }));

        await conn.getCurrentSession();
        await conn.getCurrentSession();

        assert.equal(fetchMock.mock.callCount(), 2);
    });
});

describe('AdminConnection answers of the host', () => {
    useConnection();

    it('getLogs asks for 200 lines by default', async () => {
        socket.respond('sendToHost', () => [[]]);

        await conn.getLogs('system.host.a');
        await conn.getLogs('system.host.a', 0);

        assert.deepEqual(
            socket.requestsOf('sendToHost').map(request => request.args[2]),
            [200, 200],
        );
    });

    it('getLogs resolves with an error of the host', async () => {
        socket.respond('sendToHost', () => [{ error: 'Log file not found' }]);

        assert.deepEqual(await conn.getLogs('system.host.a'), { error: 'Log file not found' });
    });

    it('upgradeOsPackages asks for a restart if wanted', async () => {
        socket.respond('sendToHost', () => [{ success: false, error: 'apt is locked' }]);

        assert.deepEqual(await conn.upgradeOsPackages('system.host.a', [{ name: 'git' }], true), {
            success: false,
            error: 'apt is locked',
        });
        assert.deepEqual(socket.lastRequest('sendToHost').args[2], { packages: [{ name: 'git' }], restart: true });
    });

    it('getNotifications sends an undefined category if none is given', async () => {
        socket.respond('sendToHost', () => [NOTIFICATIONS]);

        await conn.getNotifications('system.host.a');

        assert.deepEqual(socket.lastRequest('sendToHost').args, [
            'system.host.a',
            'getNotifications',
            { category: undefined },
        ]);
    });

    it('getDiagData resolves null for an empty answer', async () => {
        socket.respond('sendToHost', () => [undefined]);

        assert.equal(await conn.getDiagData('a', 'none'), null);
    });

    it('upgradeController rejects on a permission error', async () => {
        socket.respond('sendToHost', () => [ERRORS.PERMISSION_ERROR]);

        await assert.rejects(conn.upgradeController('system.host.a', '7.1.0', 1));
    });

    it('restartController rejects on a permission error', async () => {
        socket.respond('sendToHost', () => [ERRORS.PERMISSION_ERROR]);

        await assert.rejects(conn.restartController('a'));
    });

    it('restartController rejects on the permission error of socket-classes 2.x', async () => {
        socket.respond('sendToHost', () => [{ error: ERRORS.PERMISSION_ERROR }]);

        await assert.rejects(conn.restartController('a'), error => error === ERRORS.PERMISSION_ERROR);
    });

    it('restartController resolves with true for the empty answer of the controller', async () => {
        socket.respond('sendToHost', () => ['']);

        assert.equal(await conn.restartController('a'), true);
    });
});

describe('AdminConnection easy mode, ratings and instances', () => {
    useConnection();

    it('getIsEasyModeStrict converts the answer to a boolean', async () => {
        socket.respond('getIsEasyModeStrict', () => [null, undefined]);
        assert.equal(await conn.getIsEasyModeStrict(), false);

        socket.respond('getIsEasyModeStrict', () => [null, 1]);
        assert.equal(await conn.getIsEasyModeStrict(), true);
    });

    it('getRatings asks without an update by default', async () => {
        socket.respond('getRatings', () => [null, RATINGS]);

        await conn.getRatings();

        assert.deepEqual(socket.lastRequest('getRatings').args, [false]);
    });

    for (const method of ['getAdapterInstances', 'getAdapters'] as const) {
        it(`${method} takes a boolean first parameter as the update flag for all adapters`, async () => {
            socket.respond(method, () => [null, []]);

            await conn[method]();
            await conn[method](true);

            assert.deepEqual(
                socket.requestsOf(method).map(request => request.args),
                [[''], ['']],
            );
        });
    }
});
