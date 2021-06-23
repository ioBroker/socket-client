import { Connection, NOT_CONNECTED, PERMISSION_ERROR } from "./Connection";
import type { ConnectionProps } from "./ConnectionProps";

export class AdminConnection extends Connection {
	constructor(props: ConnectionProps) {
		super(props);
	}

	/**
	 * Get the stored certificates.
	 * @param update Force update.
	 */
	getCertificates(
		update: boolean,
	): Promise<{ name: string; type: "public" | "private" | "chained" }[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		if (this._promises.cert && !update) {
			return this._promises.cert;
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises.cert = (<any>this.getObject("system.certificates")).then(
			(res) => {
				const certs = [];
				if (res && res.native && res.native.certificates) {
					Object.keys(res.native.certificates).forEach((c) => {
						const cert = res.native.certificates[c];
						if (!cert) {
							return;
						}
						const _cert = {
							name: c,
							type: "",
						};
						// If it is filename, it could be everything
						if (
							cert.length < 700 &&
							(cert.indexOf("/") !== -1 ||
								cert.indexOf("\\") !== -1)
						) {
							if (c.toLowerCase().includes("private")) {
								_cert.type = "private";
							} else if (cert.toLowerCase().includes("private")) {
								_cert.type = "private";
							} else if (c.toLowerCase().includes("public")) {
								_cert.type = "public";
							} else if (cert.toLowerCase().includes("public")) {
								_cert.type = "public";
							}
							certs.push(_cert);
						} else {
							_cert.type =
								cert.substring(
									0,
									"-----BEGIN RSA PRIVATE KEY".length,
								) === "-----BEGIN RSA PRIVATE KEY" ||
								cert.substring(
									0,
									"-----BEGIN PRIVATE KEY".length,
								) === "-----BEGIN PRIVATE KEY"
									? "private"
									: "public";

							if (_cert.type === "public") {
								const m = cert.split(
									"-----END CERTIFICATE-----",
								);
								if (
									m.filter((t) =>
										t.replace(/\r\n|\r|\n/, "").trim(),
									).length > 1
								) {
									_cert.type = "chained";
								}
							}

							certs.push(_cert);
						}
					});
				}
				return certs;
			},
		);

		return this._promises.cert;
	}

	/**
	 * Get the logs from a host (only for admin connection).
	 * @param host
	 * @param linesNumber
	 */
	getLogs(host: string, linesNumber: number): Promise<string[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		return new Promise((resolve) =>
			this._socket.emit(
				"sendToHost",
				host,
				"getLogs",
				linesNumber || 200,
				(lines) => resolve(lines),
			),
		);
	}

	/**
	 * Get the log files (only for admin connection).
	 */
	getLogsFiles(host): Promise<string[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit("readLogs", host, (err, files) =>
				err ? reject(err) : resolve(files),
			),
		);
	}

