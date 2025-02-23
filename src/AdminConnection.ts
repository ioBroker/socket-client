import { Connection, ERRORS, type RequestOptions } from './Connection.js';
import type { ConnectionProps } from './ConnectionProps.js';
import type {
    AdminEmitEvents,
    AdminListenEvents,
    CompactAdapterInfo,
    CompactHost,
    CompactInstalledInfo,
    CompactInstanceInfo,
    CompactRepository,
    CompactSystemRepository,
    License,
    LogFile,
} from './SocketEvents.js';
import { getObjectViewResultToArray, normalizeHostId, objectIdToHostname } from './tools.js';

interface Certificate {
    name: string;
    type: 'public' | 'private' | 'chained';
}

// taken from "@iobroker/js-controller-common-db/build/lib/common/notificationHandler"
export type MultilingualObject = Exclude<ioBroker.StringOrTranslated, string>;
export type Severity = 'info' | 'notify' | 'alert';
export interface NotificationMessageObject {
    message: string;
    ts: number;
}

type DockerInformation =
    | {
          /** If it is a Docker installation */
          isDocker: boolean;
          /** If it is the official Docker image */
          isOfficial: true;
          /** Semver string for official Docker image */
          officialVersion: string;
      }
    | {
          /** If it is a Docker installation */
          isDocker: boolean;
          /** If it is the official Docker image */
          isOfficial: false;
      };

export interface HostInfo {
    /** Converted OS for human readability */
    Platform:
        | 'aix'
        | 'android'
        | 'darwin'
        | 'freebsd'
        | 'haiku'
        | 'linux'
        | 'openbsd'
        | 'sunos'
        | 'win32'
        | 'cygwin'
        | 'netbsd'
        | 'docker'
        | 'Windows'
        | 'OSX';
    /** The underlying OS */
    os:
        | 'aix'
        | 'android'
        | 'darwin'
        | 'freebsd'
        | 'haiku'
        | 'linux'
        | 'openbsd'
        | 'sunos'
        | 'win32'
        | 'cygwin'
        | 'netbsd';
    /** Information about the docker installation */
    dockerInformation?: DockerInformation;
    /** Host architecture */
    Architecture: string;
    /** Number of CPUs */
    CPUs: number | null;
    /** CPU speed */
    Speed: number | null;
    /** CPU model */
    Model: string | null;
    /** Total RAM of host */
    RAM: number;
    /** System uptime in seconds */
    'System uptime': number;
    /** Node.JS version */
    'Node.js': string;
    /** Current time to compare to local time */
    time: number;
    /** Timezone offset to compare to local time */
    timeOffset: number;
    /** Number of available adapters */
    'adapters count': number;
    /** NPM version */
    NPM: string;
	/** Running instances */
	'Active instances': number;
	location: string;
	/** Uptime */
	Uptime: number;
}

export interface AdapterInformation {
	/** this flag is only true for the js-controller */
	controller: boolean;
	/** adapter version */
	version: string;
	/** path to icon of the adapter */
	icon: string;
	/** path to local icon of the adapter */
	localIcon?: string;
	/** title of the adapter */
	title: string;
	/** title of the adapter in multiple languages */
	titleLang: ioBroker.Translated;
	/** description of the adapter in multiple languages */
	desc: ioBroker.Translated;
	/** platform of the adapter */
	platform: 'Javascript/Node.js';
	/** keywords of the adapter */
	keywords: string[];
	/** path to a readme file */
	readme: string;
	/** The installed adapter version, not existing on controller */
	runningVersion?: string;
	/** type of the adapter */
	type: string;
	/** license of the adapter */
	license: string;
	/** url to license information */
	licenseUrl?: string;
}

export type AdapterRating = {
	// @ts-expect-error rating is here
	rating?: { r: number; c: number };
	[version: string]: { r: number; c: number };
};
export type AdapterRatingInfo = AdapterRating & { title: string };

export type AdapterInformationEx = AdapterInformation & {
	installedFrom?: string;
	enabled: number;
	count: number;
	ignoreVersion?: string;
};
export type InstalledInfo = { [adapterName: string]: AdapterInformationEx } & {
	hosts?: { [hostName: string]: ioBroker.HostCommon & { host: string; runningVersion: string } };
};

