import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Connection, isPermissionError, type SocketACL } from '../src/Connection.js';
import { createLoggedInConnection, resetGlobals } from './lib/helpers.js';

/** A user like the demo user: may read and list objects, has neither `sendto` nor `execute` */
const RESTRICTED: SocketACL = {
    user: 'system.user.user',
    groups: ['system.group.user'],
    object: { read: true, list: true, write: false, delete: false },
    state: { read: true, list: true, write: true, delete: false, create: true },
    other: { http: true, execute: false, sendto: false },
};

describe('Connection permissions', () => {
    let conn: Connection;

    beforeEach(async () => {
        resetGlobals();
        ({ conn } = await createLoggedInConnection(Connection));
    });

    afterEach(() => {
        conn.destroy();
    });

    describe('hasPermission', () => {
        it('answers from the rights of the user', () => {
            conn.acl = RESTRICTED;
            assert.equal(conn.hasPermission('object', 'read'), true);
            assert.equal(conn.hasPermission('object', 'write'), false);
            assert.equal(conn.hasPermission('other', 'http'), true);
            assert.equal(conn.hasPermission('other', 'sendto'), false);
        });

        it('denies a right of a block the group does not have at all', () => {
            conn.acl = RESTRICTED;
            assert.equal(conn.hasPermission('file', 'list'), false);
            assert.equal(conn.hasPermission('users', 'write'), false);
        });

        it('allows everything to the user admin', () => {
            conn.acl = { user: 'system.user.admin', groups: [] };
            assert.equal(conn.hasPermission('other', 'execute'), true);
            assert.equal(conn.hasPermission('file', 'delete'), true);
        });

        it('allows everything to a member of the group administrator, whatever is stored for it', () => {
            conn.acl = { ...RESTRICTED, groups: ['system.group.user', 'system.group.administrator'] };
            assert.equal(conn.hasPermission('other', 'sendto'), true);
            assert.equal(conn.hasPermission('object', 'delete'), true);
        });

        it('lets the server decide as long as the rights are not known', () => {
            conn.acl = null;
            assert.equal(conn.hasPermission('other', 'sendto'), true);
        });
    });

    describe('isAdministrator', () => {
        it('knows the user admin and the group administrator', () => {
            conn.acl = { user: 'system.user.admin', groups: [] };
            assert.equal(conn.isAdministrator(), true);
            conn.acl = { ...RESTRICTED, groups: ['system.group.administrator'] };
            assert.equal(conn.isAdministrator(), true);
        });

        it('is false for other users and for unknown rights', () => {
            conn.acl = RESTRICTED;
            assert.equal(conn.isAdministrator(), false);
            conn.acl = null;
            assert.equal(conn.isAdministrator(), false);
        });
    });
});

describe('isPermissionError', () => {
    it('recognizes the answers of the server', () => {
        assert.equal(isPermissionError('permissionError'), true);
        assert.equal(isPermissionError(new Error('permissionError')), true);
        assert.equal(isPermissionError({ error: 'permissionError' }), true);
        assert.equal(isPermissionError('Cannot getRepository: permissionError'), true);
    });

    it('recognizes the errors of the host commands', () => {
        assert.equal(isPermissionError('May not read "getHostInfo"'), true);
    });

    it('does not take other errors for a missing right', () => {
        assert.equal(isPermissionError('timeout'), false);
        assert.equal(isPermissionError(new Error('Cannot read "getHostInfo"')), false);
        assert.equal(isPermissionError({ error: 'Not supported' }), false);
        assert.equal(isPermissionError({}), false);
        assert.equal(isPermissionError(null), false);
        assert.equal(isPermissionError(undefined), false);
    });
});
