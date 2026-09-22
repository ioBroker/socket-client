import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as socketClient from '../src/index.js';

describe('index', () => {
    it('exports the connections and the constants', () => {
        assert.deepEqual(Object.keys(socketClient).sort(), [
            'AdminConnection',
            'Connection',
            'ERRORS',
            'NOT_CONNECTED',
            'PERMISSION_ERROR',
            'PROGRESS',
        ]);
    });

    it('exports an AdminConnection that extends the Connection', () => {
        assert.ok(socketClient.AdminConnection.prototype instanceof socketClient.Connection);
    });

    it('exports the progress steps in their order', () => {
        const { PROGRESS } = socketClient;
        assert.ok(PROGRESS.CONNECTING < PROGRESS.CONNECTED);
        assert.ok(PROGRESS.CONNECTED < PROGRESS.OBJECTS_LOADED);
        assert.ok(PROGRESS.OBJECTS_LOADED < PROGRESS.READY);
    });

    it('exports the error texts of the server', () => {
        const { ERRORS, NOT_CONNECTED, PERMISSION_ERROR } = socketClient;
        assert.equal(PERMISSION_ERROR, 'permissionError');
        assert.equal(NOT_CONNECTED, 'notConnectedError');
        assert.equal(ERRORS.PERMISSION_ERROR, PERMISSION_ERROR);
        assert.equal(ERRORS.NOT_CONNECTED, NOT_CONNECTED);
    });
});
