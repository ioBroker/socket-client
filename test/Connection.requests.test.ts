import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { promisify } from 'node:util';

import { Connection, ERRORS, PROGRESS } from '../src/Connection.js';
import type { ConnectionProps } from '../src/ConnectionProps.js';
import type { FakeSocket } from './lib/FakeSocket.js';
import { createConnection, flush, login, resetGlobals, SYSTEM_CONFIG, track } from './lib/helpers.js';

const STATE_ID = 'hm-rpc.0.dev.STATE';
const HOUR = 60 * 60_000;

function obj(id: string, type: string, common: Record<string, unknown> = {}): any {
    return { _id: id, type, common, native: {} };
}

/** The answer of the server to "getObjectView" */
function rows(...objects: any[]): { rows: { id: string; value: any }[] } {
    return { rows: objects.map(o => ({ id: o._id, value: o })) };
}

function byId(...objects: any[]): Record<string, any> {
    return Object.fromEntries(objects.map(o => [o._id, o]));
}

const STATE_OBJ = obj(STATE_ID, 'state', { name: 'State', type: 'boolean', role: 'switch', read: true, write: true });
const OTHER_OBJ = obj('hm-rpc.0.dev.LEVEL', 'state', { name: 'Level', type: 'number', role: 'level' });
const STATE = { val: true, ack: true, ts: 1, lc: 1, from: 'system.adapter.hm-rpc.0', q: 0 };
const ROOMS = obj('enum.rooms', 'enum', { name: 'Rooms', members: [] });
const KITCHEN = obj('enum.rooms.kitchen', 'enum', { name: 'Kitchen', members: [STATE_ID] });
const LIVING = obj('enum.rooms.living', 'enum', { name: 'Living room', members: [] });
const META = obj('vis.0', 'meta', { type: 'meta.user' });
const GROUP = obj('system.group.administrator', 'group', { name: 'Administrator', members: [] });
const FILES = [{ file: 'vis-views.json', stats: { size: 2 }, isDir: false, modifiedAt: 1 }];
const HISTORY_OPTIONS = { instance: 'history.0', start: 1, end: 2, aggregate: 'none' } as ioBroker.GetHistoryOptions;
const VALUES = [
    { val: 1, ts: 1 },
    { val: 2, ts: 2 },
];
const HOST = obj('system.host.myhost', 'host', { name: 'myhost', address: ['192.168.1.2', '::1'] });
const COMMAND_FILES = [{ name: 'script.sh', file: 'ZWNobyBoaQ==' }];

