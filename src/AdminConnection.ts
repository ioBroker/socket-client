import { Connection, ERRORS } from "./Connection";
import type { ConnectionProps } from "./ConnectionProps";
import type {
	AdminEmitEvents,
	AdminListenEvents,
	CompactAdapterInfo,
	CompactHost,
	CompactInstalledInfo,
	CompactInstanceInfo,
	CompactRepository,
	Logfile,
} from "./SocketEvents";
import {
	getObjectViewResultToArray,
	normalizeHostId,
	objectIdToHostname,
} from "./tools";

interface Certificate {
	name: string;
	type: "public" | "private" | "chained";
}

function parseCertificate(name: string, cert: string): Certificate | undefined {
	if (!cert) return;

	let type: Certificate["type"];
	// If it is filename, it could be everything
	if (
		cert.length < 700 &&
		(cert.indexOf("/") !== -1 || cert.indexOf("\\") !== -1)
	) {
		if (name.toLowerCase().includes("private")) {
			type = "private";
		} else if (cert.toLowerCase().includes("private")) {
			type = "private";
		} else if (name.toLowerCase().includes("public")) {
			type = "public";
		} else if (cert.toLowerCase().includes("public")) {
			type = "public";
		} else {
			// TODO: is this correct?
			return undefined;
		}
	} else {
		type =
			cert.substring(0, "-----BEGIN RSA PRIVATE KEY".length) ===
				"-----BEGIN RSA PRIVATE KEY" ||
			cert.substring(0, "-----BEGIN PRIVATE KEY".length) ===
				"-----BEGIN PRIVATE KEY"
				? "private"
				: "public";

		if (type === "public") {
			const m = cert.split("-----END CERTIFICATE-----");
			if (
				m.filter((t) => t.replace(/\r\n|\r|\n/, "").trim()).length > 1
			) {
				type = "chained";
			}
		}
	}
	return { name, type };
}
export class AdminConnection extends Connection<
	AdminListenEvents,
	AdminEmitEvents
