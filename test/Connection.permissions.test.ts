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

    describe('hasObjectPermission', () => {
        /** A user who may write and delete objects by the rights of his group */
        const WRITER: SocketACL = {
            ...RESTRICTED,
            user: 'system.user.writer',
            groups: ['system.group.writer'],
            object: { read: true, list: true, write: true, delete: true },
        };
        /** The rights a new object gets by default: owner and group read and write, everybody else reads */
        const ADMIN_OWNED = {
            acl: {
                owner: 'system.user.admin',
                ownerGroup: 'system.group.administrator',
                object: 0x664,
                state: 0x664,
            },
        };

        it('lets everybody else only read an object of admin', () => {
            conn.acl = WRITER;
            assert.equal(conn.hasObjectPermission(ADMIN_OWNED, 'read'), true);
            assert.equal(conn.hasObjectPermission(ADMIN_OWNED, 'write'), false);
            assert.equal(conn.hasObjectPermission(ADMIN_OWNED, 'delete'), false);
            assert.equal(conn.hasObjectPermission(ADMIN_OWNED, 'write', 'state'), false);
        });

        it('uses the rights of the owner and of the owner group', () => {
            conn.acl = WRITER;
            const own = { acl: { ...ADMIN_OWNED.acl, owner: 'system.user.writer', object: 0x604 } };
            assert.equal(conn.hasObjectPermission(own, 'write'), true);
            const group = { acl: { ...ADMIN_OWNED.acl, ownerGroup: 'system.group.writer', object: 0x064 } };
            assert.equal(conn.hasObjectPermission(group, 'write'), true);
            const groupReadOnly = { acl: { ...group.acl, object: 0x646 } };
            assert.equal(conn.hasObjectPermission(groupReadOnly, 'write'), false);
        });

        it('needs the right of the group too', () => {
            conn.acl = RESTRICTED;
            const everybodyWrites = { acl: { ...ADMIN_OWNED.acl, object: 0x666, state: 0x666 } };
            assert.equal(conn.hasObjectPermission(everybodyWrites, 'write'), false);
            assert.equal(conn.hasObjectPermission(everybodyWrites, 'write', 'state'), true);
            assert.equal(conn.hasObjectPermission(everybodyWrites, 'delete', 'state'), false);
        });

        it('checks a state with the rights of the object, if it has none of its own', () => {
            conn.acl = RESTRICTED;
            const objectOnly = {
                acl: { owner: 'system.user.admin', ownerGroup: 'system.group.administrator', object: 0x666 },
            };
            assert.equal(conn.hasObjectPermission(objectOnly, 'write', 'state'), true);
            const noRights = { acl: { ...objectOnly.acl, object: 0 } };
            assert.equal(conn.hasObjectPermission(noRights, 'write', 'state'), true);
        });

        it('does not check objects without rights of their own', () => {
            conn.acl = WRITER;
            assert.equal(conn.hasObjectPermission({}, 'write'), true);
            assert.equal(conn.hasObjectPermission(null, 'write'), true);
        });

        it('allows everything to administrators and as long as the rights are not known', () => {
            conn.acl = { ...WRITER, groups: ['system.group.administrator'] };
            assert.equal(conn.hasObjectPermission({ acl: { ...ADMIN_OWNED.acl, object: 0 } }, 'write'), true);
            conn.acl = null;
            assert.equal(conn.hasObjectPermission(ADMIN_OWNED, 'delete'), true);
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