interface RepositoryEntry {
	/** Link to external icon */
	extIcon: string;
	/** Translated title */
	titleLang: ioBroker.Translated;
	[other: string]: unknown;
}

/** The ioBroker repository */
export type Repository = Record<string, RepositoryEntry>;

export interface FilteredNotificationInformation {
    [scope: string]: {
        description: MultilingualObject;
        name: MultilingualObject;
        categories: {
            [category: string]: {
                description: MultilingualObject;
                name: MultilingualObject;
                severity: Severity;
                instances: {
                    [instance: string]: {
                        messages: NotificationMessageObject[];
                    };
                };
            };
        };
    };
}

function parseCertificate(name: string, cert: string): Certificate | void {
    if (!cert) {
        return;
    }

    let type: Certificate['type'];
    // If it is a filename, it could be everything
    if (cert.length < 700 && (cert.indexOf('/') !== -1 || cert.indexOf('\\') !== -1)) {
        if (name.toLowerCase().includes('private')) {
            type = 'private';
        } else if (cert.toLowerCase().includes('private')) {
            type = 'private';
        } else if (name.toLowerCase().includes('public')) {
            type = 'public';
        } else if (cert.toLowerCase().includes('public')) {
            type = 'public';
        } else if (name.toLowerCase().includes('chain')) {
            type = 'chained';
        } else if (cert.toLowerCase().includes('chain')) {
            type = 'chained';
        } else {
            // TODO: is this correct?
            return;
        }
    } else {
        type =
            cert.substring(0, '-----BEGIN RSA PRIVATE KEY'.length) === '-----BEGIN RSA PRIVATE KEY' ||
            cert.substring(0, '-----BEGIN PRIVATE KEY'.length) === '-----BEGIN PRIVATE KEY'
                ? 'private'
                : 'public';

        if (type === 'public') {
            const m = cert.split('-----END CERTIFICATE-----');
            if (m.filter(t => t.replace(/\r\n|\r|\n/, '').trim()).length > 1) {
                type = 'chained';
            }
        }
    }
    return { name, type };
}

export interface IPAddress {
    name: string;
    address: string;
    family: 'ipv4' | 'ipv6';
    internal?: boolean;
}

interface IPAddresses {
    IPs4: IPAddress[];
    IPs6: IPAddress[];
}

function parseIPAddresses(host: ioBroker.HostObject): IPAddresses {
    const IPs4: IPAddress[] = [
        {
            name: '[IPv4] 0.0.0.0 - Listen on all IPs',
            address: '0.0.0.0',
            family: 'ipv4',
        },
    ];
    const IPs6: IPAddress[] = [
        {
            name: '[IPv6] :: - Listen on all IPs',
            address: '::',
            family: 'ipv6',
        },
    ];
    if (host.native?.hardware?.networkInterfaces) {
        const list: Record<string, { family: 'IPv6' | 'IPv4'; address: string }[]> =
            host.native?.hardware?.networkInterfaces;

        Object.keys(list).forEach(inter => {
            list[inter].forEach(ip => {
                if (ip.family !== 'IPv6') {
                    IPs4.push({
                        name: `[${ip.family}] ${ip.address} - ${inter}`,
                        address: ip.address,
                        family: 'ipv4',
                    });
                } else {
                    IPs6.push({
                        name: `[${ip.family}] ${ip.address} - ${inter}`,
                        address: ip.address,
                        family: 'ipv6',
                    });
                }
            });
        });
    }
    return { IPs4, IPs6 };
}

export class AdminConnection extends Connection<AdminListenEvents, AdminEmitEvents> {
    constructor(props: ConnectionProps) {
        super(props);
    }

    // We overload the request method here because the admin connection's methods all have `requireAdmin: true`
    protected request<T>(options: RequestOptions<T>): Promise<T> {
        return super.request<T>({ requireAdmin: true, ...options });
    }

    /**
     * Get the stored certificates.
     *
     * @param update Force update.
     */
    getCertificates(update?: boolean): Promise<Certificate[]> {
        return this.request({
            cacheKey: 'cert',
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: async resolve => {
                const obj = await this.getObject('system.certificates');
                if (obj?.native?.certificates) {
                    resolve(
                        Object.entries<string>(obj.native.certificates)
                            .map(([name, cert]) => parseCertificate(name, cert))
                            .filter((cert): cert is Certificate => !!cert),
                    );
                } else {
                    resolve([]);
                }
            },
        });
    }