> {
	constructor(props: ConnectionProps) {
		super(props);
	}

	/**
	 * Get the stored certificates.
	 * @param update Force update.
	 */
	getCertificates(update?: boolean): Promise<Certificate[]> {
		return this.request({
			cacheKey: "cert",
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: async (resolve) => {
				const obj = await this.getObject("system.certificates");
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
	 * @param host
	 * @param linesNumber
	 */
	getLogs(host: string, linesNumber: number = 200): Promise<string[]> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve) => {
				this._socket.emit(
					"sendToHost",
					host,
					"getLogs",
					linesNumber || 200,
					(lines: any) => {
						resolve(lines);
					},
				);
			},
		});
	}

	/**
	 * Get the log files (only for admin connection).
	 */
	getLogsFiles(host: string): Promise<Logfile[]> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit("readLogs", host, (err, files) => {
					if (err) reject(err);
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
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit(
					"sendToHost",
					host,
					"delLogs",
					null,
					(err) => {
						if (err) reject(err);
						resolve();
					},
				);
			},
		});
	}

	/**
	 * Delete a file of an adapter.
	 * @param adapter The adapter name.
	 * @param fileName The file name.
	 */
	deleteFile(adapter: string, fileName: string): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit("deleteFile", adapter, fileName, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Delete a folder of an adapter.
	 * @param adapter The adapter name.
	 * @param folderName The folder name.
	 */
	deleteFolder(adapter: string, folderName: string): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit(
					"deleteFolder",
					adapter,
					folderName,
					(err) => {
						if (err) reject(err);
						resolve();
					},
				);
			},
		});
	}

	/**
	 * Get the list of all hosts.
	 * @param update Force update.
	 */
	getHosts(update?: boolean): Promise<ioBroker.HostObject[]> {
		return this.request({
			cacheKey: "hosts",
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getObjectView",
					"system",
					"host",
					{ startkey: "system.host.", endkey: "system.host.\u9999" },
					(err, doc) => {
						if (err) {
							reject(err);
						} else {
							resolve(
								getObjectViewResultToArray<ioBroker.HostObject>(
									doc,
								),
							);
						}
					},
				);
			},
		});
	}

	/**
	 * Get the list of all users.
	 * @param update Force update.
	 */
	getUsers(update?: boolean): Promise<ioBroker.UserObject[]> {
		return this.request({
			cacheKey: "users",
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getObjectView",
					"system",
					"user",
					{ startkey: "system.user.", endkey: "system.user.\u9999" },
					(err, doc) => {
						if (err) {
							reject(err);
						} else {
							resolve(
								getObjectViewResultToArray<ioBroker.UserObject>(
									doc,
								),
							);
						}
					},
				);
			},
		});
	}

	/**
	 * Get the list of all groups.
	 * @param update Force update.
	 */
	getGroups(update?: boolean): Promise<ioBroker.GroupObject[]> {
		return this.request({
			cacheKey: "groups",
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getObjectView",
					"system",
					"group",
					{
						startkey: "system.group.",
						endkey: "system.group.\u9999",
					},
					(err, doc) => {
						if (err) {
							reject(err);
						} else {
							resolve(
								getObjectViewResultToArray<ioBroker.GroupObject>(
									doc,
								),
							);
						}
					},
				);
			},
		});
	}

	/**
	 * Called internally.
	 * @private
	 * @param objs
	 * @param cb
	 */
	private _renameGroups(objs: any[], cb: (err?: any) => void) {
		if (!objs || !objs.length) {
			cb?.();
		} else {
			const obj = objs.pop();
			this.delObject(obj._id)
				.then(() => {
					obj._id = obj.newId;
					delete obj.newId;
					return this.setObject(obj._id, obj);
				})
				.then(() => setTimeout(() => this._renameGroups(objs, cb), 0))
				.catch((err) => cb && cb(err));
		}
	}

	/**
	 * Rename a group.
	 * @param id The id.
	 * @param newId The new id.
	 * @param newName The new name.
	 */
	renameGroup(
		id: string,
		newId: string,
		newName: ioBroker.StringOrTranslated,
	): Promise<void> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		return this.getGroups(true).then((groups) => {
			if (groups.length) {
				// find all elements
				const groupsToRename = groups.filter((group) =>
					group._id.startsWith(`${id}.`),
				);

				groupsToRename.forEach(
					(group) =>
						(group.newId = newId + group._id.substring(id.length)),
				);

				return new Promise<void>((resolve, reject) =>
					this._renameGroups(groupsToRename, (err) =>
						err ? reject(err) : resolve(),
					),
				).then(() => {
					const obj = groups.find((group) => group._id === id);

					if (obj) {
						obj._id = newId;
						if (newName !== undefined) {
							obj.common = obj.common || {};
							obj.common.name = newName;
						}

						return this.setObject(obj._id, obj);
					}

					return;
				});
			}
			return;
		});
	}

	/**
	 * Get the host information.
	 * @param host
	 * @param update Force update.
	 * @param timeoutMs optional read timeout.
	 */
	getHostInfo(
		host: string,
		update?: boolean,
		timeoutMs?: number,
	): Promise<any> {
		host = normalizeHostId(host);
		return this.request({
			cacheKey: `hostInfo_${host}`,
			forceUpdate: update,
			commandTimeout: timeoutMs,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"getHostInfo",
					null,
					(data) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						if (data === ERRORS.PERMISSION_ERROR) {
							reject('May not read "getHostInfo"');
						} else if (!data) {
							reject('Cannot read "getHostInfo"');
						} else {
							resolve(data);
						}
					},
				);
			},
		});
	}

	/**
	 * Get the host information (short version).
	 * @param host
	 * @param update Force update.
	 * @param timeoutMs optional read timeout.
	 */
	getHostInfoShort(
		host: string,
		update?: boolean,
		timeoutMs?: number,
	): Promise<any> {
		host = normalizeHostId(host);
		return this.request({
			cacheKey: `hostInfoShort_${host}`,
			forceUpdate: update,
			commandTimeout: timeoutMs,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"getHostInfoShort",
					null,
					(data) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						if (data === ERRORS.PERMISSION_ERROR) {
							reject('May not read "getHostInfoShort"');
						} else if (!data) {
							reject('Cannot read "getHostInfoShort"');
						} else {
							resolve(data);
						}
					},
				);
			},
		});
	}

	/**
	 * Get the repository.
	 * @param host
	 * @param args
	 * @param update Force update.
	 * @param timeoutMs timeout in ms.
	 */
	getRepository(
		host: string,
		args: any,
		update?: boolean,
		timeoutMs?: number,
	): Promise<any> {
		return this.request({
			cacheKey: "repo",
			forceUpdate: update,
			commandTimeout: timeoutMs,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"getRepository",
					args,
					(data) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						if (data === ERRORS.PERMISSION_ERROR) {
							reject('May not read "getRepository"');
						} else if (!data) {
							reject('Cannot read "getRepository"');
						} else {
							resolve(data);
						}
					},
				);
			},
		});
	}

	/**
	 * Get the installed.
	 * @param host
	 * @param update Force update.
	 * @param cmdTimeout timeout in ms
	 */
	getInstalled(
		host: string,
		update?: boolean,
		cmdTimeout?: number,
	): Promise<any> {
		host = normalizeHostId(host);

		return this.request({
			cacheKey: "repo",
			forceUpdate: update,
			commandTimeout: cmdTimeout,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"getInstalled",
					null,
					(data) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						if (data === ERRORS.PERMISSION_ERROR) {
							reject('May not read "getInstalled"');
						} else if (!data) {
							reject('Cannot read "getInstalled"');
						} else {
							resolve(data);
						}
					},
				);
			},
		});
	}

	/**
	 * Execute a command on a host.
	 * @param host The host name.
	 * @param cmd The command.
	 * @param cmdId The command ID.
	 * @param cmdTimeout Timeout of command in ms
	 */
	cmdExec(
		host: string,
		cmd: string,
		cmdId: string,
		cmdTimeout?: number,
	): Promise<void> {
		return this.request({
			commandTimeout: cmdTimeout,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				host = normalizeHostId(host);

				this._socket.emit("cmdExec", host, cmdId, cmd, (err) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();

					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Read the base settings of a given host.
	 * @param host
	 */
	readBaseSettings(host: string): Promise<any> {
		// Make sure we deal with a hostname, not an object ID
		host = objectIdToHostname(host);

		return this.request({
			requireAdmin: true,
			requireFeatures: ["CONTROLLER_READWRITE_BASE_SETTINGS"],
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"readBaseSettings",
					null,
					(data) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();

						if (data === ERRORS.PERMISSION_ERROR) {
							reject('May not read "BaseSettings"');
						} else if (!data) {
							reject('Cannot read "BaseSettings"');
						} else {
							resolve(data);
						}
					},
				);
			},
		});
	}

	/**
	 * Write the base settings of a given host.
	 * @param host
	 * @param config
	 */
	writeBaseSettings(host: string, config: any): Promise<any> {
		// Make sure we deal with a hostname, not an object ID
		host = objectIdToHostname(host);

		return this.request({
			requireAdmin: true,
			requireFeatures: ["CONTROLLER_READWRITE_BASE_SETTINGS"],
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"writeBaseSettings",
					config,
					(data) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();

						if (data === ERRORS.PERMISSION_ERROR) {
							reject('May not write "BaseSettings"');
						} else if (!data) {
							reject('Cannot write "BaseSettings"');
						} else {
							resolve(data);
						}
					},
				);
			},
		});
	}

	/**
	 * Send command to restart the iobroker on host
	 * @param host
	 */
	restartController(host: string): Promise<true> {
		// Make sure we deal with a hostname, not an object ID
		host = objectIdToHostname(host);

		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"restartController",
					null,
					(error) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						if (error) reject(error);
						resolve(true);
					},
				);
			},
		});
	}

	/**
	 * Read statistics information from host
	 * @param host
	 * @param typeOfDiag one of none, normal, no-city, extended
	 */
	getDiagData(host: string, typeOfDiag: string): Promise<any> {
		// Make sure we deal with a hostname, not an object ID
		host = objectIdToHostname(host);

		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"getDiagData",
					typeOfDiag,
					(result) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						resolve(result);
					},
				);
			},
		});
	}

	/**
	 * Change the password of the given user.
	 * @param user
	 * @param password
	 */
	changePassword(user: string, password: string): Promise<void> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("changePassword", user, password, (err) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Get the IP addresses of the given host.
	 * @param host
	 * @param update Force update.
	 */
	getIpAddresses(host: string, update?: boolean): Promise<string[]> {
		host = normalizeHostId(host);
		return this.request({
			cacheKey: `IPs_${host}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: async (resolve) => {
				const obj = await this.getObject(host);
				resolve(obj?.common.address ?? []);
			},
		});
	}

	/**
	 * Get the IP addresses with interface names of the given host or find host by IP.
	 * @param ipOrHostName
	 * @param update Force update.
	 */
	getHostByIp(ipOrHostName: string, update?: boolean): Promise<any> {
		// Make sure we deal with a hostname, not an object ID
		ipOrHostName = objectIdToHostname(ipOrHostName);

		return this.request({
			cacheKey: `rIPs_${ipOrHostName}`,
			forceUpdate: update,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getHostByIp", ipOrHostName, (ip, host) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();

					const IPs4 = [
						{
							name: "[IPv4] 0.0.0.0 - Listen on all IPs",
							address: "0.0.0.0",
							family: "ipv4",
						},
					];
					const IPs6 = [
						{
							name: "[IPv6] :: - Listen on all IPs",
							address: "::",
							family: "ipv6",
						},
					];
					if (host.native?.hardware?.networkInterfaces) {
						for (const eth in host.native.hardware
							.networkInterfaces) {
							if (
								!host.native.hardware.networkInterfaces.hasOwnProperty(
									eth,
								)
							) {
								continue;
							}
							for (
								let num = 0;
								num <
								host.native.hardware.networkInterfaces[eth]
									.length;
								num++
							) {
								if (
									host.native.hardware.networkInterfaces[eth][
										num
									].family !== "IPv6"
								) {
									IPs4.push({
										name: `[${host.native.hardware.networkInterfaces[eth][num].family}] ${host.native.hardware.networkInterfaces[eth][num].address} - ${eth}`,
										address:
											host.native.hardware
												.networkInterfaces[eth][num]
												.address,
										family: "ipv4",
									});
								} else {
									IPs6.push({
										name: `[${host.native.hardware.networkInterfaces[eth][num].family}] ${host.native.hardware.networkInterfaces[eth][num].address} - ${eth}`,
										address:
											host.native.hardware
												.networkInterfaces[eth][num]
												.address,
										family: "ipv6",
									});
								}
							}
						}
					}
					for (let i = 0; i < IPs6.length; i++) {
						IPs4.push(IPs6[i]);
					}
					resolve(IPs4);
				});
			},
		});
	}

	/**
	 * Encrypt a text
	 * @param plaintext
	 */
	encrypt(plaintext: string): Promise<string> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("encrypt", plaintext, (err, ciphertext) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(ciphertext!);
				});
			},
		});
	}

	/**
	 * Decrypt a text
	 * @param ciphertext
	 */
	decrypt(ciphertext: string): Promise<string> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("decrypt", ciphertext, (err, plaintext) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(plaintext!);
				});
			},
		});
	}

	/**
	 * Change access rights for file
	 * @param adapter adapter name
	 * @param filename file name with full path. it could be like vis.0/*
	 * @param options like {mode: 0x644}
	 */
	chmodFile(
		adapter: string | null,
		path: string,
		options?: { mode: number | string },
	): Promise<ioBroker.ChownFileResult[]> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"chmodFile",
					adapter,
					path,
					options,
					(err, processed) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						if (err) reject(err);
						resolve(processed!);
					},
				);
			},
		});
	}

	/**
	 * Change owner or/and owner group for file
	 * @param adapter adapter name
	 * @param filename file name with full path. it could be like vis.0/*
	 * @param options like {owner: 'newOwner', ownerGroup: 'newGroup'}
	 */
	chownFile(
		adapter: string,
		filename: string,
		options?: { owner: string; ownerGroup: string },
	): Promise<ioBroker.ChownFileResult[]> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"chownFile",
					adapter,
					filename,
					options,
					(err, processed) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						if (err) reject(err);
						resolve(processed!);
					},
				);
			},
		});
	}

	/**
	 * Get the alarm notifications from a host (only for admin connection).
	 * @param host
	 * @param category - optional
	 */
	getNotifications(host: string, category: string): Promise<any> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"getNotifications",
					{ category },
					(notifications) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						resolve(notifications);
					},
				);
			},
		});
	}

	/**
	 * Clear the alarm notifications on a host (only for admin connection).
	 * @param host
	 * @param category - optional
	 */
	clearNotifications(host: string, category: string): Promise<any> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"sendToHost",
					host,
					"clearNotifications",
					{ category },
					(notifications) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						resolve(notifications);
					},
				);
			},
		});
	}

	/**
	 * Read if only easy mode is allowed  (only for admin connection).
	 */
	getIsEasyModeStrict(): Promise<boolean> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getIsEasyModeStrict", (err, isStrict) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(!!isStrict);
				});
			},
		});
	}

	/**
	 * Read easy mode configuration (only for admin connection).
	 */
	getEasyMode(): Promise<any> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getEasyMode", (err, config) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(config);
				});
			},
		});
	}

	/**
	 * Read adapter ratings
	 */
	getRatings(update?: boolean): Promise<any> {
		return this.request({
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getRatings", !!update, (err, ratings) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(ratings);
				});
			},
		});
	}

	getCurrentSession(cmdTimeout) {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		return new Promise((resolve, reject) => {
			const controller = new AbortController();

			let timeout = setTimeout(() => {
				if (timeout) {
					timeout = null;
					controller.abort();
					reject("getCurrentSession timeout");
				}
			}, cmdTimeout || 5000);

			return fetch("./session", { signal: controller.signal })
				.then((res) => res.json())
				.then((json) => {
					if (timeout) {
						clearTimeout(timeout);
						timeout = null;
						resolve(json);
					}
				})
				.catch((e) => {
					reject(`getCurrentSession: ${e}`);
				});
		});
	}

	/**
	 * Read current web, socketio or admin namespace, like admin.0
	 */
	getCurrentInstance(): Promise<string> {
		return this.request({
			cacheKey: "currentInstance",
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getCurrentInstance", (err, namespace) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(namespace!);
				});
			},
		});
	}

	/**
	 * Get all adapter instances.
	 * @param update Force update.
	 */
	/**
	 * Get all instances of the given adapter.
	 * @param adapter The name of the adapter.
	 * @param update Force update.
	 */
	getAdapterInstances(
		adapter?: string,
		update?: boolean,
	): Promise<ioBroker.InstanceObject[]> {
		if (typeof adapter === "boolean") {
			update = adapter;
			adapter = "";
		}
		adapter = adapter ?? "";

		return this.request({
			cacheKey: `instances_${adapter}`,
			forceUpdate: update,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit(
					"getAdapterInstances",
					adapter,
					(err, instances) => {
						if (timeout.elapsed) return;
						timeout.clearTimeout();
						if (err) reject(err);
						resolve(instances!);
					},
				);
			},
		});
	}

	/**
	 * Get all adapters.
	 * @param update Force update.
	 */
	/**
	 * Get adapters with the given name.
	 * @param adapter The name of the adapter.
	 * @param update Force update.
	 */
	getAdapters(
		adapter?: string,
		update?: boolean,
	): Promise<ioBroker.AdapterObject[]> {
		if (typeof adapter === "boolean") {
			update = adapter;
			adapter = "";
		}
		adapter = adapter ?? "";

		return this.request({
			cacheKey: `adapter_${adapter}`,
			forceUpdate: update,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getAdapters", adapter, (err, adapters) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(adapters!);
				});
			},
		});
	}

	// returns very optimized information for adapters to minimize connection load
	getCompactAdapters(
		update?: boolean,
	): Promise<Record<string, CompactAdapterInfo>> {
		return this.request({
			cacheKey: "compactAdapters",
			forceUpdate: update,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getCompactAdapters", (err, adapters) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(adapters!);
				});
			},
		});
	}

	// returns very optimized information for adapters to minimize connection load
	getCompactInstances(
		update?: boolean,
	): Promise<Record<string, CompactInstanceInfo>> {
		return this.request({
			cacheKey: "compactInstances",
			forceUpdate: update,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getCompactInstances", (err, instances) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(instances!);
				});
			},
		});
	}

	// returns very optimized information for adapters to minimize connection load
	// reads only version of installed adapter
	getCompactInstalled(
		host: string,
		update?: boolean,
		cmdTimeout?: number,
	): Promise<CompactInstalledInfo> {
		host = normalizeHostId(host);

		return this.request({
			cacheKey: `installedCompact_${host}`,
			forceUpdate: update,
			commandTimeout: cmdTimeout,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getCompactInstalled", host, (data) => {
					if (timeout.elapsed) return;
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

	/**
	 * Get the repository in compact form (only version and icon).
	 * @param host
	 * @param update Force update.
	 * @param timeoutMs timeout in ms.
	 */
	getCompactRepository(
		host: string,
		update?: boolean,
		timeoutMs?: number,
	): Promise<CompactRepository> {
		host = normalizeHostId(host);

		return this.request({
			cacheKey: `repositoryCompact_${host}`,
			forceUpdate: update,
			commandTimeout: timeoutMs,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getCompactRepository", host, (data) => {
					if (timeout.elapsed) return;
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

	/**
	 * Get the list of all hosts in compact form (only _id, common.name, common.icon, common.color, native.hardware.networkInterfaces)
	 * @param update Force update.
	 */
	getCompactHosts(update?: boolean): Promise<CompactHost[]> {
		return this.request({
			cacheKey: "hostsCompact",
			forceUpdate: update,
			requireAdmin: true,
			executor: (resolve, reject, timeout) => {
				this._socket.emit("getCompactHosts", (err, systemConfig) => {
					if (timeout.elapsed) return;
					timeout.clearTimeout();
					if (err) reject(err);
					resolve(systemConfig!);
				});
			},
		});
	}
}