	/**
	 * Delete the logs from a host (only for admin connection).
	 * @param host
	 */
	delLogs(host: string): Promise<void> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise<void>((resolve, reject) =>
			this._socket.emit("sendToHost", host, "delLogs", null, (error) =>
				error ? reject(error) : resolve(),
			),
		);
	}

	/**
	 * Delete a file of an adapter.
	 * @param adapter The adapter name.
	 * @param fileName The file name.
	 */
	deleteFile(adapter: string, fileName: string): Promise<void> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise<void>((resolve, reject) =>
			this._socket.emit("deleteFile", adapter, fileName, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	}

	/**
	 * Delete a folder of an adapter.
	 * @param adapter The adapter name.
	 * @param folderName The folder name.
	 */
	deleteFolder(adapter: string, folderName: string): Promise<void> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise<void>((resolve, reject) =>
			this._socket.emit("deleteFolder", adapter, folderName, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	}

	/**
	 * Get the list of all hosts.
	 * @param update Force update.
	 */
	getHosts(update: boolean): Promise<ioBroker.Object[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!update && this._promises.hosts) {
			return this._promises.hosts;
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises.hosts = new Promise((resolve, reject) =>
			this._socket.emit(
				"getObjectView",
				"system",
				"host",
				{ startkey: "system.host.", endkey: "system.host.\u9999" },
				(err, doc) => {
					if (err) {
						reject(err);
					} else {
						resolve(doc.rows.map((item) => item.value));
					}
				},
			),
		);

		return this._promises.hosts;
	}

	/**
	 * Get the list of all users.
	 * @param update Force update.
	 */
	getUsers(update: boolean): Promise<ioBroker.Object[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!update && this._promises.users) {
			return this._promises.users;
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises.users = new Promise((resolve, reject) =>
			this._socket.emit(
				"getObjectView",
				"system",
				"user",
				{ startkey: "system.user.", endkey: "system.user.\u9999" },
				(err, doc) => {
					if (err) {
						reject(err);
					} else {
						resolve(doc.rows.map((item) => item.value));
					}
				},
			),
		);

		return this._promises.users;
	}

	/**
	 * Get the list of all groups.
	 * @param update Force update.
	 */
	getGroups(update: boolean): Promise<ioBroker.Object[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!update && this._promises.groups) {
			return this._promises.groups;
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises.groups = new Promise((resolve, reject) =>
			this._socket.emit(
				"getObjectView",
				"system",
				"group",
				{ startkey: "system.group.", endkey: "system.group.\u9999" },
				(err, doc) => {
					if (err) {
						reject(err);
					} else {
						resolve(doc.rows.map((item) => item.value));
					}
				},
			),
		);

		return this._promises.groups;
	}

	/**
	 * Called internally.
	 * @private
	 * @param objs
	 * @param cb
	 */
	private _renameGroups(objs: any[], cb: (err?: any) => void) {
		if (!objs || !objs.length) {
			cb && cb();
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
		newName: string | { [lang in ioBroker.Languages]?: string },
	) {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		return this.getGroups(true).then((groups) => {
			if (groups.length) {
				// find all elements
				const groupsToRename = groups.filter((group) =>
					group._id.startsWith(id + "."),
				);

				groupsToRename.forEach(
					(group) =>
						((<any>group).newId =
							newId + group._id.substring(id.length)),
				);

				return new Promise<void>((resolve, reject) =>
					this._renameGroups(<any>groupsToRename, (err) =>
						err ? reject(err) : resolve(),
					),
				).then(() => {
					const obj = groups.find((group) => group._id === id);

					if (obj) {
						obj._id = newId;
						if (newName !== undefined) {
							(<any>obj).common = obj.common || {};
							obj.common.name = newName;
						}

						return this.setObject(obj._id, obj);
					}

					return undefined;
				});
			}
			return undefined;
		});
	}

	/**
	 * Get the host information.
	 * @param host
	 * @param update Force update.
	 * @param timeoutMs optional read timeout.
	 */
	getHostInfo(host: string, update: boolean, timeoutMs: number): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!host.startsWith("system.host.")) {
			host += "system.host." + host;
		}

		if (!update && this._promises["hostInfo" + host]) {
			return this._promises["hostInfo" + host];
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises["hostInfo" + host] = new Promise((resolve, reject) => {
			let timeout = setTimeout(() => {
				if (timeout) {
					timeout = null;
					reject("getHostInfo timeout");
				}
			}, timeoutMs || this.props.cmdTimeout);

			this._socket.emit(
				"sendToHost",
				host,
				"getHostInfo",
				null,
				(data) => {
					if (timeout) {
						clearTimeout(timeout);
						timeout = null;
						if (data === PERMISSION_ERROR) {
							reject('May not read "getHostInfo"');
						} else if (!data) {
							reject('Cannot read "getHostInfo"');
						} else {
							resolve(data);
						}
					}
				},
			);
		});

		return this._promises["hostInfo" + host];
	}

	/**
	 * Get the host information (short version).
	 * @param host
	 * @param update Force update.
	 * @param timeoutMs optional read timeout.
	 */
	getHostInfoShort(host: string, update: boolean, timeoutMs: number): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!host.startsWith("system.host.")) {
			host += "system.host." + host;
		}

		if (!update && this._promises["hostInfoShort" + host]) {
			return this._promises["hostInfoShort" + host];
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises["hostInfoShort" + host] = new Promise(
			(resolve, reject) => {
				let timeout = setTimeout(() => {
					if (timeout) {
						timeout = null;
						reject("hostInfoShort timeout");
					}
				}, timeoutMs || this.props.cmdTimeout);

				this._socket.emit(
					"sendToHost",
					host,
					"getHostInfoShort",
					null,
					(data) => {
						if (timeout) {
							clearTimeout(timeout);
							timeout = null;
							if (data === PERMISSION_ERROR) {
								reject('May not read "getHostInfoShort"');
							} else if (!data) {
								reject('Cannot read "getHostInfoShort"');
							} else {
								resolve(data);
							}
						}
					},
				);
			},
		);

		return this._promises["hostInfoShort" + host];
	}

	/**
	 * Get the repository.
	 * @param host
	 * @param args
	 * @param update Force update.
	 * @param timeoutMs timeout in ms.
	 */
	getRepository(host: string, args: any, update: boolean, timeoutMs: number): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!update && this._promises.repo) {
			return this._promises.repo;
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		if (!host.startsWith("system.host.")) {
			host += "system.host." + host;
		}

		this._promises.repo = new Promise((resolve, reject) => {
			let timeout = setTimeout(() => {
				if (timeout) {
					timeout = null;
					reject("getRepository timeout");
				}
			}, timeoutMs || this.props.cmdTimeout);

			this._socket.emit(
				"sendToHost",
				host,
				"getRepository",
				args,
				(data) => {
					if (timeout) {
						clearTimeout(timeout);
						timeout = null;
						if (data === PERMISSION_ERROR) {
							reject('May not read "getRepository"');
						} else if (!data) {
							reject('Cannot read "getRepository"');
						} else {
							resolve(data);
						}
					}
				},
			);
		});

		return this._promises.repo;
	}

	/**
	 * Get the installed.
	 * @param host
	 * @param update Force update.
	 * @param cmdTimeout timeout in ms (optional)
	 */
	getInstalled(host: string, update: boolean, cmdTimeout: number): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		this._promises.installed = this._promises.installed || {};

		if (!update && this._promises.installed[host]) {
			return this._promises.installed[host];
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		if (!host.startsWith("system.host.")) {
			host += "system.host." + host;
		}

		this._promises.installed[host] = new Promise((resolve, reject) => {
			let timeout = setTimeout(() => {
				if (timeout) {
					timeout = null;
					reject("getInstalled timeout");
				}
			}, cmdTimeout || this.props.cmdTimeout);

			this._socket.emit(
				"sendToHost",
				host,
				"getInstalled",
				null,
				(data) => {
					if (timeout) {
						clearTimeout(timeout);
						timeout = null;
						if (data === PERMISSION_ERROR) {
							reject('May not read "getInstalled"');
						} else if (!data) {
							reject('Cannot read "getInstalled"');
						} else {
							resolve(data);
						}
					}
				},
			);
		});

		return this._promises.installed[host];
	}

	/**
	 * Execute a command on a host.
	 * @param host The host name.
	 * @param cmd The command.
	 * @param cmdId The command ID.
	 * @param cmdTimeout Timeout of command in ms
	 */
	cmdExec(host: string, cmd: string, cmdId: string, cmdTimeout: number): Promise<void> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		if (!host.startsWith(host)) {
			host += "system.host." + host;
		}

		return new Promise<void>((resolve, reject) => {
			let timeout =
				cmdTimeout &&
				setTimeout(() => {
					if (timeout) {
						timeout = null;
						reject("cmdExec timeout");
					}
				}, cmdTimeout);

			this._socket.emit("cmdExec", host, cmdId, cmd, null, (err) => {
				if (!cmdTimeout || timeout) {
					timeout && clearTimeout(timeout);
					timeout = null;
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				}
			});
		});
	}

	/**
	 * Read the base settings of a given host.
	 * @param host
	 */
	readBaseSettings(host: string): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		return this.checkFeatureSupported(
			"CONTROLLER_READWRITE_BASE_SETTINGS",
		).then((result) => {
			if (result) {
				if (!this.connected) {
					return Promise.reject(NOT_CONNECTED);
				}
				return new Promise((resolve, reject) => {
					let timeout = setTimeout(() => {
						if (timeout) {
							timeout = null;
							reject("readBaseSettings timeout");
						}
					}, this.props.cmdTimeout);

					if (host.startsWith("system.host.")) {
						host = host.replace(/^system\.host\./, "");
					}

					this._socket.emit(
						"sendToHost",
						host,
						"readBaseSettings",
						null,
						(data) => {
							if (timeout) {
								clearTimeout(timeout);
								timeout = null;

								if (data === PERMISSION_ERROR) {
									reject('May not read "BaseSettings"');
								} else if (!data) {
									reject('Cannot read "BaseSettings"');
								} else {
									resolve(data);
								}
							}
						},
					);
				});
			} else {
				return Promise.reject("Not supported");
			}
		});
	}

	/**
	 * Write the base settings of a given host.
	 * @param host
	 * @param config
	 */
	writeBaseSettings(host: string, config: any): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		return this.checkFeatureSupported(
			"CONTROLLER_READWRITE_BASE_SETTINGS",
		).then((result) => {
			if (result) {
				if (!this.connected) {
					return Promise.reject(NOT_CONNECTED);
				}
				return new Promise((resolve, reject) => {
					let timeout = setTimeout(() => {
						if (timeout) {
							timeout = null;
							reject("writeBaseSettings timeout");
						}
					}, this.props.cmdTimeout);

					this._socket.emit(
						"sendToHost",
						host,
						"writeBaseSettings",
						config,
						(data) => {
							if (timeout) {
								clearTimeout(timeout);
								timeout = null;

								if (data === PERMISSION_ERROR) {
									reject('May not write "BaseSettings"');
								} else if (!data) {
									reject('Cannot write "BaseSettings"');
								} else {
									resolve(data);
								}
							}
						},
					);
				});
			} else {
				return Promise.reject("Not supported");
			}
		});
	}

	/**
	 * Send command to restart the iobroker on host
	 * @param host
	 */
	restartController(host: string): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		return new Promise((resolve, reject) => {
			this._socket.emit(
				"sendToHost",
				host,
				"restartController",
				null,
				(error) => {
					error ? reject(error) : resolve(true);
				},
			);
		});
	}

	/**
	 * Read statistics information from host
	 * @param host
	 * @param typeOfDiag one of none, normal, no-city, extended
	 */
	getDiagData(host: string, typeOfDiag: string): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		return new Promise((resolve) => {
			this._socket.emit(
				"sendToHost",
				host,
				"getDiagData",
				typeOfDiag,
				(result) => resolve(result),
			);
		});
	}

	/**
	 * Change the password of the given user.
	 * @param user
	 * @param password
	 */
	changePassword(user: string, password: string): Promise<void> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		return new Promise<void>((resolve, reject) =>
			this._socket.emit("changePassword", user, password, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	}

	/**
	 * Get the IP addresses of the given host.
	 * @param host
	 * @param update Force update.
	 */
	getIpAddresses(host: string, update: boolean): Promise<string[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!host.startsWith("system.host.")) {
			host = "system.host." + host;
		}

		if (!update && this._promises["IPs_" + host]) {
			return this._promises["IPs_" + host];
		}
		this._promises["IPs_" + host] = (<any>this.getObject(host)).then(
			(obj) => (obj && obj.common ? obj.common.address || [] : []),
		);

		return this._promises["IPs_" + host];
	}

	/**
	 * Get the IP addresses with interface names of the given host or find host by IP.
	 * @param ipOrHostName
	 * @param update Force update.
	 */
	getHostByIp(ipOrHostName: string, update: boolean): Promise<any[<name, address, family>() => ]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (ipOrHostName.startsWith("system.host.")) {
			ipOrHostName = ipOrHostName.replace(/^system\.host\./, "");
		}

		if (!update && this._promises["rIPs_" + ipOrHostName]) {
			return this._promises["rIPs_" + ipOrHostName];
		}
		this._promises["rIPs_" + ipOrHostName] = new Promise((resolve) =>
			this._socket.emit("getHostByIp", ipOrHostName, (ip, host) => {
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
					for (const eth in host.native.hardware.networkInterfaces) {
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
							host.native.hardware.networkInterfaces[eth].length;
							num++
						) {
							if (
								host.native.hardware.networkInterfaces[eth][num]
									.family !== "IPv6"
							) {
								IPs4.push({
									name: `[${host.native.hardware.networkInterfaces[eth][num].family}] ${host.native.hardware.networkInterfaces[eth][num].address} - ${eth}`,
									address:
										host.native.hardware.networkInterfaces[
											eth
										][num].address,
									family: "ipv4",
								});
							} else {
								IPs6.push({
									name: `[${host.native.hardware.networkInterfaces[eth][num].family}] ${host.native.hardware.networkInterfaces[eth][num].address} - ${eth}`,
									address:
										host.native.hardware.networkInterfaces[
											eth
										][num].address,
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
			}),
		);

		return this._promises["rIPs_" + ipOrHostName];
	}

	/**
	 * Encrypt a text
	 * @param text
	 */
	encrypt(text: string): Promise<string> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		return new Promise((resolve, reject) =>
			this._socket.emit("encrypt", text, (err, text) =>
				err ? reject(err) : resolve(text),
			),
		);
	}

	/**
	 * Decrypt a text
	 * @param encryptedText
	 */
	decrypt(encryptedText: string): Promise<string> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		return new Promise((resolve, reject) =>
			this._socket.emit("decrypt", encryptedText, (err, text) =>
				err ? reject(err) : resolve(text),
			),
		);
	}

	/**
	 * Change access rights for file
	 * @param adapter adapter name
	 * @param filename file name with full path. it could be like vis.0/*
	 * @param options like {mode: 0x644}
	 */
	chmodFile(adapter: string, filename: string, options: object): Promise<{ entries: Array<any>; }> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		return new Promise((resolve, reject) =>
			this._socket.emit(
				"chmodFile",
				adapter,
				filename,
				options,
				(err, entries, id) =>
					err ? reject(err) : resolve({ entries, id }),
			),
		);
	}

	/**
	 * Change owner or/and owner group for file
	 * @param adapter adapter name
	 * @param filename file name with full path. it could be like vis.0/*
	 * @param options like {owner: 'newOwner', ownerGroup: 'newGroup'}
	 */
	chownFile(adapter: string, filename: string, options: object): Promise<{ entries: Array<any>; }> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		return new Promise((resolve, reject) =>
			this._socket.emit(
				"chownFile",
				adapter,
				filename,
				options,
				(err, entries, id) =>
					err ? reject(err) : resolve({ entries, id }),
			),
		);
	}

	/**
	 * Get the alarm notifications from a host (only for admin connection).
	 * @param host
	 * @param category - optional
	 */
	getNotifications(host: string, category: string): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise((resolve) =>
			this._socket.emit(
				"sendToHost",
				host,
				"getNotifications",
				{ category },
				(notifications) => resolve(notifications),
			),
		);
	}

	/**
	 * Clear the alarm notifications on a host (only for admin connection).
	 * @param host
	 * @param category - optional
	 */
	clearNotifications(host: string, category: string): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise((resolve) =>
			this._socket.emit(
				"sendToHost",
				host,
				"clearNotifications",
				{ category },
				(notifications) => resolve(notifications),
			),
		);
	}

	/**
	 * Read if only easy mode is allowed  (only for admin connection).
	 */
	getIsEasyModeStrict(): Promise<boolean> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit("getIsEasyModeStrict", (error, isStrict) =>
				error ? reject(error) : resolve(isStrict),
			),
		);
	}

	/**
	 * Read easy mode configuration (only for admin connection).
	 */
	getEasyMode(): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit("getEasyMode", (error, config) =>
				error ? reject(error) : resolve(config),
			),
		);
	}

	/**
	 * Read adapter ratings
	 */
	getRatings(update): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit("getRatings", update, (err, ratings) =>
				err ? reject(err) : resolve(ratings),
			),
		);
	}

	getCurrentSession(cmdTimeout) {
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
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
					reject("getCurrentSession: " + e);
				});
		});
	}

	/**
	 * Read current web, socketio or admin namespace, like admin.0
	 */
	getCurrentInstance(): Promise<string> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises.currentInstance =
			this._promises.currentInstance ||
			new Promise((resolve, reject) =>
				this._socket.emit("getCurrentInstance", (err, namespace) =>
					err ? reject(err) : resolve(namespace),
				),
			);

		return this._promises.currentInstance;
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
	getAdapterInstances(adapter: string, update: boolean): Promise<ioBroker.Object[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		if (typeof adapter === "boolean") {
			update = adapter;
			adapter = "";
		}
		adapter = adapter || "";

		if (!update && this._promises["instances_" + adapter]) {
			return this._promises["instances_" + adapter];
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises["instances_" + adapter] = new Promise(
			(resolve, reject) =>
				this._socket.emit(
					"getAdapterInstances",
					adapter,
					(err, instances) =>
						err ? reject(err) : resolve(instances),
				),
		);

		return this._promises["instances_" + adapter];
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
	getAdapters(adapter: string, update: boolean): Promise<ioBroker.Object[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		if (typeof adapter === "boolean") {
			update = adapter;
			adapter = "";
		}

		adapter = adapter || "";

		if (!update && this._promises["adapter_" + adapter]) {
			return this._promises["adapter_" + adapter];
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises["adapter_" + adapter] = new Promise((resolve, reject) =>
			this._socket.emit("getAdapters", adapter, (err, adapters) =>
				err ? reject(err) : resolve(adapters),
			),
		);

		return this._promises["adapter_" + adapter];
	}

	// returns very optimized information for adapters to minimize connection load
	getCompactAdapters(update) {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!update && this._promises.compactAdapters) {
			return this._promises.compactAdapters;
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}
		this._promises.compactAdapters = new Promise((resolve, reject) =>
			this._socket.emit("getCompactAdapters", (err, systemConfig) =>
				err ? reject(err) : resolve(systemConfig),
			),
		);

		return this._promises.compactAdapters;
	}

	// returns very optimized information for adapters to minimize connection load
	getCompactInstances(update) {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!update && this._promises.compactInstances) {
			return this._promises.compactInstances;
		}
		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises.compactInstances = new Promise((resolve, reject) =>
			this._socket.emit("getCompactInstances", (err, systemConfig) =>
				err ? reject(err) : resolve(systemConfig),
			),
		);

		return this._promises.compactInstances;
	}

	// returns very optimized information for adapters to minimize connection load
	// reads only version of installed adapter
	getCompactInstalled(host, update, cmdTimeout) {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		this._promises.installedCompact = this._promises.installedCompact || {};

		if (!update && this._promises.installedCompact[host]) {
			return this._promises.installedCompact[host];
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		if (!host.startsWith("system.host.")) {
			host += "system.host." + host;
		}

		this._promises.installedCompact[host] = new Promise(
			(resolve, reject) => {
				let timeout = setTimeout(() => {
					if (timeout) {
						timeout = null;
						reject("getCompactInstalled timeout");
					}
				}, cmdTimeout || this.props.cmdTimeout);

				this._socket.emit("getCompactInstalled", host, (data) => {
					if (timeout) {
						clearTimeout(timeout);
						timeout = null;
						if (data === PERMISSION_ERROR) {
							reject('May not read "getCompactInstalled"');
						} else if (!data) {
							reject('Cannot read "getCompactInstalled"');
						} else {
							resolve(data);
						}
					}
				});
			},
		);

		return this._promises.installedCompact[host];
	}

	/**
	 * Get the repository in compact form (only version and icon).
	 * @param host
	 * @param update Force update.
	 * @param timeoutMs timeout in ms.
	 */
	getCompactRepository(
		host: string,
		update: boolean,
		timeoutMs: number,
	): Promise<any> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!update && this._promises.repoCompact) {
			return this._promises.repoCompact;
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		if (!host.startsWith("system.host.")) {
			host += "system.host." + host;
		}

		this._promises.repoCompact = new Promise((resolve, reject) => {
			let timeout = setTimeout(() => {
				if (timeout) {
					timeout = null;
					reject("getCompactRepository timeout");
				}
			}, timeoutMs || this.props.cmdTimeout);

			this._socket.emit("getCompactRepository", host, (data) => {
				if (timeout) {
					clearTimeout(timeout);
					timeout = null;
					if (data === PERMISSION_ERROR) {
						reject('May not read "getCompactRepository"');
					} else if (!data) {
						reject('Cannot read "getCompactRepository"');
					} else {
						resolve(data);
					}
				}
			});
		});

		return this._promises.repoCompact;
	}

	/**
	 * Get the list of all hosts in compact form (only _id, common.name, common.icon, common.color, native.hardware.networkInterfaces)
	 * @param update Force update.
	 */
	getCompactHosts(update: boolean): Promise<ioBroker.Object[]> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}
		if (!update && this._promises.hostsCompact) {
			return this._promises.hostsCompact;
		}

		if (!this.connected) {
			return Promise.reject(NOT_CONNECTED);
		}

		this._promises.hostsCompact = new Promise((resolve, reject) =>
			this._socket.emit("getCompactHosts", (err, systemConfig) =>
				err ? reject(err) : resolve(systemConfig),
			),
		);

		return this._promises.hostsCompact;
	}
}