describe('Connection requests', () => {
    let conn: Connection;
    let socket: FakeSocket;
    let onProgress: ReturnType<typeof mock.fn<(progress: number) => void>>;

    /** Creates the connection and logs in. The test must answer every request after that */
    async function start(props: Partial<ConnectionProps> = {}): Promise<void> {
        ({ conn, socket } = await createConnection(Connection, { onProgress, ...props }));
        await login(conn, socket);
        delete socket.responders.authenticate;
        delete socket.responders.getObject;
        socket.clearRequests();
        onProgress.mock.resetCalls();
    }

    beforeEach(() => {
        resetGlobals();
        mock.timers.enable({ apis: ['setTimeout'] });
        onProgress = mock.fn<(progress: number) => void>();
    });

    afterEach(() => {
        conn?.destroy();
        mock.timers.reset();
        mock.restoreAll();
    });

    describe('request wrappers', () => {
        interface RequestCase {
            call: string;
            run: (conn: Connection) => Promise<unknown>;
            event: string;
            /** The arguments of the request without the callback */
            args: unknown[];
            answer: unknown[];
            result: unknown;
            /** The server answers only with a result, so there is no error to reject with */
            noError?: boolean;
        }

        const REQUESTS: RequestCase[] = [
            {
                call: 'getObjectsById',
                run: conn => conn.getObjectsById([STATE_ID]),
                event: 'getObjects',
                args: [[STATE_ID]],
                answer: [null, byId(STATE_OBJ)],
                result: byId(STATE_OBJ),
            },
            {
                call: 'getObject',
                run: conn => conn.getObject(STATE_ID),
                event: 'getObject',
                args: [STATE_ID],
                answer: [null, STATE_OBJ],
                result: STATE_OBJ,
            },
            {
                call: 'delObject',
                run: conn => conn.delObject(STATE_ID),
                event: 'delObject',
                args: [STATE_ID, { maintenance: false }],
                answer: [null],
                result: undefined,
            },
            {
                call: 'delObject in maintenance mode',
                run: conn => conn.delObject(STATE_ID, true),
                event: 'delObject',
                args: [STATE_ID, { maintenance: true }],
                answer: [null],
                result: undefined,
            },
            {
                call: 'delObjects',
                run: conn => conn.delObjects('hm-rpc.0.dev', true),
                event: 'delObjects',
                args: ['hm-rpc.0.dev', { maintenance: true }],
                answer: [null],
                result: undefined,
            },
            {
                call: 'setObject',
                run: conn => conn.setObject(STATE_ID, STATE_OBJ),
                event: 'setObject',
                args: [STATE_ID, STATE_OBJ],
                answer: [null],
                result: undefined,
            },
            {
                call: 'extendObject',
                run: conn => conn.extendObject(STATE_ID, { common: { name: 'New name' } }),
                event: 'extendObject',
                args: [STATE_ID, { common: { name: 'New name' } }],
                answer: [null],
                result: undefined,
            },
            {
                call: 'getForeignObjects',
                run: conn => conn.getForeignObjects('hm-rpc.0.*', 'state'),
                event: 'getForeignObjects',
                args: ['hm-rpc.0.*', 'state'],
                answer: [null, byId(STATE_OBJ)],
                result: byId(STATE_OBJ),
            },
            {
                call: 'getForeignStates',
                run: conn => conn.getForeignStates('hm-rpc.0.*'),
                event: 'getForeignStates',
                args: ['hm-rpc.0.*'],
                answer: [null, { [STATE_ID]: STATE }],
                result: { [STATE_ID]: STATE },
            },
            {
                call: 'getObjectViewCustom',
                run: conn => conn.getObjectViewCustom('custom', 'state', 'hm-rpc.0.', 'hm-rpc.0.\u9999'),
                event: 'getObjectView',
                args: ['custom', 'state', { startkey: 'hm-rpc.0.', endkey: 'hm-rpc.0.\u9999' }],
                answer: [null, rows(STATE_OBJ, OTHER_OBJ)],
                result: byId(STATE_OBJ, OTHER_OBJ),
            },
            {
                call: 'getEnums',
                run: conn => conn.getEnums('rooms'),
                event: 'getObjectView',
                args: ['system', 'enum', { startkey: 'enum.rooms', endkey: 'enum.rooms.\u9999' }],
                answer: [null, rows(KITCHEN, LIVING)],
                result: byId(KITCHEN, LIVING),
            },
            {
                call: 'readMetaItems',
                run: conn => conn.readMetaItems(),
                event: 'getObjectView',
                args: ['system', 'meta', { startkey: '', endkey: '\u9999' }],
                answer: [null, rows(META)],
                result: [META],
            },
            {
                call: 'readDir',
                run: conn => conn.readDir('vis.0', 'main'),
                event: 'readDir',
                args: ['vis.0', 'main'],
                answer: [null, FILES],
                result: FILES,
            },
            {
                call: 'readFile',
                run: conn => conn.readFile('vis.0', 'main/vis-views.json'),
                event: 'readFile',
                args: ['vis.0', 'main/vis-views.json'],
                answer: [null, '{}', 'application/json'],
                result: { file: '{}', mimeType: 'application/json' },
            },
            {
                call: 'readFile as base64',
                run: conn => conn.readFile('vis.0', 'main/img.png', true),
                event: 'readFile64',
                args: ['vis.0', 'main/img.png'],
                answer: [null, 'AAEC+v8=', 'image/png'],
                result: { file: 'AAEC+v8=', mimeType: 'image/png' },
            },
            {
                call: 'writeFile64 with a text',
                run: conn => conn.writeFile64('vis.0', 'main/vis-views.json', '{}'),
                event: 'writeFile',
                args: ['vis.0', 'main/vis-views.json', '{}'],
                answer: [null],
                result: undefined,
            },
            {
                call: 'writeFile64 with binary data',
                run: conn => conn.writeFile64('vis.0', 'main/img.png', new Uint8Array([0, 1, 2, 250, 255]).buffer),
                event: 'writeFile64',
                args: ['vis.0', 'main/img.png', 'AAEC+v8='],
                answer: [null],
                result: undefined,
            },
            {
                call: 'deleteFile',
                run: conn => conn.deleteFile('vis.0', 'main/img.png'),
                event: 'deleteFile',
                args: ['vis.0', 'main/img.png'],
                answer: [null],
                result: undefined,
            },
            {
                call: 'deleteFolder',
                run: conn => conn.deleteFolder('vis.0', 'main'),
                event: 'deleteFolder',
                args: ['vis.0', 'main'],
                answer: [null],
                result: undefined,
            },
            {
                call: 'rename',
                run: conn => conn.rename('vis.0', 'main', 'main2'),
                event: 'rename',
                args: ['vis.0', 'main', 'main2'],
                answer: [null],
                result: undefined,
            },
            {
                call: 'renameFile',
                run: conn => conn.renameFile('vis.0', 'main/a.json', 'main/b.json'),
                event: 'renameFile',
                args: ['vis.0', 'main/a.json', 'main/b.json'],
                answer: [null],
                result: undefined,
            },
            {
                call: 'fileExists',
                run: conn => conn.fileExists('vis.0', 'main/img.png'),
                event: 'fileExists',
                args: ['vis.0', 'main/img.png'],
                answer: [null, true],
                result: true,
            },
            {
                call: 'getCompactSystemConfig',
                run: conn => conn.getCompactSystemConfig(),
                event: 'getCompactSystemConfig',
                args: [],
                answer: [null, SYSTEM_CONFIG],
                result: SYSTEM_CONFIG,
            },
            {
                call: 'setSystemConfig',
                run: conn => conn.setSystemConfig(SYSTEM_CONFIG),
                event: 'setObject',
                args: ['system.config', SYSTEM_CONFIG],
                answer: [null],
                result: undefined,
            },
            {
                call: 'getHistory',
                run: conn => conn.getHistory(STATE_ID, HISTORY_OPTIONS),
                event: 'getHistory',
                args: [STATE_ID, HISTORY_OPTIONS],
                answer: [null, VALUES],
                result: VALUES,
            },
            {
                call: 'getHistoryEx',
                run: conn => conn.getHistoryEx(STATE_ID, HISTORY_OPTIONS),
                event: 'getHistory',
                args: [STATE_ID, HISTORY_OPTIONS],
                answer: [null, VALUES, 60000, 12],
                result: { values: VALUES, step: 60000, sessionId: 12 },
            },
            {
                call: 'getWebServerName',
                run: conn => conn.getWebServerName(),
                event: 'getAdapterName',
                args: [],
                answer: [null, 'web.0'],
                result: 'web.0',
            },
            {
                call: 'checkFeatureSupported',
                run: conn => conn.checkFeatureSupported('ALIAS'),
                event: 'checkFeatureSupported',
                args: ['ALIAS'],
                answer: [null, true],
                result: true,
            },
            {
                call: 'getGroups',
                run: conn => conn.getGroups(),
                event: 'getObjectView',
                args: ['system', 'group', { startkey: 'system.group.', endkey: 'system.group.\u9999' }],
                answer: [null, rows(GROUP)],
                result: [GROUP],
            },
            {
                call: 'getCurrentUser',
                run: conn => conn.getCurrentUser(),
                event: 'authEnabled',
                args: [],
                answer: [true, 'admin'],
                result: 'admin',
                noError: true,
            },
            {
                call: 'sendTo',
                run: conn => conn.sendTo('email.0', 'send', { to: 'user@example.com' }),
                event: 'sendTo',
                args: ['email.0', 'send', { to: 'user@example.com' }],
                answer: [{ result: 'ok' }],
                result: { result: 'ok' },
                noError: true,
            },
        ];

        beforeEach(() => start());

        for (const c of REQUESTS) {
            it(`${c.call} sends "${c.event}" and waits for the answer without a timeout`, async () => {
                const promise = c.run(conn);
                const state = track(promise);

                assert.equal(socket.requests.length, 1);
                assert.deepEqual(socket.lastRequest(c.event).args, c.args);

                mock.timers.tick(HOUR);
                await flush();
                assert.equal(state.settled, false);

                socket.lastAnswer(c.event)(...c.answer);
                assert.deepEqual(await promise, c.result);
            });

            if (!c.noError) {
                it(`${c.call} rejects with the error of the server`, async () => {
                    const promise = c.run(conn);
                    socket.lastAnswer(c.event)('permissionError');
                    await assert.rejects(promise, error => error === 'permissionError');
                });
            }
        }
    });

    describe('Connection.getObjects', () => {
        const OBJECTS = byId(STATE_OBJ, OTHER_OBJ);

        beforeEach(() => start());

        it('answers from the objects known since the login unless an update is requested', async () => {
            assert.deepEqual(await conn.getObjects(), { 'system.config': SYSTEM_CONFIG });
            assert.equal(socket.requests.length, 0);
        });

        it('loads all objects with "getAllObjects" in the admin and keeps them', async () => {
            const promise = conn.getObjects(true);
            assert.deepEqual(socket.lastRequest('getAllObjects').args, []);
            socket.lastAnswer('getAllObjects')(null, OBJECTS);
            assert.deepEqual(await promise, OBJECTS);

            assert.deepEqual(await conn.getObjects(), OBJECTS);
            assert.equal(socket.requests.length, 1);
        });

        it('loads all objects with "getObjects" in a web adapter', async () => {
            (globalThis as any).socketUrl = 'http://localhost:8082/';

            const promise = conn.getObjects(true);
            assert.deepEqual(socket.lastRequest('getObjects').args, []);
            socket.lastAnswer('getObjects')(null, OBJECTS);

            assert.deepEqual(await promise, OBJECTS);
            assert.equal(socket.requestsOf('getAllObjects').length, 0);
        });

        it('waits for all objects without a timeout', async () => {
            const promise = track(conn.getObjects(true));
            mock.timers.tick(HOUR);
            await flush();
            assert.equal(promise.settled, false);
        });

        it('reports that the objects are loaded unless that is disabled', async () => {
            const first = conn.getObjects(true);
            socket.lastAnswer('getAllObjects')(null, OBJECTS);
            await first;
            assert.deepEqual(
                onProgress.mock.calls.map(call => call.arguments[0]),
                [PROGRESS.OBJECTS_LOADED],
            );

            const second = conn.getObjects(true, true);
            socket.lastAnswer('getAllObjects')(null, OBJECTS);
            await second;
            assert.equal(onProgress.mock.callCount(), 1);
        });

        it('treats an empty answer as no objects', async () => {
            const promise = conn.getObjects(true);
            socket.lastAnswer('getAllObjects')(null, null);
            assert.deepEqual(await promise, {});
        });

        it('rejects with the error of the server and keeps the known objects', async () => {
            const promise = conn.getObjects(true);
            socket.lastAnswer('getAllObjects')('permissionError');
            await assert.rejects(promise, error => error === 'permissionError');

            assert.deepEqual(await conn.getObjects(), { 'system.config': SYSTEM_CONFIG });
        });
    });

    describe('Connection.getObjects when all objects are loaded at the login', () => {
        it('asks the server instead of answering from the empty cache', async () => {
            const OBJECTS = byId(STATE_OBJ, OTHER_OBJ);
            ({ conn, socket } = await createConnection(Connection, { doNotLoadAllObjects: false }));
            socket.respond('getAllObjects', () => [null, OBJECTS]);

            await login(conn, socket);

            assert.equal(socket.requestsOf('getAllObjects').length, 1);
            assert.deepEqual(await conn.getObjects(), OBJECTS);
        });
    });

    describe('Connection.getObject', () => {
        beforeEach(() => start());

        it('answers the state to ignore without asking the server', async () => {
            conn.setStateToIgnore('vis.0.nothing_selected');

            assert.deepEqual(await conn.getObject('vis.0.nothing_selected'), {
                _id: 'vis.0.nothing_selected',
                type: 'state',
                common: { name: 'ignored state', type: 'mixed' },
            });
            assert.equal(socket.requests.length, 0);
        });

        it('asks the server for the other ids', async () => {
            conn.setStateToIgnore('vis.0.nothing_selected');

            const promise = conn.getObject(STATE_ID);
            socket.lastAnswer('getObject')(null, STATE_OBJ);

            assert.deepEqual(await promise, STATE_OBJ);
        });

        it('resolves null for an object that does not exist', async () => {
            const promise = conn.getObject(STATE_ID);
            socket.lastAnswer('getObject')(null, null);

            assert.equal(await promise, null);
        });
    });

    for (const method of ['setObject', 'extendObject'] as const) {
        describe(`Connection.${method}`, () => {
            function write(id: string, value: any): Promise<void> {
                return method === 'setObject' ? conn.setObject(id, value) : conn.extendObject(id, value);
            }

            beforeEach(() => start());

            it('rejects a missing object without asking the server', async () => {
                await assert.rejects(write(STATE_ID, null), { message: 'Null object is not allowed' });
                assert.equal(socket.requests.length, 0);
            });

            it('sends a copy without from, user and ts', async () => {
                const value = { ...STATE_OBJ, from: 'system.adapter.admin.0', user: 'system.user.admin', ts: 1 };

                const promise = write(STATE_ID, value);
                const sent = socket.lastRequest(method).args[1];
                socket.lastAnswer(method)(null);
                await promise;

                assert.deepEqual(sent, STATE_OBJ);
                assert.notEqual(sent, value);
                assert.equal(value.from, 'system.adapter.admin.0');
                assert.equal(value.ts, 1);
            });
        });
    }

    describe('Connection.getEnums', () => {
        beforeEach(() => start());

        it('lists the enums of a kind without the kind itself', async () => {
            const promise = conn.getEnums('rooms');
            socket.lastAnswer('getObjectView')(null, rows(ROOMS, KITCHEN, LIVING));

            assert.deepEqual(await promise, byId(KITCHEN, LIVING));
        });

        it('lists all enums', async () => {
            const promise = conn.getEnums();
            assert.deepEqual(socket.lastRequest('getObjectView').args, [
                'system',
                'enum',
                { startkey: 'enum.', endkey: 'enum.\u9999' },
            ]);
            socket.lastAnswer('getObjectView')(null, rows(ROOMS, KITCHEN));

            assert.deepEqual(await promise, byId(ROOMS, KITCHEN));
        });

        it('resolves no enums for an empty answer', async () => {
            const promise = conn.getEnums('rooms');
            socket.lastAnswer('getObjectView')(null, null);

            assert.deepEqual(await promise, {});
        });

        it('caches the enums per kind until an update is requested', async () => {
            const first = conn.getEnums('rooms');
            socket.lastAnswer('getObjectView')(null, rows(KITCHEN));
            await first;

            assert.deepEqual(await conn.getEnums('rooms'), byId(KITCHEN));
            assert.equal(socket.requests.length, 1);

            void conn.getEnums('functions');
            assert.equal(socket.requests.length, 2);

            const updated = conn.getEnums('rooms', true);
            assert.equal(socket.requests.length, 3);
            socket.lastAnswer('getObjectView')(null, rows(KITCHEN, LIVING));
            assert.deepEqual(await updated, byId(KITCHEN, LIVING));
            assert.deepEqual(await conn.getEnums('rooms'), byId(KITCHEN, LIVING));
            assert.equal(socket.requests.length, 3);
        });
    });

    describe('Connection.getObjectView', () => {
        beforeEach(() => start());

        it('queries the system design with start, end and type in the old order', async () => {
            const promise = conn.getObjectView('hm-rpc.0.', 'hm-rpc.0.\u9999', 'state');
            assert.deepEqual(socket.lastRequest('getObjectView').args, [
                'system',
                'state',
                { startkey: 'hm-rpc.0.', endkey: 'hm-rpc.0.\u9999' },
            ]);
            socket.lastAnswer('getObjectView')(null, rows(STATE_OBJ));

            assert.deepEqual(await promise, byId(STATE_OBJ));
        });
    });

    describe('Connection.getObjectViewCustom', () => {
        beforeEach(() => start());

        it('asks for all ids without start and end', () => {
            void conn.getObjectViewCustom('custom', 'state');

            assert.deepEqual(socket.lastRequest('getObjectView').args, [
                'custom',
                'state',
                { startkey: '', endkey: '\u9999' },
            ]);
        });

        it('resolves no objects for an answer without rows', async () => {
            const empty = conn.getObjectViewCustom('custom', 'state');
            socket.lastAnswer('getObjectView')(null, null);
            assert.deepEqual(await empty, {});

            const withoutRows = conn.getObjectViewCustom('custom', 'state');
            socket.lastAnswer('getObjectView')(null, {});
            assert.deepEqual(await withoutRows, {});
        });
    });

    describe('Connection.getObjectViewSystem', () => {
        beforeEach(() => start());

        it('queries the system design', async () => {
            const promise = conn.getObjectViewSystem('channel', 'hm-rpc.0.', 'hm-rpc.0.\u9999');
            assert.deepEqual(socket.lastRequest('getObjectView').args, [
                'system',
                'channel',
                { startkey: 'hm-rpc.0.', endkey: 'hm-rpc.0.\u9999' },
            ]);
            socket.lastAnswer('getObjectView')(null, rows(STATE_OBJ));

            assert.deepEqual(await promise, byId(STATE_OBJ));
        });
    });

    describe('Connection.getObjectViewSystemCached', () => {
        function cached(type: ioBroker.ObjectType = 'state', start = 'hm-rpc.0.'): Promise<Record<string, any>> {
            return conn.getObjectViewSystemCached(type, start, `${start}\u9999`);
        }

        beforeEach(() => start());

        it('asks the server only once per type and range', async () => {
            const first = cached();
            socket.lastAnswer('getObjectView')(null, rows(STATE_OBJ));
            assert.deepEqual(await first, byId(STATE_OBJ));

            assert.deepEqual(await cached(), byId(STATE_OBJ));
            assert.equal(socket.requests.length, 1);

            void cached('state', 'zigbee.0.');
            void cached('channel');
            assert.equal(socket.requests.length, 3);
        });

        it('gets the result of a later getObjectViewSystem for the same type and range', async () => {
            const first = cached();
            socket.lastAnswer('getObjectView')(null, rows(STATE_OBJ));
            await first;

            const fresh = conn.getObjectViewSystem('state', 'hm-rpc.0.', 'hm-rpc.0.\u9999');
            socket.lastAnswer('getObjectView')(null, rows(STATE_OBJ, OTHER_OBJ));
            await fresh;

            assert.deepEqual(await cached(), byId(STATE_OBJ, OTHER_OBJ));
            assert.equal(socket.requests.length, 2);
        });

        it('is not filled by getObjectViewSystem alone', async () => {
            const fresh = conn.getObjectViewSystem('state', 'hm-rpc.0.', 'hm-rpc.0.\u9999');
            socket.lastAnswer('getObjectView')(null, rows(STATE_OBJ));
            await fresh;

            void cached();
            assert.equal(socket.requests.length, 2);
        });

        it('does not keep a failed request', async () => {
            const failed = cached();
            socket.lastAnswer('getObjectView')('permissionError');
            await assert.rejects(failed, error => error === 'permissionError');

            void cached();
            assert.equal(socket.requests.length, 2);
        });
    });

    describe('Connection.getForeignStates and getForeignObjects', () => {
        beforeEach(() => start());

        it('asks for all states without a pattern and resolves no states for an empty answer', async () => {
            const promise = conn.getForeignStates();
            assert.deepEqual(socket.lastRequest('getForeignStates').args, ['*']);
            socket.lastAnswer('getForeignStates')(null, null);

            assert.deepEqual(await promise, {});
        });

        it('passes a list of ids unchanged', () => {
            void conn.getForeignStates([STATE_ID, OTHER_OBJ._id]);

            assert.deepEqual(socket.lastRequest('getForeignStates').args, [[STATE_ID, OTHER_OBJ._id]]);
        });

        it('asks for all objects of a type without a pattern', () => {
            void conn.getForeignObjects(null, 'channel');

            assert.deepEqual(socket.lastRequest('getForeignObjects').args, ['*', 'channel']);
        });
    });

    describe('Connection.readMetaItems', () => {
        beforeEach(() => start());

        it('skips the rows without an object', async () => {
            const promise = conn.readMetaItems();
            socket.lastAnswer('getObjectView')(null, { rows: [{ id: 'vis', value: null }, ...rows(META).rows] });

            assert.deepEqual(await promise, [META]);
        });

        it('resolves an empty list for an answer without rows', async () => {
            const promise = track(conn.readMetaItems());
            socket.lastAnswer('getObjectView')(null, null);
            await flush();

            assert.deepEqual(promise.value, []);
        });
    });

    describe('Connection.writeFile64', () => {
        beforeEach(() => start());

        it('encodes every byte value in base64', async () => {
            const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

            const promise = conn.writeFile64('vis.0', 'main/all.bin', bytes.buffer);
            assert.equal(socket.lastRequest('writeFile64').args[2], Buffer.from(bytes).toString('base64'));
            socket.lastAnswer('writeFile64')(null);
            await promise;
        });
    });

    describe('Connection.fileExists', () => {
        beforeEach(() => start());

        it('resolves false for an empty answer', async () => {
            const promise = conn.fileExists('vis.0', 'main/img.png');
            socket.lastAnswer('fileExists')(null);

            assert.equal(await promise, false);
        });
    });

    describe('Connection.cmdExec', () => {
        beforeEach(() => start());

        it('sends the host id, the command id and the command', async () => {
            const promise = conn.cmdExec('myhost', 'ls -la', 7);
            assert.deepEqual(socket.lastRequest('cmdExec').args, ['system.host.myhost', 7, 'ls -la']);
            socket.lastAnswer('cmdExec')(null);

            assert.equal(await promise, undefined);
        });

        it('keeps a full host id', () => {
            void conn.cmdExec('system.host.myhost', 'ls', 7);

            assert.equal(socket.lastRequest('cmdExec').args[0], 'system.host.myhost');
        });

        it('sends the files between the command and the callback', async () => {
            const promise = conn.cmdExec('myhost', 'sh script.sh', 7, undefined, COMMAND_FILES);
            assert.deepEqual(socket.lastRequest('cmdExec').args, [
                'system.host.myhost',
                7,
                'sh script.sh',
                COMMAND_FILES,
            ]);
            socket.lastAnswer('cmdExec')(null);

            assert.equal(await promise, undefined);
        });

        it('leaves out an empty list of files for older servers', () => {
            void conn.cmdExec('myhost', 'ls', 7, undefined, []);

            assert.deepEqual(socket.lastRequest('cmdExec').args, ['system.host.myhost', 7, 'ls']);
        });

        it('rejects with the error of the server', async () => {
            const promise = conn.cmdExec('myhost', 'ls', 7, undefined, COMMAND_FILES);
            socket.lastAnswer('cmdExec')('Unknown host');

            await assert.rejects(promise, error => error === 'Unknown host');
        });

        it('times out after 5 seconds by default', async () => {
            const promise = track(conn.cmdExec('myhost', 'ls', 7));

            mock.timers.tick(4999);
            await flush();
            assert.equal(promise.settled, false);

            mock.timers.tick(1);
            await flush();
            assert.equal((promise.error as Error).message, ERRORS.TIMEOUT);
        });

        it('times out after the given time and ignores a later answer', async () => {
            const promise = track(conn.cmdExec('myhost', 'iob upgrade', 7, 60000));

            mock.timers.tick(59999);
            await flush();
            assert.equal(promise.settled, false);

            mock.timers.tick(1);
            socket.lastAnswer('cmdExec')(null);
            await flush();
            assert.equal((promise.error as Error).message, ERRORS.TIMEOUT);
        });
    });

    describe('Connection.getSystemConfig', () => {
        const NEW_CONFIG = { ...SYSTEM_CONFIG, common: { ...SYSTEM_CONFIG.common, language: 'en' } };

        beforeEach(() => start());

        it('answers with the config loaded at the login', async () => {
            assert.deepEqual(await conn.getSystemConfig(), SYSTEM_CONFIG);
            assert.equal(socket.requests.length, 0);
        });

        it('reads system.config anew on update and keeps it', async () => {
            const promise = conn.getSystemConfig(true);
            assert.deepEqual(socket.lastRequest('getObject').args, ['system.config']);
            socket.lastAnswer('getObject')(null, NEW_CONFIG);
            assert.deepEqual(await promise, NEW_CONFIG);

            assert.deepEqual(await conn.getSystemConfig(), NEW_CONFIG);
            assert.equal(socket.requests.length, 1);
        });

        it('adds empty common and native to an incomplete config', async () => {
            const promise = conn.getSystemConfig(true);
            socket.lastAnswer('getObject')(null, { _id: 'system.config', type: 'config' });

            assert.deepEqual(await promise, { _id: 'system.config', type: 'config', common: {}, native: {} });
        });

        it('resolves an empty config when system.config does not exist', async () => {
            const promise = conn.getSystemConfig(true);
            socket.lastAnswer('getObject')(null, null);

            assert.deepEqual(await promise, { common: {}, native: {} });
        });

        it('rejects with the error as Error and asks anew on the next call', async () => {
            const failed = conn.getSystemConfig(true);
            socket.lastAnswer('getObject')('permissionError');
            await assert.rejects(failed, error => error instanceof Error && error.message === 'permissionError');

            const next = conn.getSystemConfig();
            assert.equal(socket.requests.length, 2);
            socket.lastAnswer('getObject')(null, NEW_CONFIG);
            assert.deepEqual(await next, NEW_CONFIG);
        });
    });

    describe('Connection.getCompactSystemConfig', () => {
        beforeEach(() => start());

        it('adds empty common and native to an incomplete config', async () => {
            const promise = conn.getCompactSystemConfig();
            socket.lastAnswer('getCompactSystemConfig')(null, null);

            assert.deepEqual(await promise, { common: {}, native: {} });
        });

        it('caches the config until an update is requested', async () => {
            const first = conn.getCompactSystemConfig();
            socket.lastAnswer('getCompactSystemConfig')(null, SYSTEM_CONFIG);
            await first;

            assert.deepEqual(await conn.getCompactSystemConfig(), SYSTEM_CONFIG);
            assert.equal(socket.requests.length, 1);

            void conn.getCompactSystemConfig(true);
            assert.equal(socket.requests.length, 2);
        });
    });

    describe('Connection.getIpAddresses', () => {
        beforeEach(() => start());

        it('reads the addresses from the host object', async () => {
            const promise = conn.getIpAddresses('myhost');
            assert.deepEqual(socket.lastRequest('getObject').args, ['system.host.myhost']);
            socket.lastAnswer('getObject')(null, HOST);

            assert.deepEqual(await promise, ['192.168.1.2', '::1']);
        });

        it('resolves no addresses for a missing host or a host without addresses', async () => {
            const missing = conn.getIpAddresses('myhost');
            socket.lastAnswer('getObject')(null, null);
            assert.deepEqual(await missing, []);

            const withoutAddresses = conn.getIpAddresses('myhost', true);
            socket.lastAnswer('getObject')(null, obj('system.host.myhost', 'host'));
            assert.deepEqual(await withoutAddresses, []);
        });

        it('caches the addresses per host until an update is requested', async () => {
            const first = conn.getIpAddresses('myhost');
            socket.lastAnswer('getObject')(null, HOST);
            await first;

            assert.deepEqual(await conn.getIpAddresses('system.host.myhost'), ['192.168.1.2', '::1']);
            assert.equal(socket.requests.length, 1);

            void conn.getIpAddresses('otherhost');
            assert.equal(socket.lastRequest('getObject').args[0], 'system.host.otherhost');
            void conn.getIpAddresses('myhost', true);
            assert.equal(socket.requests.length, 3);
        });

        it('rejects with the error as Error and asks anew on the next call', async () => {
            const failed = conn.getIpAddresses('myhost');
            socket.lastAnswer('getObject')('permissionError');
            await assert.rejects(failed, error => error instanceof Error && error.message === 'permissionError');

            void conn.getIpAddresses('myhost');
            assert.equal(socket.requests.length, 2);
        });
    });

    describe('Connection.getUuid', () => {
        beforeEach(() => start());

        it('reads the uuid from system.meta.uuid once', async () => {
            const promise = conn.getUuid();
            assert.deepEqual(socket.lastRequest('getObject').args, ['system.meta.uuid']);
            socket.lastAnswer('getObject')(null, { ...obj('system.meta.uuid', 'meta'), native: { uuid: 'abc-123' } });
            assert.equal(await promise, 'abc-123');

            assert.equal(await conn.getUuid(), 'abc-123');
            assert.equal(socket.requests.length, 1);
        });

        it('resolves undefined when the object does not exist', async () => {
            const promise = conn.getUuid();
            socket.lastAnswer('getObject')(null, null);

            assert.equal(await promise, undefined);
        });

        it('rejects with the error as Error and asks anew on the next call', async () => {
            const failed = conn.getUuid();
            socket.lastAnswer('getObject')('permissionError');
            await assert.rejects(failed, error => error instanceof Error && error.message === 'permissionError');

            void conn.getUuid();
            assert.equal(socket.requests.length, 2);
        });
    });

    describe('Connection.getWebServerName', () => {
        beforeEach(() => start());

        it('asks the server only once', async () => {
            const first = conn.getWebServerName();
            socket.lastAnswer('getAdapterName')(null, 'web.0');
            await first;

            assert.equal(await conn.getWebServerName(), 'web.0');
            assert.equal(socket.requests.length, 1);
        });
    });

    describe('Connection.getCurrentUser', () => {
        beforeEach(() => start());

        it('asks the server on every call', async () => {
            const first = conn.getCurrentUser();
            socket.lastAnswer('authEnabled')(true, 'admin');
            assert.equal(await first, 'admin');

            const second = conn.getCurrentUser();
            socket.lastAnswer('authEnabled')(true, 'user');
            assert.equal(await second, 'user');
            assert.equal(socket.requests.length, 2);
        });
    });

    describe('Connection.checkFeatureSupported', () => {
        beforeEach(() => start());

        it('caches the answer per feature until an update is requested', async () => {
            const first = conn.checkFeatureSupported('ALIAS');
            socket.lastAnswer('checkFeatureSupported')(null, true);
            await first;

            assert.equal(await conn.checkFeatureSupported('ALIAS'), true);
            assert.equal(socket.requests.length, 1);

            const other = conn.checkFeatureSupported('CONTROLLER_CMD_EXEC_FILES');
            assert.deepEqual(socket.lastRequest('checkFeatureSupported').args, ['CONTROLLER_CMD_EXEC_FILES']);
            socket.lastAnswer('checkFeatureSupported')(null, false);
            assert.equal(await other, false);

            const updated = conn.checkFeatureSupported('ALIAS', true);
            socket.lastAnswer('checkFeatureSupported')(null, false);
            assert.equal(await updated, false);
            assert.equal(socket.requests.length, 3);
        });
    });

    describe('Connection.getAdapterInstances', () => {
        const HM_RPC_0 = obj('system.adapter.hm-rpc.0', 'instance', { name: 'hm-rpc' });
        const HM_RPC_1 = obj('system.adapter.hm-rpc.1', 'instance', { name: 'hm-rpc' });
        const ADMIN_0 = obj('system.adapter.admin.0', 'instance', { name: 'admin' });

        beforeEach(() => start());

        it('lists the instances of an adapter', async () => {
            const promise = conn.getAdapterInstances('hm-rpc');
            assert.deepEqual(socket.lastRequest('getObjectView').args, [
                'system',
                'instance',
                { startkey: 'system.adapter.hm-rpc.', endkey: 'system.adapter.hm-rpc.\u9999' },
            ]);
            socket.lastAnswer('getObjectView')(null, rows(HM_RPC_0, ADMIN_0, HM_RPC_1));

            assert.deepEqual(await promise, [HM_RPC_0, HM_RPC_1]);
        });

        it('lists all instances', async () => {
            const promise = conn.getAdapterInstances();
            assert.deepEqual(socket.lastRequest('getObjectView').args, [
                'system',
                'instance',
                { startkey: 'system.adapter.', endkey: 'system.adapter.\u9999' },
            ]);
            socket.lastAnswer('getObjectView')(null, rows(ADMIN_0, HM_RPC_0));

            assert.deepEqual(await promise, [ADMIN_0, HM_RPC_0]);
        });

        it('caches the instances per adapter until an update is requested', async () => {
            const first = conn.getAdapterInstances('hm-rpc');
            socket.lastAnswer('getObjectView')(null, rows(HM_RPC_0));
            await first;

            assert.deepEqual(await conn.getAdapterInstances('hm-rpc'), [HM_RPC_0]);
            assert.equal(socket.requests.length, 1);

            void conn.getAdapterInstances('admin');
            void conn.getAdapterInstances('hm-rpc', true);
            assert.equal(socket.requests.length, 3);
        });

        it('takes a boolean as the only argument for the update of all instances', async () => {
            const first = conn.getAdapterInstances();
            socket.lastAnswer('getObjectView')(null, rows(ADMIN_0));
            await first;

            const updated = conn.getAdapterInstances(true);
            assert.equal(socket.requests.length, 2);
            assert.deepEqual(socket.lastRequest('getObjectView').args[2], {
                startkey: 'system.adapter.',
                endkey: 'system.adapter.\u9999',
            });
            socket.lastAnswer('getObjectView')(null, rows(ADMIN_0, HM_RPC_0));
            assert.deepEqual(await updated, [ADMIN_0, HM_RPC_0]);

            assert.deepEqual(await conn.getAdapterInstances(), [ADMIN_0, HM_RPC_0]);
            assert.equal(socket.requests.length, 2);
        });

        it('rejects with the error as Error and asks anew on the next call', async () => {
            const failed = conn.getAdapterInstances('hm-rpc');
            socket.lastAnswer('getObjectView')('permissionError');
            await assert.rejects(failed, error => error instanceof Error && error.message === 'permissionError');

            void conn.getAdapterInstances('hm-rpc');
            assert.equal(socket.requests.length, 2);
        });
    });

    describe('Connection.getAdapters', () => {
        const HM_RPC = obj('system.adapter.hm-rpc', 'adapter', { name: 'hm-rpc' });
        const ADMIN = obj('system.adapter.admin', 'adapter', { name: 'admin' });

        beforeEach(() => start());

        it('lists the adapter with the given name', async () => {
            const promise = conn.getAdapters('hm-rpc');
            assert.deepEqual(socket.lastRequest('getObjectView').args, [
                'system',
                'adapter',
                { startkey: 'system.adapter.hm-rpc', endkey: 'system.adapter.hm-rpc' },
            ]);
            socket.lastAnswer('getObjectView')(null, rows(ADMIN, HM_RPC));

            assert.deepEqual(await promise, [HM_RPC]);
        });

        it('lists all adapters', async () => {
            const promise = conn.getAdapters();
            assert.deepEqual(socket.lastRequest('getObjectView').args, [
                'system',
                'adapter',
                { startkey: 'system.adapter.', endkey: 'system.adapter.\u9999' },
            ]);
            socket.lastAnswer('getObjectView')(null, rows(ADMIN, HM_RPC));

            assert.deepEqual(await promise, [ADMIN, HM_RPC]);
        });

        it('caches the adapters per name until an update is requested', async () => {
            const first = conn.getAdapters('hm-rpc');
            socket.lastAnswer('getObjectView')(null, rows(HM_RPC));
            await first;

            assert.deepEqual(await conn.getAdapters('hm-rpc'), [HM_RPC]);
            assert.equal(socket.requests.length, 1);

            void conn.getAdapters();
            void conn.getAdapters('hm-rpc', true);
            assert.equal(socket.requests.length, 3);
        });

        it('rejects with the error as Error and asks anew on the next call', async () => {
            const failed = conn.getAdapters('hm-rpc');
            socket.lastAnswer('getObjectView')('permissionError');
            await assert.rejects(failed, error => error instanceof Error && error.message === 'permissionError');

            void conn.getAdapters('hm-rpc');
            assert.equal(socket.requests.length, 2);
        });
    });

    describe('Connection.getGroups', () => {
        beforeEach(() => start());

        it('skips the rows without an object and resolves no groups for an empty answer', async () => {
            const promise = conn.getGroups();
            socket.lastAnswer('getObjectView')(null, {
                rows: [{ id: 'system.group.x', value: null }, ...rows(GROUP).rows],
            });
            assert.deepEqual(await promise, [GROUP]);

            const empty = conn.getGroups(true);
            socket.lastAnswer('getObjectView')(null, null);
            assert.deepEqual(await empty, []);
        });

        it('caches the groups until an update is requested', async () => {
            const first = conn.getGroups();
            socket.lastAnswer('getObjectView')(null, rows(GROUP));
            await first;

            assert.deepEqual(await conn.getGroups(), [GROUP]);
            assert.equal(socket.requests.length, 1);

            void conn.getGroups(true);
            assert.equal(socket.requests.length, 2);
        });
    });

    describe('Connection.sendTo', () => {
        beforeEach(() => start());

        it('resolves with an error of the instance instead of rejecting', async () => {
            const promise = conn.sendTo('email.0', 'send', { to: 'user@example.com' });
            socket.lastAnswer('sendTo')({ error: 'No recipient' });

            assert.deepEqual(await promise, { error: 'No recipient' });
        });

        it('sends no data when none is given', () => {
            void conn.sendTo('email.0', 'ping');

            assert.deepEqual(socket.lastRequest('sendTo').args, ['email.0', 'ping', undefined]);
        });
    });

    describe('cached requests after a failure', () => {
        it('still reports the error to a caller that does not handle it', async () => {
            // node:test fails every test with an unhandled rejection, so it is observed in a child process
            const script = `
                const { Connection } = require(${JSON.stringify(join(__dirname, '..', 'src', 'Connection.js'))});
                const helpers = require(${JSON.stringify(join(__dirname, 'lib', 'helpers.js'))});
                process.on('unhandledRejection', reason => {
                    console.log('unhandled: ' + reason);
                    process.exit(0);
                });
                (async () => {
                    helpers.resetGlobals();
                    const { conn, socket } = await helpers.createLoggedInConnection(Connection);
                    socket.respond('getObjectView', () => ['permissionError']);
                    conn.getEnums();
                    setTimeout(() => {
                        console.log('no unhandled rejection');
                        process.exit(0);
                    }, 200);
                })();
            `;

            const { stdout } = await promisify(execFile)(process.execPath, ['-e', script]);

            assert.equal(stdout.trim(), 'unhandled: permissionError');
        });

        const CACHED: { call: string; run: (conn: Connection) => Promise<unknown>; event: string }[] = [
            { call: 'getEnums', run: conn => conn.getEnums('rooms'), event: 'getObjectView' },
            {
                call: 'getCompactSystemConfig',
                run: conn => conn.getCompactSystemConfig(),
                event: 'getCompactSystemConfig',
            },
            { call: 'getWebServerName', run: conn => conn.getWebServerName(), event: 'getAdapterName' },
            {
                call: 'checkFeatureSupported',
                run: conn => conn.checkFeatureSupported('ALIAS'),
                event: 'checkFeatureSupported',
            },
            { call: 'getGroups', run: conn => conn.getGroups(), event: 'getObjectView' },
        ];

        beforeEach(() => start());

        for (const c of CACHED) {
            it(`${c.call} asks anew on the next call`, async () => {
                const failed = c.run(conn);
                socket.lastAnswer(c.event)('permissionError');
                await assert.rejects(failed);

                track(c.run(conn));
                assert.equal(socket.requestsOf(c.event).length, 2);
            });
        }
    });

    describe('without a connection', () => {
        const CALLS: [string, (conn: Connection) => Promise<unknown>][] = [
            ['getObjects', conn => conn.getObjects()],
            ['getObject', conn => conn.getObject(STATE_ID)],
            ['setObject', conn => conn.setObject(STATE_ID, STATE_OBJ)],
            ['getEnums', conn => conn.getEnums()],
            ['readFile', conn => conn.readFile('vis.0', 'main/vis-views.json')],
            ['writeFile64', conn => conn.writeFile64('vis.0', 'main/vis-views.json', '{}')],
            ['cmdExec', conn => conn.cmdExec('myhost', 'ls', 7)],
            ['getSystemConfig', conn => conn.getSystemConfig()],
            ['getAdapterInstances', conn => conn.getAdapterInstances('hm-rpc')],
            ['sendTo', conn => conn.sendTo('email.0', 'send', {})],
        ];

        it('rejects the requests before the login without sending them', async () => {
            ({ conn, socket } = await createConnection(Connection));

            for (const [name, call] of CALLS) {
                await assert.rejects(call(conn), { message: ERRORS.NOT_CONNECTED }, name);
            }
            assert.equal(socket.requests.length, 0);
        });

        it('rejects a new request after a disconnect but answers from the cache', async () => {
            await start();
            socket.fire('disconnect');

            await assert.rejects(conn.getObject(STATE_ID), { message: ERRORS.NOT_CONNECTED });
            assert.deepEqual(await conn.getSystemConfig(), SYSTEM_CONFIG);
            assert.equal(socket.requests.length, 0);
        });
    });
});
