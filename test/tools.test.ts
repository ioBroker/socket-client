import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { createDeferredPromise } from '../src/DeferredPromise.js';
import { getObjectViewResultToArray, normalizeHostId, objectIdToHostname, pattern2RegEx, wait } from '../src/tools.js';
import { flush, track } from './lib/helpers.js';

describe('tools', () => {
    describe('getObjectViewResultToArray', () => {
        it('returns the values of the rows', () => {
            const a = { _id: 'a' } as ioBroker.Object;
            const b = { _id: 'b' } as ioBroker.Object;

            assert.deepEqual(
                getObjectViewResultToArray({
                    rows: [
                        { id: 'a', value: a },
                        { id: 'b', value: b },
                    ],
                }),
                [a, b],
            );
        });

        it('skips rows without a value', () => {
            const a = { _id: 'a' } as ioBroker.Object;

            assert.deepEqual(
                getObjectViewResultToArray({
                    rows: [
                        { id: 'a', value: a },
                        { id: 'b', value: null as any },
                        { id: 'c', value: undefined as any },
                    ],
                }),
                [a],
            );
        });

        it('returns an empty array without a result', () => {
            assert.deepEqual(getObjectViewResultToArray(undefined), []);
        });
    });

    describe('normalizeHostId', () => {
        it('adds "system.host." to a host name', () => {
            assert.equal(normalizeHostId('raspberry'), 'system.host.raspberry');
        });

        it('keeps a host id', () => {
            assert.equal(normalizeHostId('system.host.raspberry'), 'system.host.raspberry');
        });
    });

    describe('objectIdToHostname', () => {
        it('removes "system.host." from a host id', () => {
            assert.equal(objectIdToHostname('system.host.raspberry'), 'raspberry');
        });

        it('keeps a host name', () => {
            assert.equal(objectIdToHostname('raspberry'), 'raspberry');
        });

        it('is the reverse of normalizeHostId', () => {
            assert.equal(objectIdToHostname(normalizeHostId('raspberry')), 'raspberry');
        });
    });

    describe('pattern2RegEx', () => {
        const matches = (pattern: string, id: string): boolean => new RegExp(pattern2RegEx(pattern)).test(id);

        it('matches only the exact id without wildcards', () => {
            assert.equal(pattern2RegEx('javascript.0.test'), '^javascript\\.0\\.test$');
            assert.equal(matches('javascript.0.test', 'javascript.0.test'), true);
            assert.equal(matches('javascript.0.test', 'javascript.0.test2'), false);
            assert.equal(matches('javascript.0.test', 'my.javascript.0.test'), false);
            assert.equal(matches('javascript.0.test', 'javascript00test'), false);
        });

        it('matches every id with the given start for a wildcard at the end', () => {
            assert.equal(pattern2RegEx('system.adapter.*'), '^system\\.adapter\\..*');
            assert.equal(matches('system.adapter.*', 'system.adapter.admin.0.alive'), true);
            assert.equal(matches('system.adapter.*', 'system.host.raspberry'), false);
        });

        it('matches every id with the given end for a wildcard at the start', () => {
            assert.equal(pattern2RegEx('*.alive'), '.*\\.alive$');
            assert.equal(matches('*.alive', 'system.adapter.admin.0.alive'), true);
            assert.equal(matches('*.alive', 'system.adapter.admin.0.alive.old'), false);
        });

        it('matches any characters for a wildcard in the middle', () => {
            assert.equal(matches('system.adapter.*.alive', 'system.adapter.admin.0.alive'), true);
            assert.equal(matches('system.adapter.*.alive', 'system.adapter.admin.0.connected'), false);
        });

        it('matches everything for "*"', () => {
            assert.equal(pattern2RegEx('*'), '.*');
            assert.equal(matches('*', 'any.id'), true);
        });

        it('escapes the special characters of regular expressions', () => {
            const id = 'a-b/c\\d^e$f+g?h.i(j)k|l[m]n{o}';
            assert.equal(matches(id, id), true);
            assert.equal(matches('a+b', 'aab'), false);
            assert.equal(matches('a?', 'a'), false);
        });

        it('matches only the empty id for an empty pattern', () => {
            assert.equal(pattern2RegEx(''), '^$');
            assert.equal(pattern2RegEx(undefined as unknown as string), '^$');
        });
    });

    describe('wait', () => {
        afterEach(() => mock.timers.reset());

        it('resolves after the given time', async () => {
            mock.timers.enable({ apis: ['setTimeout'] });
            const promise = track(wait(100));

            mock.timers.tick(99);
            await flush();
            assert.equal(promise.settled, false);

            mock.timers.tick(1);
            await flush();
            assert.equal(promise.settled, true);
        });
    });

    describe('createDeferredPromise', () => {
        it('is a promise', () => {
            assert.ok(createDeferredPromise() instanceof Promise);
        });

        it('resolves from outside', async () => {
            const promise = createDeferredPromise<number>();
            promise.resolve(5);

            assert.equal(await promise, 5);
        });

        it('rejects from outside', async () => {
            const promise = createDeferredPromise();
            promise.reject(new Error('failed'));

            await assert.rejects(promise, /failed/);
        });

        it('keeps the first result', async () => {
            const promise = createDeferredPromise<number>();
            promise.resolve(1);
            promise.resolve(2);
            promise.reject(new Error('too late'));

            assert.equal(await promise, 1);
        });

        it('stays pending until resolved', async () => {
            const promise = track(createDeferredPromise());
            await flush();

            assert.equal(promise.settled, false);
        });
    });
});