    /**
     * Get the logs from a host (only for admin connection).
     */
    getLogs(host: string, linesNumber: number = 200): Promise<(string | number)[] | string | { error: string }> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: resolve => {
                this._socket.emit('sendToHost', host, 'getLogs', linesNumber || 200, (lines: any) => {
                    resolve(lines);
                });
            },
        });
    }

    /**
     * Upgrade adapter with webserver.
     */
    upgradeAdapterWithWebserver(
        host: string,
        options: {
            version: string;
            adapterName: string;
            port: number;
            useHttps?: boolean;
            certPublicName?: string;
            certPrivateName?: string;
        },
    ): Promise<{ result: boolean }> {
        return this.request({
            commandTimeout: false,
            executor: resolve => {
                this._socket.emit(
                    'sendToHost',
                    host,
                    'upgradeAdapterWithWebserver',
                    options as any,
                    (result: unknown) => {
                        resolve(result as { result: boolean });
                    },
                );
            },
        });
    }

    /**
     * Upgrade controller
     */
    upgradeController(host: string, version: string, adminInstance: number): Promise<string> {
        return this.request({
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit(
                    'sendToHost',
                    host,
                    'upgradeController',
                    {
                        version,
                        adminInstance,
                    } as any,
                    (result: unknown) => {
                        const _result = result as {
                            result: string;
                            error?: string;
                        };
                        if (_result.error) {
                            reject(_result.error);
                        } else {
                            resolve(_result.result);
                        }
                    },
                );
            },
        });
    }

    /**
     * Read licenses from ioBroker.net anew
     */
    updateLicenses(
        /** login for ioBroker.net */
        login: string,
        /** password for ioBroker.net */
        password: string,
    ): Promise<License[] | undefined> {
        return this.request({
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('updateLicenses', login, password, (err, licenses?: License[]) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(licenses);
                    }
                });
            },
        });
    }

    /**
     * Upgrade controller
     */
    upgradeOsPackages(
        host: string,
        packages: { name: string; version?: string }[],
        restart?: boolean,
    ): Promise<{ success: boolean; error?: string }> {
        return this.request({
            commandTimeout: false,
            executor: resolve => {
                this._socket.emit(
                    'sendToHost',
                    host,
                    'upgradeOsPackages',
                    {
                        packages,
                        restart: !!restart,
                    } as any,
                    (result: unknown) => {
                        resolve(result as { success: boolean; error?: string });
                    },
                );
            },
        });
    }

    /**
     * Get the log files (only for admin connection).
     */
    getLogsFiles(host: string): Promise<LogFile[]> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('readLogs', host, (err, files) => {
                    if (err) {
                        reject(err);
                    }
                    resolve(files!);
                });
            },
        });
    }

    /**
     * Delete the logs from a host (only for admin connection).
     */
    delLogs(host: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('sendToHost', host, 'delLogs', null, err => {
                    if (err) {
                        reject(err);
                    }
                    resolve();
                });
            },
        });
    }

    /**
     * Delete a file of an adapter.
     *
     * @param adapter The adapter name.
     * @param fileName The file name.
     */
    deleteFile(adapter: string, fileName: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('deleteFile', adapter, fileName, err => {
                    if (err) {
                        reject(err);
                    }
                    resolve();
                });
            },
        });
    }

    /**
     * Delete a folder of an adapter.
     *
     * @param adapter The adapter name.
     * @param folderName The folder name.
     */
    deleteFolder(adapter: string, folderName: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('deleteFolder', adapter, folderName, err => {
                    if (err) {
                        reject(err);
                    }
                    resolve();
                });
            },
        });
    }
    /**
     * Rename file or folder in ioBroker DB
     *
     * @param adapter instance name
     * @param oldName current file name, e.g., main/vis-views.json
     * @param newName new file name, e.g., main/vis-views-new.json
     */
    rename(adapter: string, oldName: string, newName: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('rename', adapter, oldName, newName, err => {
                    if (err) {
                        reject(err);
                    }
                    resolve();
                });
            },
        });
    }

    /**
     * Rename file in ioBroker DB
     *
     * @param adapter instance name
     * @param oldName current file name, e.g., main/vis-views.json
     * @param newName new file name, e.g., main/vis-views-new.json
     */
    renameFile(adapter: string, oldName: string, newName: string): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit('renameFile', adapter, oldName, newName, err => {
                    if (err) {
                        reject(err);
                    }
                    resolve();
                });
            },
        });
    }

    /**
     * Get the list of all hosts.
     *
     * @param update Force update.
     */
    getHosts(update?: boolean): Promise<ioBroker.HostObject[]> {
        return this.request({
            cacheKey: 'hosts',
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit(
                    'getObjectView',
                    'system',
                    'host',
                    { startkey: 'system.host.', endkey: 'system.host.\u9999' },
                    (err, doc) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(getObjectViewResultToArray<ioBroker.HostObject>(doc));
                        }
                    },
                );
            },
        });
    }

    /**
     * Get the list of all users.
     *
     * @param update Force update.
     */
    getUsers(update?: boolean): Promise<ioBroker.UserObject[]> {
        return this.request({
            cacheKey: 'users',
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: (resolve, reject) => {
                this._socket.emit(
                    'getObjectView',
                    'system',
                    'user',
                    { startkey: 'system.user.', endkey: 'system.user.\u9999' },
                    (err, doc) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(getObjectViewResultToArray<ioBroker.UserObject>(doc));
                        }
                    },
                );
            },
        });
    }

    /**
     * Rename a group.
     *
     * @param id The id.
     * @param newId The new id.
     * @param newName The new name.
     */
    renameGroup(id: string, newId: string, newName: ioBroker.StringOrTranslated): Promise<void> {
        return this.request({
            // TODO: check if this should time out
            commandTimeout: false,
            executor: async resolve => {
                const groups = await this.getGroups(true);
                // renaming a group happens by re-creating the object under a different ID
                const subGroups = groups.filter(g => g._id.startsWith(`${id}.`));
                // First, do this for all sub-groups
                for (const group of subGroups) {
                    const oldGroupId = group._id;
                    const newGroupId = (newId + group._id.substring(id.length)) as ioBroker.ObjectIDs.Group;
                    group._id = newGroupId;

                    // Create a new object, then delete the old one if it worked
                    await this.setObject(newGroupId, group);
                    await this.delObject(oldGroupId);
                }
                // Then for the parent group
                const parentGroup = groups.find(g => g._id === id);
                if (parentGroup) {
                    const oldGroupId = parentGroup._id;
                    parentGroup._id = newId as ioBroker.ObjectIDs.Group;
                    if (newName !== undefined) {
                        (parentGroup.common as any) ??= {};
                        parentGroup.common.name = newName as any;
                    }

                    // Create a new object, then delete the old one if it worked
                    await this.setObject(newId, parentGroup);
                    await this.delObject(oldGroupId);
                }

                resolve();
            },
        });
    }

    /**
     * Get the host information.
     *
     * @param host host name
     * @param update Force update.
     * @param timeoutMs optional read timeout.
     */
    getHostInfo(host: string, update?: boolean, timeoutMs?: number): Promise<HostInfo> {
        host = normalizeHostId(host);
        return this.request({
            cacheKey: `hostInfo_${host}`,
            forceUpdate: update,
            commandTimeout: timeoutMs,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'getHostInfo', null, data => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (data === ERRORS.PERMISSION_ERROR) {
                        reject('May not read "getHostInfo"');
                    } else if (!data) {
                        reject('Cannot read "getHostInfo"');
                    } else {
                        resolve(data as HostInfo);
                    }
                });
            },
        });
    }

    /**
     * Get the host information (short version).
     *
     * @param host host name
     * @param update Force update.
     * @param timeoutMs optional read timeout.
     */
    getHostInfoShort(host: string, update?: boolean, timeoutMs?: number): Promise<HostInfo> {
        host = normalizeHostId(host);
        return this.request({
            cacheKey: `hostInfoShort_${host}`,
            forceUpdate: update,
            commandTimeout: timeoutMs,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'getHostInfoShort', null, data => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (data === ERRORS.PERMISSION_ERROR) {
                        reject('May not read "getHostInfoShort"');
                    } else if (!data) {
                        reject('Cannot read "getHostInfoShort"');
                    } else {
                        resolve(data as HostInfo);
                    }
                });
            },
        });
    }

    /**
     * Get the repository.
     *
     * @param host The host name.
     * @param args The arguments.
     * @param update Force update.
     * @param timeoutMs timeout in ms.
     */
    getRepository(
        host: string,
        args?: { update?: boolean; repo?: string | string[] } | string | null,
        update?: boolean,
        timeoutMs?: number,
    ): Promise<Repository> {
        return this.request({
            cacheKey: `repository_${host}`,
            forceUpdate: update,
            commandTimeout: timeoutMs,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'getRepository', args, data => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (data === ERRORS.PERMISSION_ERROR) {
                        reject('May not read "getRepository"');
                    } else if (!data) {
                        reject('Cannot read "getRepository"');
                    } else {
                        resolve(data as Repository);
                    }
                });
            },
        });
    }

    /**
     * Get the installed.
     *
     * @param host The host name.
     * @param update Force update.
     * @param cmdTimeout timeout in ms
     */
    getInstalled(host: string, update?: boolean, cmdTimeout?: number): Promise<InstalledInfo> {
        host = normalizeHostId(host);

        return this.request({
            cacheKey: `installed_${host}`,
            forceUpdate: update,
            commandTimeout: cmdTimeout,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'getInstalled', null, data => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (data === ERRORS.PERMISSION_ERROR) {
                        reject('May not read "getInstalled"');
                    } else if (!data) {
                        reject('Cannot read "getInstalled"');
                    } else {
                        resolve(data as InstalledInfo);
                    }
                });
            },
        });
    }

    /**
     * Execute a command on a host.
     */
    cmdExec(
        /** The host name. */
        host: string,
        /** The command to execute. */
        cmd: string,
        /** The command ID. */
        cmdId: number,
        /** Timeout of command in ms */
        cmdTimeout?: number,
    ): Promise<void> {
        return this.request({
            commandTimeout: cmdTimeout,
            executor: (resolve, reject, timeout) => {
                host = normalizeHostId(host);

                this._socket.emit('cmdExec', host, cmdId, cmd, err => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();

                    if (err) {
                        reject(err);
                    }
                    resolve();
                });
            },
        });
    }

    /**
     * Read the base settings of a given host.
     *
     * @param host The host name.
     */
    readBaseSettings(host: string): Promise<{ config?: ioBroker.IoBrokerJson; isActive?: boolean }> {
        // Make sure we deal with a hostname, not an object ID
        host = objectIdToHostname(host);

        return this.request({
            requireFeatures: ['CONTROLLER_READWRITE_BASE_SETTINGS'],
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'readBaseSettings', null, data => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();

                    if (data === ERRORS.PERMISSION_ERROR) {
                        reject('May not read "BaseSettings"');
                    } else if (!data) {
                        reject('Cannot read "BaseSettings"');
                    } else if ((data as { error?: string }).error) {
                        reject(new Error((data as { error?: string }).error));
                    } else {
                        resolve(data as { config: ioBroker.IoBrokerJson; isActive: boolean });
                    }
                });
            },
        });
    }

    /**
     * Write the base settings of a given host.
     *
     * @param host The host name.
     * @param config The configuration to write.
     */
    writeBaseSettings(host: string, config: ioBroker.IoBrokerJson): Promise<{ error?: string; result?: 'ok' }> {
        // Make sure we deal with a hostname, not an object ID
        host = objectIdToHostname(host);

        return this.request({
            requireFeatures: ['CONTROLLER_READWRITE_BASE_SETTINGS'],
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'writeBaseSettings', config, data => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();

                    if (data === ERRORS.PERMISSION_ERROR) {
                        reject('May not write "BaseSettings"');
                    } else if (!data) {
                        reject('Cannot write "BaseSettings"');
                    } else {
                        resolve(data);
                    }
                });
            },
        });
    }

    /**
     * Send command to restart the iobroker on host
     *
     * @param host The host name.
     */
    restartController(host: string): Promise<true> {
        // Make sure we deal with a hostname, not an object ID
        host = objectIdToHostname(host);

        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'restartController', null, () => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    resolve(true);
                });
            },
        });
    }

    /**
     * Read statistics information from host
     *
     * @param host The host name.
     * @param typeOfDiag one of none, normal, no-city, extended
     */
    getDiagData(
        host: string,
        typeOfDiag: 'none' | 'normal' | 'no-city' | 'extended',
    ): Promise<Record<string, any> | null> {
        // Make sure we deal with a hostname, not an object ID
        host = objectIdToHostname(host);

        return this.request({
            executor: (resolve, _reject, timeout) => {
                this._socket.emit('sendToHost', host, 'getDiagData', typeOfDiag, result => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (!result) {
                        resolve(null);
                    } else {
                        resolve(result as Promise<Record<string, any>>);
                    }
                });
            },
        });
    }

    /**
     * Change the password of the given user.
     *
     * @param user The user name.
     * @param password The new password.
     */
    changePassword(user: string, password: string): Promise<void> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('changePassword', user, password, err => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve();
                });
            },
        });
    }

    /**
     * Get the IP addresses of the given host.
     *
     * @param host The host name.
     * @param update Force update.
     */
    getIpAddresses(host: string, update?: boolean): Promise<string[]> {
        host = normalizeHostId(host);
        return this.request({
            cacheKey: `IPs_${host}`,
            forceUpdate: update,
            // TODO: check if this should time out
            commandTimeout: false,
            executor: async resolve => {
                const obj = await this.getObject(host);
                resolve(obj?.common.address ?? []);
            },
        });
    }

    /**
     * Get the IP addresses with interface names of the given host or find host by IP.
     *
     * @param ipOrHostName The IP address or host name.
     * @param update Force update.
     */
    getHostByIp(ipOrHostName: string, update?: boolean): Promise<IPAddress[]> {
        // Make sure we deal with a hostname, not an object ID
        ipOrHostName = objectIdToHostname(ipOrHostName);

        return this.request({
            cacheKey: `rIPs_${ipOrHostName}`,
            forceUpdate: update,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getHostByIp', ipOrHostName, (ip, host) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();

                    const { IPs4, IPs6 } = parseIPAddresses(host);
                    resolve([...IPs4, ...IPs6]);
                });
            },
        });
    }

    /**
     * Encrypt a text
     *
     * @param plaintext The text to encrypt.
     */
    encrypt(plaintext: string): Promise<string> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('encrypt', plaintext, (err, ciphertext) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(ciphertext!);
                });
            },
        });
    }

    /**
     * Decrypt a text
     *
     * @param ciphertext The text to decrypt.
     */
    decrypt(ciphertext: string): Promise<string> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('decrypt', ciphertext, (err, plaintext) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(plaintext!);
                });
            },
        });
    }

    /**
     * Change access rights for file
     *
     * @param adapter adapter name
     * @param path file name with a full path. It could be like 'vis.0/*'
     * @param options like {mode: 0x644}
     * @param options.mode The new mode for the file
     */
    chmodFile(
        adapter: string | null,
        path: string,
        options?: { mode: number | string },
    ): Promise<ioBroker.ChownFileResult[]> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('chmodFile', adapter, path, options, (err, processed) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(processed!);
                });
            },
        });
    }

    /**
     * Change an owner or/and owner group for file
     *
     * @param adapter adapter name
     * @param filename file name with a full path. it could be like vis.0/*
     * @param options like {owner: "newOwner", ownerGroup: "newGroup"}
     * @param options.owner The new owner for the file
     * @param options.ownerGroup The new owner group for the file
     */
    chownFile(
        adapter: string,
        filename: string,
        options?: { owner?: string; ownerGroup?: string },
    ): Promise<ioBroker.ChownFileResult[]> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('chownFile', adapter, filename, options, (err, processed) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(processed!);
                });
            },
        });
    }

    /**
     * Get the alarm notifications from a host (only for admin connection).
     *
     * @param host The host name.
     * @param category - optional
     */
    getNotifications(host: string, category?: string): Promise<void | { result: FilteredNotificationInformation }> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'getNotifications', { category }, notifications => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    resolve(
                        notifications as {
                            result: FilteredNotificationInformation;
                        },
                    );
                });
            },
        });
    }

    /**
     * Clear the alarm notifications on a host (only for admin connection).
     *
     * @param host The host name.
     * @param category - optional
     */
    clearNotifications(host: string, category: string): Promise<{ result: 'ok' }> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('sendToHost', host, 'clearNotifications', { category }, result => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    resolve(result as { result: 'ok' });
                });
            },
        });
    }

    /**
     * Read if only easy mode is allowed (only for admin connection).
     */
    getIsEasyModeStrict(): Promise<boolean> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getIsEasyModeStrict', (err, isStrict) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(!!isStrict);
                });
            },
        });
    }

    /**
     * Read easy mode configuration (only for admin connection).
     */
    getEasyMode(): Promise<{
        strict: boolean;
        configs: {
            id: string;
            title: ioBroker.StringOrTranslated;
            desc: ioBroker.StringOrTranslated;
            color: string;
            url: string;
            icon: string;
            materialize: boolean;
            jsonConfig: boolean;
            version: string;
        }[];
    }> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getEasyMode', (err, config) => {
                    if (timeout.elapsed) {
                        return;
                    }

                    timeout.clearTimeout();

                    if (err) {
                        reject(new Error(err));
                    } else {
                        resolve(
                            config as {
                                strict: boolean;
                                configs: {
                                    id: string;
                                    title: ioBroker.StringOrTranslated;
                                    desc: ioBroker.StringOrTranslated;
                                    color: string;
                                    url: string;
                                    icon: string;
                                    materialize: boolean;
                                    jsonConfig: boolean;
                                    version: string;
                                }[];
                            },
                        );
                    }
                });
            },
        });
    }

    /**
     * Read adapter ratings
     */
    getRatings(update?: boolean): Promise<{ [adapterName: string]: AdapterRating } & { uuid: string }> {
        return this.request({
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getRatings', !!update, (err, ratings) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(new Error(err));
                    } else {
                        resolve(
                            ratings as { [adapterName: string]: AdapterRating } & { uuid: string },
                        );
                    }
                });
            },
        });
    }

    getCurrentSession(cmdTimeout?: number): Promise<{ expireInSec?: number; error?: string }> {
        const controller = new AbortController();

        return this.request({
            commandTimeout: cmdTimeout || 5000,
            onTimeout: () => {
                controller.abort();
            },
            executor: async (resolve, reject, timeout) => {
                try {
                    const res = await fetch('./session', {
                        signal: controller.signal,
                    });
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    const result: { expireInSec?: number; error?: string } = await res.json();
                    resolve(result);
                } catch (e) {
                    reject(`getCurrentSession: ${e}`);
                }
            },
        });
    }

    /**
     * Read current web, socketio or admin namespace, like admin.0
     */
    getCurrentInstance(): Promise<string> {
        return this.request({
            cacheKey: 'currentInstance',
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getCurrentInstance', (err, namespace) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    } else {
                        resolve(namespace!);
                    }
                });
            },
        });
    }

    /**
     * Get all instances of the given adapter or get all instances.
     *
     * @param adapter The name of the adapter.
     * @param update Force update.
     */
    getAdapterInstances(adapter?: string | boolean, update?: boolean): Promise<ioBroker.InstanceObject[]> {
        let adapterStr: string;
        if (typeof adapter === 'boolean') {
            update = adapter;
            adapterStr = '';
        } else {
            adapterStr = adapter || '';
        }

        return this.request({
            cacheKey: `instances_${adapterStr}`,
            forceUpdate: update,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getAdapterInstances', adapterStr, (err, instances) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(instances!);
                });
            },
        });
    }

    /**
     * Get adapters with the given name or get all adapters.
     *
     * @param adapter The name of the adapter.
     * @param update Force update.
     */
    getAdapters(adapter?: string | boolean, update?: boolean): Promise<ioBroker.AdapterObject[]> {
        let adapterStr: string;
        if (typeof adapter === 'boolean') {
            update = adapter;
            adapterStr = '';
        } else {
            adapterStr = adapter || '';
        }

        return this.request({
            cacheKey: `adapter_${adapterStr}`,
            forceUpdate: update,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getAdapters', adapterStr, (err, adapters) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(adapters!);
                });
            },
        });
    }

    // returns very optimized information for adapters to minimize a connection load
    getCompactAdapters(update?: boolean): Promise<Record<string, CompactAdapterInfo>> {
        return this.request({
            cacheKey: 'compactAdapters',
            forceUpdate: update,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getCompactAdapters', (err, adapters) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(adapters!);
                });
            },
        });
    }

    // reset cached promise, so next time the information will be requested anew
    getAdaptersResetCache(adapter?: string): void {
        adapter = adapter ?? '';
        this.resetCache(`adapter_${adapter}`);
        this.resetCache(`compactAdapters`);
    }

    // returns very optimized information for adapters to minimize a connection load
    getCompactInstances(update?: boolean): Promise<Record<string, CompactInstanceInfo>> {
        return this.request({
            cacheKey: 'compactInstances',
            forceUpdate: update,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getCompactInstances', (err, instances) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(instances!);
                });
            },
        });
    }

    // reset cached promise, so next time the information will be requested anew
    getAdapterInstancesResetCache(adapter?: string): void {
        adapter = adapter ?? '';
        this.resetCache(`instances_${adapter}`);
        this.resetCache(`compactInstances`);
    }

    // returns very optimized information for adapters to minimize a connection load
    // reads only a version of installed adapter
    getCompactInstalled(host: string, update?: boolean, cmdTimeout?: number): Promise<CompactInstalledInfo> {
        host = normalizeHostId(host);

        return this.request({
            cacheKey: `installedCompact_${host}`,
            forceUpdate: update,
            commandTimeout: cmdTimeout,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getCompactInstalled', host, data => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();

                    if (data === ERRORS.PERMISSION_ERROR) {
                        reject('May not read "getCompactInstalled"');
                    } else if (!data) {
                        reject('Cannot read "getCompactInstalled"');
                    } else {
                        resolve(data);
                    }
                });
            },
        });
    }

    // reset cached promise, so next time the information will be requested anew
    getInstalledResetCache(host?: string): void {
        if (!host) {
            this.resetCache(`installedCompact_`, true);
            this.resetCache(`installed_`, true);
        } else {
            this.resetCache(`installedCompact_${host}`);
            this.resetCache(`installed_${host}`);
        }
    }

    /**
     * Get the repository in compact form (only version and icon).
     *
     * @param host The host name.
     * @param update Force update.
     * @param timeoutMs timeout in ms.
     */
    getCompactRepository(host: string, update?: boolean, timeoutMs?: number): Promise<CompactRepository> {
        host = normalizeHostId(host);

        return this.request({
            cacheKey: `repositoryCompact_${host}`,
            forceUpdate: update,
            commandTimeout: timeoutMs,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getCompactRepository', host, data => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();

                    if (data === ERRORS.PERMISSION_ERROR) {
                        reject('May not read "getCompactRepository"');
                    } else if (!data) {
                        reject('Cannot read "getCompactRepository"');
                    } else {
                        resolve(data);
                    }
                });
            },
        });
    }

    // reset cached promise, so next time the information will be requested anew
    getRepositoryResetCache(host: string): void {
        if (!host) {
            this.resetCache(`repositoryCompact_`, true);
            this.resetCache(`repository_`, true);
        } else {
            this.resetCache(`repositoryCompact_${host}`);
            this.resetCache(`repository_${host}`);
        }
    }

    /**
     * Get the list of all hosts in compact form (only _id, common.name, common.icon, common.color, native.hardware.networkInterfaces)
     *
     * @param update Force update.
     */
    getCompactHosts(update?: boolean): Promise<CompactHost[]> {
        return this.request({
            cacheKey: 'hostsCompact',
            forceUpdate: update,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getCompactHosts', (err, compactHostsInfo) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(compactHostsInfo!);
                });
            },
        });
    }

    /**
     * Get `system.repository` without big JSON
     */
    getCompactSystemRepositories(update?: boolean): Promise<CompactSystemRepository> {
        return this.request({
            cacheKey: 'repositoriesCompact',
            forceUpdate: update,
            executor: (resolve, reject, timeout) => {
                this._socket.emit('getCompactSystemRepositories', (err, systemRepositories) => {
                    if (timeout.elapsed) {
                        return;
                    }
                    timeout.clearTimeout();
                    if (err) {
                        reject(err);
                    }
                    resolve(systemRepositories!);
                });
            },
        });
    }
}
