import type { ConnectionProps } from "./ConnectionProps";
import type { EventHandlers, SocketClient } from "./SocketClient";
import type { GetUserPermissionsCallback } from "./SocketEvents";

/** Possible progress states. */
export enum PROGRESS {
	/** The socket is connecting. */
	CONNECTING = 0,
	/** The socket is successfully connected. */
	CONNECTED = 1,
	/** All objects are loaded. */
	OBJECTS_LOADED = 2,
	/** The socket is ready for use. */
	READY = 3,
}

export enum ERRORS {
	PERMISSION_ERROR = "permissionError",
	NOT_CONNECTED = "notConnectedError",
}

/** @deprecated Use {@link ERRORS.PERMISSION_ERROR} instead */
export const PERMISSION_ERROR = ERRORS.PERMISSION_ERROR;
/** @deprecated Use {@link ERRORS.NOT_CONNECTED} instead */
export const NOT_CONNECTED = ERRORS.NOT_CONNECTED;

export class Connection<
	CustomListenEvents extends EventHandlers = Record<never, never>,
	CustomEmitEvents extends EventHandlers = Record<never, never>,
> {
	constructor(props: Partial<ConnectionProps>) {
		this.props = this.applyDefaultProps(props);

		this.autoSubscribes = this.props.autoSubscribes ?? [];
		this.autoSubscribeLog = this.props.autoSubscribeLog ?? false;

		this.doNotLoadAllObjects = this.props.doNotLoadAllObjects ?? true;
		this.doNotLoadACL = this.props.doNotLoadACL ?? true;

		this.states = {};
		this.objects = null;
		this.acl = null;
		this.firstConnect = true;
		this.waitForRestart = false;
		this.systemLang = "en";
		this.connected = false;
		this._waitForFirstConnection = new Promise((resolve) => {
			this._waitForFirstConnectionResolve = resolve;
		});

		this.statesSubscribes = {}; // subscribe for states
		this.objectsSubscribes = {}; // subscribe for objects

		this.loaded = false;
		this.loadTimer = null;
		this.loadCounter = 0;
		this.admin5only = this.props.admin5only || false;

		this.onConnectionHandlers = [];
		this.onLogHandlers = [];

		this._promises = {};
		this.startSocket();
	}

	private applyDefaultProps(
		props: Partial<ConnectionProps>,
	): ConnectionProps {
		return {
			...props,
			// Define default props that always need to be set
			protocol: props.protocol || window.location.protocol,
			host: props.host || window.location.hostname,
			port:
				props.port ||
				(window.location.port === "3000" ? 8081 : window.location.port),
			ioTimeout: Math.max(props.ioTimeout || 20000, 20000),
			cmdTimeout: Math.max(props.cmdTimeout || 5000, 5000),
		};
	}

	private readonly props: ConnectionProps;
	private readonly autoSubscribes: string[];
	private readonly autoSubscribeLog: boolean;

	public doNotLoadAllObjects: boolean;
	public doNotLoadACL: boolean;
	public connected: boolean;
	public waitForRestart: any;
	public subscribed: boolean;
	public loaded: boolean;
	public statesSubscribes: Record<
		string,
		{ reg: RegExp; cbs: ioBroker.StateChangeHandler[] }
	>;
	public objectsSubscribes: Record<
		string,
		{ reg: RegExp; cbs: ioBroker.ObjectChangeHandler[] }
	>;
	public objects: any;
	public states: Record<string, ioBroker.State>;
	public acl: any;
	public firstConnect: boolean;
	public systemLang: ioBroker.Languages;
	public admin5only: any;
	public loadCounter: number;
	public loadTimer: any;
	public scriptLoadCounter: number;
	public isSecure: boolean;

	public onConnectionHandlers: ((connected: boolean) => void)[];
	public onLogHandlers: ((message: string) => void)[];

	private onError(error: any): void {
		(this.props.onError ?? console.error)(error);
	}

	private onCmdStdoutHandler?: (id: string, text: string) => void;
	private onCmdStderrHandler?: (id: string, text: string) => void;
	private onCmdExitHandler?: (id: string, exitCode: number) => void;

	protected _socket: SocketClient<CustomListenEvents, CustomEmitEvents>;
	// TODO: type this with a templated index signature https://github.com/microsoft/TypeScript/pull/26797
	protected _promises: Record<string, Promise<any>>;
	protected _authTimer: any;
	protected systemConfig: any;

	private _waitForFirstConnection: Promise<void>;
	private _waitForFirstConnectionResolve?: (
		value: void | PromiseLike<void>,
	) => void;

	/**
	 * Checks if this connection is running in a web adapter and not in an admin.
	 * @returns {boolean} True if running in a web adapter or in a socketio adapter.
	 */
	static isWeb(): boolean {
		return window.socketUrl !== undefined;
	}

	/**
	 * Starts the socket.io connection.
	 */
	startSocket(): void {
		// if socket io is not yet loaded
		if (typeof window.io === "undefined") {
			// if in index.html the onLoad function not defined
			if (typeof window.registerSocketOnLoad !== "function") {
				// poll if loaded
				this.scriptLoadCounter = this.scriptLoadCounter || 0;
				this.scriptLoadCounter++;

				if (this.scriptLoadCounter < 30) {
					// wait till the script loaded
					setTimeout(() => this.startSocket(), 100);
					return;
				} else {
					window.alert("Cannot load socket.io.js!");
				}
			} else {
				// register on load
				window.registerSocketOnLoad(() => this.startSocket());
			}
			return;
		} else {
			// socket was initialized, do not repeat
			if (this._socket) {
				return;
			}
		}

		let host = this.props.host;
		let port = this.props.port;
		let protocol = this.props.protocol.replace(":", "");

		// if web adapter, socket io could be on other port or even host
		if (window.socketUrl) {
			let parts = window.socketUrl.split(":");
			host = parts[0] || host;
			port = parts[1] || port;
			if (host.includes("://")) {
				parts = host.split("://");
				protocol = parts[0];
				host = parts[1];
			}
		}

		const url = `${protocol}://${host}:${port}`;

		this._socket = window.io.connect(url, {
			query: "ws=true",
			name: this.props.name,
			timeout: this.props.ioTimeout,
		});

		this._socket.on("connect", (noTimeout) => {
			// If the user is not admin it takes some time to install the handlers, because all rights must be checked
			if (noTimeout !== true) {
				setTimeout(
					() =>
						this.getVersion().then((info) => {
							const [major, minor, patch] =
								info.version.split(".");
							const v =
								parseInt(major, 10) * 10000 +
								parseInt(minor, 10) * 100 +
								parseInt(patch, 10);
							if (v < 40102) {
								this._authTimer = null;
								// possible this is old version of admin
								this.onPreConnect(false, false);
							} else {
								this._socket.emit(
									"authenticate",
									(isOk, isSecure) =>
										this.onPreConnect(isOk, isSecure),
								);
							}
						}),
					500,
				);
			} else {
				// iobroker websocket waits, till all handlers are installed
				this._socket.emit("authenticate", (isOk, isSecure) => {
					this.onPreConnect(isOk, isSecure);
				});
			}
		});

		this._socket.on("reconnect", () => {
			this.props.onProgress?.(PROGRESS.READY);
			this.connected = true;

			if (this.waitForRestart) {
				window.location.reload(false);
			} else {
				this._subscribe(true);
				this.onConnectionHandlers.forEach((cb) => cb(true));
			}
		});

		this._socket.on("disconnect", () => {
			this.connected = false;
			this.subscribed = false;
			this.props.onProgress?.(PROGRESS.CONNECTING);
			this.onConnectionHandlers.forEach((cb) => cb(false));
		});

		this._socket.on("reauthenticate", () => this.authenticate());

		this._socket.on("log", (message) => {
			this.props.onLog?.(message);
			this.onLogHandlers.forEach((cb) => cb(message));
		});

		this._socket.on("error", (err: any) => {
			let _err: string;

			if (err == undefined) {
				_err = "";
			} else if (typeof err.toString !== "function") {
				_err = err.toString();
			} else {
				_err = JSON.stringify(err);
				console.error(`Received strange error: ${_err}`);
			}

			if (_err.includes("User not authorized")) {
				this.authenticate();
			} else {
				window.alert(`Socket Error: ${err}`);
			}
		});

		this._socket.on("connect_error", (err: any) =>
			console.error(`Connect error: ${err}`),
		);

		this._socket.on("permissionError", (err) =>
			this.onError({
				message: "no permission",
				operation: err.operation,
				type: err.type,
				id: err.id || "",
			}),
		);

		this._socket.on("objectChange", (id, obj) => {
			setTimeout(() => this.objectChange(id, obj), 0);
		});

		this._socket.on("stateChange", (id, state) => {
			setTimeout(() => this.stateChange(id, state), 0);
		});

		this._socket.on("cmdStdout", (id, text) => {
			this.onCmdStdoutHandler?.(id, text);
		});

		this._socket.on("cmdStderr", (id, text) => {
			this.onCmdStderrHandler?.(id, text);
		});

		this._socket.on("cmdExit", (id, exitCode) => {
			this.onCmdExitHandler?.(id, exitCode);
		});
	}

	/**
	 * Called internally.
	 * @param isOk
	 * @param isSecure
	 */
	private onPreConnect(isOk: boolean, isSecure: boolean) {
		if (this._authTimer) {
			clearTimeout(this._authTimer);
			this._authTimer = null;
		}

		this.connected = true;
		this.isSecure = isSecure;

		if (this.waitForRestart) {
			window.location.reload(false);
		} else {
			if (this.firstConnect) {
				// retry strategy
				this.loadTimer = setTimeout(() => {
					this.loadTimer = null;
					this.loadCounter++;
					if (this.loadCounter < 10) {
						this.onConnect();
					}
				}, 1000);

				if (!this.loaded) {
					this.onConnect();
				}
			} else {
				this.props.onProgress?.(PROGRESS.READY);
			}

			this._subscribe(true);
			this.onConnectionHandlers.forEach((cb) => cb(true));
		}

		if (this._waitForFirstConnectionResolve) {
			this._waitForFirstConnectionResolve();
			this._waitForFirstConnectionResolve = undefined;
		}
	}

	/**
	 * Checks if the socket is connected.
	 * @returns {boolean} true if connected.
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Checks if the socket is connected.
	 * @returns {Promise<void>} Promise resolves if once connected.
	 */
	waitForFirstConnection(): Promise<void> {
		return this._waitForFirstConnection;
	}

	/**
	 * Called internally.
	 */
	private _getUserPermissions(cb?: GetUserPermissionsCallback) {
		if (this.doNotLoadACL) {
			cb?.();
		} else {
			this._socket.emit("getUserPermissions", cb);
		}
	}

	/**
	 * Called internally.
	 */
	private onConnect() {
		this._getUserPermissions((err, acl) => {
			if (err) {
				return this.onError(`Cannot read user permissions: ${err}`);
			} else if (!this.doNotLoadACL) {
				if (this.loaded) {
					return;
				}
				this.loaded = true;
				clearTimeout(this.loadTimer);
				this.loadTimer = null;

				this.props.onProgress?.(PROGRESS.CONNECTED);
				this.firstConnect = false;

				this.acl = acl;
			}

			// Read system configuration
			return (
				this.admin5only && !Connection.isWeb()
					? this.getCompactSystemConfig()
					: this.getSystemConfig()
			)
				.then((data) => {
					if (this.doNotLoadACL) {
						if (this.loaded) {
							return undefined;
						}
						this.loaded = true;
						clearTimeout(this.loadTimer);
						this.loadTimer = null;

						this.props.onProgress?.(PROGRESS.CONNECTED);
						this.firstConnect = false;
					}

					this.systemConfig = data;
					if (this.systemConfig && this.systemConfig.common) {
						this.systemLang = this.systemConfig.common.language;
					} else {
						this.systemLang =
							<any>window.navigator.userLanguage ||
							window.navigator.language;

						if (
							this.systemLang !== "en" &&
							this.systemLang !== "de" &&
							this.systemLang !== "ru"
						) {
							this.systemConfig.common.language = "en";
							this.systemLang = "en";
						}
					}

					this.props.onLanguage &&
						this.props.onLanguage(<any>this.systemLang);

					if (!this.doNotLoadAllObjects) {
						return this.getObjects().then(() => {
							this.props.onProgress?.(PROGRESS.READY);
							this.props.onReady &&
								this.props.onReady(this.objects);
						});
					} else {
						this.objects = this.admin5only
							? {}
							: { "system.config": data };
						this.props.onProgress?.(PROGRESS.READY);
						this.props.onReady?.(this.objects);
					}
					return undefined;
				})
				.catch((e) => this.onError(`Cannot read system config: ${e}`));
		});
	}

	/**
	 * Called internally.
	 */
	private authenticate() {
		if (window.location.search.includes("&href=")) {
			window.location = <any>(
				`${window.location.protocol}//${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`
			);
		} else {
			window.location = <any>(
				`${window.location.protocol}//${window.location.host}${window.location.pathname}?login&href=${window.location.search}${window.location.hash}`
			);
		}
	}

	/**
	 * Subscribe to changes of the given state.
	 * @param id The ioBroker state ID.
	 * @param cb The callback.
	 */
	/**
	 * Subscribe to changes of the given state.
	 * @param id The ioBroker state ID.
	 * @param binary Set to true if the given state is binary and requires Base64 decoding.
	 * @param cb The callback.
	 */
	subscribeState(
		id: string,
		binary: ioBroker.StateChangeHandler | boolean,
		cb: ioBroker.StateChangeHandler,
	): void {
		if (typeof binary === "function") {
			cb = binary;
			binary = false;
		}

		if (!this.statesSubscribes[id]) {
			let reg = id
				.replace(/\./g, "\\.")
				.replace(/\*/g, ".*")
				.replace(/\(/g, "\\(")
				.replace(/\)/g, "\\)")
				.replace(/\+/g, "\\+")
				.replace(/\[/g, "\\[");

			if (reg.indexOf("*") === -1) {
				reg += "$";
			}
			this.statesSubscribes[id] = { reg: new RegExp(reg), cbs: [] };
			this.statesSubscribes[id].cbs.push(cb);
			if (this.connected) {
				this._socket.emit("subscribe", id);
			}
		} else {
			!this.statesSubscribes[id].cbs.includes(cb) &&
				this.statesSubscribes[id].cbs.push(cb);
		}
		if (typeof cb === "function" && this.connected) {
			if (binary) {
				this.getBinaryState(id)
					.then((base64) => cb(id, <any>base64))
					.catch((e) =>
						console.error(
							`Cannot getForeignStates "${id}": ${JSON.stringify(
								e,
							)}`,
						),
					);
			} else {
				this._socket.emit("getForeignStates", id, (err, states) => {
					err &&
						console.error(
							`Cannot getForeignStates "${id}": ${JSON.stringify(
								err,
							)}`,
						);
					states &&
						Object.keys(states).forEach((id) => cb(id, states[id]));
				});
			}
		}
	}

	/**
	 * Unsubscribes all callbacks from changes of the given state.
	 * @param id The ioBroker state ID.
	 */
	/**
	 * Unsubscribes the given callback from changes of the given state.
	 * @param id The ioBroker state ID.
	 * @param cb The callback.
	 */
	unsubscribeState(id: string, cb?: ioBroker.StateChangeHandler): void {
		if (this.statesSubscribes[id]) {
			if (cb) {
				const pos = this.statesSubscribes[id].cbs.indexOf(cb);
				pos !== -1 && this.statesSubscribes[id].cbs.splice(pos, 1);
			} else {
				this.statesSubscribes[id].cbs = [];
			}

			if (
				!this.statesSubscribes[id].cbs ||
				!this.statesSubscribes[id].cbs.length
			) {
				delete this.statesSubscribes[id];
				this.connected && this._socket.emit("unsubscribe", id);
			}
		}
	}

	/**
	 * Subscribe to changes of the given object.
	 * @param id The ioBroker object ID.
	 * @param cb The callback.
	 */
	subscribeObject(
		id: string,
		cb: ioBroker.ObjectChangeHandler,
	): Promise<void> {
		if (!this.objectsSubscribes[id]) {
			let reg = id.replace(/\./g, "\\.").replace(/\*/g, ".*");
			if (!reg.includes("*")) {
				reg += "$";
			}
			this.objectsSubscribes[id] = { reg: new RegExp(reg), cbs: [] };
			this.objectsSubscribes[id].cbs.push(cb);
			this.connected && this._socket.emit("subscribeObjects", id);
		} else {
			!this.objectsSubscribes[id].cbs.includes(cb) &&
				this.objectsSubscribes[id].cbs.push(cb);
		}
		return Promise.resolve();
	}

	/**
	 * Unsubscribes all callbacks from changes of the given object.
	 * @param id The ioBroker object ID.
	 */
	/**
	 * Unsubscribes the given callback from changes of the given object.
	 * @param id The ioBroker object ID.
	 * @param cb The callback.
	 */
	unsubscribeObject(
		id: string,
		cb: ioBroker.ObjectChangeHandler,
	): Promise<void> {
		if (this.objectsSubscribes[id]) {
			if (cb) {
				const pos = this.objectsSubscribes[id].cbs.indexOf(cb);
				pos !== -1 && this.objectsSubscribes[id].cbs.splice(pos, 1);
			} else {
				this.objectsSubscribes[id].cbs = [];
			}

			if (
				this.connected &&
				(!this.objectsSubscribes[id].cbs ||
					!this.objectsSubscribes[id].cbs.length)
			) {
				delete this.objectsSubscribes[id];
				this.connected && this._socket.emit("unsubscribeObjects", id);
			}
		}
		return Promise.resolve();
	}

	/**
	 * Called internally.
	 * @param id
	 * @param obj
	 */
	private objectChange(id: string, obj: ioBroker.Object | null | undefined) {
		// update main.objects cache
		if (!this.objects) {
			return;
		}

		/** @type {import("./types").OldObject} */
		let oldObj: import("./types").OldObject;

		let changed = false;
		if (obj) {
			if (obj._rev && this.objects[id]) {
				this.objects[id]._rev = obj._rev;
			}

			if (this.objects[id]) {
				oldObj = { _id: id, type: this.objects[id].type };
			}

			if (
				!this.objects[id] ||
				JSON.stringify(this.objects[id]) !== JSON.stringify(obj)
			) {
				this.objects[id] = obj;
				changed = true;
			}
		} else if (this.objects[id]) {
			oldObj = { _id: id, type: this.objects[id].type };
			delete this.objects[id];
			changed = true;
		}

		Object.keys(this.objectsSubscribes).forEach((_id) => {
			if (_id === id || this.objectsSubscribes[_id].reg.test(id)) {
				this.objectsSubscribes[_id].cbs.forEach((cb) =>
					cb(id, obj, oldObj),
				);
			}
		});

		if (changed && this.props.onObjectChange) {
			this.props.onObjectChange(id, obj);
		}
	}

	/**
	 * Called internally.
	 * @param id
	 * @param state
	 */
	private stateChange(id: string, state: ioBroker.State | null | undefined) {
		for (const task in this.statesSubscribes) {
			if (
				this.statesSubscribes.hasOwnProperty(task) &&
				this.statesSubscribes[task].reg.test(id)
			) {
				this.statesSubscribes[task].cbs.forEach((cb) => cb(id, state));
			}
		}
	}

	/**
	 * Gets all states.
	 * @param disableProgressUpdate don't call onProgress() when done
	 */
	getStates(
		disableProgressUpdate?: boolean,
	): Promise<Record<string, ioBroker.State>> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		return new Promise((resolve, reject) =>
			this._socket.emit("getStates", (err, res) => {
				this.states = res ?? {};

				!disableProgressUpdate &&
					this.props.onProgress?.(PROGRESS.STATES_LOADED);
				return err ? reject(err) : resolve(this.states);
			}),
		);
	}

	/**
	 * Gets the given state.
	 * @param id The state ID.
	 */
	getState(id: string): Promise<ioBroker.State | null | undefined> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		return new Promise((resolve, reject) =>
			this._socket.emit("getState", id, (err, state) =>
				err ? reject(err) : resolve(state),
			),
		);
	}

	/**
	 * Gets the given binary state Base64 encoded.
	 * @param id The state ID.
	 */
	getBinaryState(id: string): Promise<string | undefined> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		// the data will come in base64
		return new Promise((resolve, reject) =>
			this._socket.emit("getBinaryState", id, (err, state) =>
				err ? reject(err) : resolve(state),
			),
		);
	}

	/**
	 * Sets the given binary state.
	 * @param id The state ID.
	 * @param base64 The Base64 encoded binary data.
	 */
	setBinaryState(id: string, base64: string): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		// the data will come in base64
		return new Promise<void>((resolve, reject) =>
			this._socket.emit("setBinaryState", id, base64, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	}

	/**
	 * Sets the given state value.
	 * @param id The state ID.
	 * @param val The state value.
	 */
	setState(
		id: string,
		val: ioBroker.State | ioBroker.StateValue | ioBroker.SettableState,
	): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		return new Promise<void>((resolve, reject) =>
			this._socket.emit("setState", id, val, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	}

	/**
	 * Gets all objects.
	 * @param update Callback that is executed when all objects are retrieved.
	 */
	/**
	 * Gets all objects.
	 * @param update Set to true to retrieve all objects from the server (instead of using the local cache).
	 * @param disableProgressUpdate don't call onProgress() when done
	 */
	getObjects(
		update?: ((par?: any) => void) | boolean,
		disableProgressUpdate?: boolean,
	): Promise<Record<string, ioBroker.Object>> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		} else {
			return new Promise((resolve, reject) => {
				if (!update && this.objects) {
					return resolve(this.objects);
				}

				this._socket.emit(
					Connection.isWeb() ? "getObjects" : "getAllObjects",
					(err, res) => {
						this.objects = res;
						disableProgressUpdate &&
							this.props.onProgress?.(PROGRESS.OBJECTS_LOADED);
						if (err) reject(err);
						resolve(this.objects);
					},
				);
			});
		}
	}

	/**
	 * Called internally.
	 * @param isEnable
	 */
	private _subscribe(isEnable: boolean) {
		if (isEnable && !this.subscribed) {
			this.subscribed = true;
			this.autoSubscribes.forEach((id) =>
				this._socket.emit("subscribeObjects", id),
			);
			// re subscribe objects
			Object.keys(this.objectsSubscribes).forEach((id) =>
				this._socket.emit("subscribeObjects", id),
			);
			// re-subscribe logs
			this.autoSubscribeLog && this._socket.emit("requireLog", true);
			// re subscribe states
			Object.keys(this.statesSubscribes).forEach((id) =>
				this._socket.emit("subscribe", id),
			);
		} else if (!isEnable && this.subscribed) {
			this.subscribed = false;
			// un-subscribe objects
			this.autoSubscribes.forEach((id) =>
				this._socket.emit("unsubscribeObjects", id),
			);
			Object.keys(this.objectsSubscribes).forEach((id) =>
				this._socket.emit("unsubscribeObjects", id),
			);
			// un-subscribe logs
			this.autoSubscribeLog && this._socket.emit("requireLog", false);

			// un-subscribe states
			Object.keys(this.statesSubscribes).forEach((id) =>
				this._socket.emit("unsubscribe", id),
			);
		}
	}

	/**
	 * Requests log updates.
	 * @param isEnabled Set to true to get logs.
	 */
	requireLog(isEnabled: boolean): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise<void>((resolve, reject) =>
			this._socket.emit("requireLog", isEnabled, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	}

	/**
	 * Deletes the given object.
	 * @param id The object ID.
	 * @param maintenance Force deletion of non conform IDs.
	 */
	delObject(id: string, maintenance?: boolean): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise<void>((resolve, reject) =>
			this._socket.emit(
				"delObject",
				id,
				{ maintenance: !!maintenance },
				(err) => (err ? reject(err) : resolve()),
			),
		);
	}

	/**
	 * Deletes the given object and all its children.
	 * @param id The object ID.
	 * @param maintenance Force deletion of non conform IDs.
	 */
	delObjects(id: string, maintenance: boolean): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise<void>((resolve, reject) =>
			this._socket.emit(
				"delObjects",
				id,
				{ maintenance: !!maintenance },
				(err) => (err ? reject(err) : resolve()),
			),
		);
	}

	/**
	 * Sets the object.
	 * @param id The object ID.
	 * @param obj The object.
	 */
	setObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		if (!obj) {
			return Promise.reject("Null object is not allowed");
		}

		obj = JSON.parse(JSON.stringify(obj));

		if (obj.hasOwnProperty("from")) {
			delete obj.from;
		}
		if (obj.hasOwnProperty("user")) {
			delete obj.user;
		}
		if (obj.hasOwnProperty("ts")) {
			delete obj.ts;
		}

		return new Promise<void>((resolve, reject) =>
			this._socket.emit("setObject", id, obj, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	}

	/**
	 * Gets the object with the given id from the server.
	 * @param id The object ID.
	 * @returns {ioBroker.GetObjectPromise} The object.
	 */
	getObject(id: string): ioBroker.GetObjectPromise {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit("getObject", id, (err, obj) =>
				err ? reject(err) : resolve(obj),
			),
		);
	}

	/**
	 * Sends a message to a specific instance or all instances of some specific adapter.
	 * @param instance The instance to send this message to.
	 * @param command Command name of the target instance.
	 * @param data The message data to send.
	 */
	sendTo(
		instance: string,
		command: string,
		data: ioBroker.MessagePayload,
	): Promise<ioBroker.Message | undefined> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise((resolve) =>
			this._socket.emit("sendTo", instance, command, data, (result) =>
				resolve(result),
			),
		);
	}

	/**
	 * Extend an object and create it if it might not exist.
	 * @param id The id.
	 * @param obj The object.
	 */
	extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		obj = JSON.parse(JSON.stringify(obj));

		if (obj.hasOwnProperty("from")) {
			delete obj.from;
		}
		if (obj.hasOwnProperty("user")) {
			delete obj.user;
		}
		if (obj.hasOwnProperty("ts")) {
			delete obj.ts;
		}

		return new Promise<void>((resolve, reject) =>
			this._socket.emit("extendObject", id, obj, (err) =>
				err ? reject(err) : resolve(),
			),
		);
	}

	/**
	 * Register a handler for log messages.
	 * @param handler The handler.
	 */
	registerLogHandler(handler: (message: string) => void): void {
		!this.onLogHandlers.includes(handler) &&
			this.onLogHandlers.push(handler);
	}

	/**
	 * Unregister a handler for log messages.
	 * @param handler The handler.
	 */
	unregisterLogHandler(handler: (message: string) => void): void {
		const pos = this.onLogHandlers.indexOf(handler);
		pos !== -1 && this.onLogHandlers.splice(pos, 1);
	}

	/**
	 * Register a handler for the connection state.
	 * @param handler The handler.
	 */
	registerConnectionHandler(handler: (connected: boolean) => void): void {
		!this.onConnectionHandlers.includes(handler) &&
			this.onConnectionHandlers.push(handler);
	}

	/**
	 * Unregister a handler for the connection state.
	 * @param handler The handler.
	 */
	unregisterConnectionHandler(handler: (connected: boolean) => void): void {
		const pos = this.onConnectionHandlers.indexOf(handler);
		pos !== -1 && this.onConnectionHandlers.splice(pos, 1);
	}

	/**
	 * Set the handler for standard output of a command.
	 * @param handler The handler.
	 */
	registerCmdStdoutHandler(
		handler: (id: string, text: string) => void,
	): void {
		this.onCmdStdoutHandler = handler;
	}

	/**
	 * Unset the handler for standard output of a command.
	 */
	unregisterCmdStdoutHandler(): void {
		this.onCmdStdoutHandler = undefined;
	}

	/**
	 * Set the handler for standard error of a command.
	 * @param handler The handler.
	 */
	registerCmdStderrHandler(
		handler: (id: string, text: string) => void,
	): void {
		this.onCmdStderrHandler = handler;
	}

	/**
	 * Unset the handler for standard error of a command.
	 */
	unregisterCmdStderrHandler(): void {
		this.onCmdStderrHandler = undefined;
	}

	/**
	 * Set the handler for exit of a command.
	 * @param handler The handler.
	 */
	registerCmdExitHandler(
		handler: (id: string, exitCode: number) => void,
	): void {
		this.onCmdExitHandler = handler;
	}

	/**
	 * Unset the handler for exit of a command.
	 */
	unregisterCmdExitHandler(): void {
		this.onCmdExitHandler = undefined;
	}

	/**
	 * Get all enums with the given name.
	 * @param _enum The name of the enum
	 * @param update Force update.
	 */
	getEnums(
		_enum?: string,
		update?: boolean,
	): Promise<Record<string, ioBroker.Object>> {
		const key = `enums_${_enum || "all"}`;
		if (!update && key in this._promises) {
			return this._promises[key];
		}

		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		this._promises[key] = new Promise((resolve, reject) => {
			this._socket.emit(
				"getObjectView",
				"system",
				"enum",
				{
					startkey: `enum.${_enum || ""}`,
					endkey: _enum ? `enum.${_enum}.\u9999` : `enum.\u9999`,
				},
				(err, res) => {
					if (!err && res) {
						const _res = {};
						for (let i = 0; i < res.rows.length; i++) {
							if (_enum && res.rows[i].id === `enum.${_enum}`) {
								continue;
							}
							_res[res.rows[i].id] = res.rows[i].value;
						}
						resolve(_res);
					} else {
						reject(err);
					}
				},
			);
		});

		return this._promises[key];
	}

	/**
	 * Query a predefined object view.
	 * @param start The start ID.
	 * @param end The end ID.
	 * @param type The type of object.
	 */
	getObjectView(
		start: string,
		end: string,
		type: string,
	): Promise<Record<string, ioBroker.Object>> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		start = start || "";
		end = end || "\u9999";

		return new Promise((resolve, reject) => {
			this._socket.emit(
				"getObjectView",
				"system",
				type,
				{ startkey: start, endkey: end },
				(err, res) => {
					if (!err) {
						const _res = {};
						if (res && res.rows) {
							for (let i = 0; i < res.rows.length; i++) {
								_res[res.rows[i].id] = res.rows[i].value;
							}
						}
						resolve(_res);
					} else {
						reject(err);
					}
				},
			);
		});
	}

	/**
	 * Read the meta items.
	 */
	readMetaItems(): Promise<ioBroker.Object[]> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit(
				"getObjectView",
				"system",
				"meta",
				{ startkey: "", endkey: "\u9999" },
				(err, objs) => {
					if (err) reject(err);
					resolve(
						objs!.rows
							?.map((obj) => obj.value)
							.filter((val): val is ioBroker.Object => !!val),
					);
				},
			),
		);
	}

	/**
	 * Read the directory of an adapter.
	 * @param adapterName The adapter name.
	 * @param path The directory name.
	 */
	readDir(
		adapterName: string | null,
		path: string,
	): Promise<ioBroker.ReadDirResult[]> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit("readDir", adapterName, path, (err, files) =>
				err ? reject(err) : resolve(files!),
			),
		);
	}

	readFile(
		adapterName: string | null,
		fileName: string,
		base64?: boolean,
	): Promise<{ file: string; mimeType: string }> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise((resolve, reject) => {
			this._socket.emit(
				base64 ? "readFile64" : "readFile",
				adapterName,
				fileName,
				(err, data, type) => {
					if (err) reject(err);
					resolve({ file: data as string, mimeType: type! });
				},
			);
		});
	}

	/**
	 * Write a file of an adapter.
	 * @param adapter The adapter name.
	 * @param fileName The file name.
	 * @param data The data (if it's a Buffer, it will be converted to Base64).
	 */
	writeFile64(
		adapter: string,
		fileName: string,
		data: Buffer | string,
	): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise<void>((resolve, reject) => {
			if (typeof data === "string") {
				this._socket.emit(
					"writeFile",
					adapter,
					fileName,
					data,
					(err) => {
						if (err) reject(err);
						resolve();
					},
				);
			} else {
				const base64 = btoa(
					new Uint8Array(data).reduce(
						(data, byte) => data + String.fromCharCode(byte),
						"",
					),
				);

				this._socket.emit(
					"writeFile64",
					adapter,
					fileName,
					base64,
					(err) => {
						if (err) reject(err);
						resolve();
					},
				);
			}
		});
	}

	/**
	 * Delete a file of an adapter.
	 * @param adapter The adapter name.
	 * @param fileName The file name.
	 */
	deleteFile(adapter: string, fileName: string): Promise<void> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
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
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise<void>((resolve, reject) =>
			this._socket.emit("deleteFolder", adapter, folderName, (err) =>
				err ? reject(err) : resolve(),
			),
		);
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
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		if (!host.startsWith(host)) {
			host += `system.host.${host}`;
		}

		return new Promise<void>((resolve, reject) => {
			let timeout: NodeJS.Timeout | undefined;
			if (cmdTimeout) {
				timeout = setTimeout(() => {
					if (timeout) {
						timeout = undefined;
						reject("cmdExec timeout");
					}
				}, cmdTimeout);
			}

			this._socket.emit("cmdExec", host, cmdId, cmd, (err) => {
				if (timeout) clearTimeout(timeout);
				timeout = undefined;

				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Gets the system configuration.
	 * @param update Force update.
	 */
	getSystemConfig(update?: boolean): Promise<ioBroker.OtherObject> {
		if (!update && "systemConfig" in this._promises) {
			return this._promises.systemConfig;
		}

		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		this._promises.systemConfig = this.getObject("system.config").then(
			(systemConfig) => {
				systemConfig = systemConfig || {};

				systemConfig.common = systemConfig.common || {};

				systemConfig.native = systemConfig.native || {};
				return systemConfig;
			},
		);

		return this._promises.systemConfig;
	}

	// returns very optimized information for adapters to minimize connection load
	getCompactSystemConfig(
		update?: boolean,
	): Promise<ioBroker.ObjectIdToObjectType<"system.config", "read">> {
		if (Connection.isWeb()) {
			return Promise.reject("Allowed only in admin");
		}

		if (!update && "systemConfigCommon" in this._promises) {
			return this._promises.systemConfigCommon;
		}

		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		this._promises.systemConfigCommon = new Promise((resolve, reject) =>
			this._socket.emit("getCompactSystemConfig", (err, systemConfig) =>
				err ? reject(err) : resolve(systemConfig!),
			),
		);

		return this._promises.systemConfigCommon;
	}

	/**
	 * Read all states (which might not belong to this adapter) which match the given pattern.
	 * @param pattern
	 */
	getForeignStates(pattern: string): ioBroker.GetStatesPromise {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit(
				"getForeignStates",
				pattern || "*",
				(err, states) => (err ? reject(err) : resolve(states)),
			),
		);
	}

	/**
	 * Get foreign objects by pattern, by specific type and resolve their enums.
	 * @param pattern
	 * @param type
	 */
	getForeignObjects<T extends ioBroker.ObjectType>(
		pattern: string,
		type: T,
	): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise((resolve, reject) =>
			this._socket.emit(
				"getForeignObjects",
				pattern || "*",
				type,
				(err, states) => (err ? reject(err) : resolve(states as any)),
			),
		);
	}

	/**
	 * Sets the system configuration.
	 * @param obj
	 */
	setSystemConfig(
		obj: ioBroker.SettableObjectWorker<ioBroker.OtherObject>,
	): Promise<ioBroker.SettableObjectWorker<ioBroker.OtherObject>> {
		return this.setObject("system.config", obj).then(
			() => (this._promises.systemConfig = Promise.resolve(obj)),
		);
	}

	/**
	 * Get the raw socket.io socket.
	 */
	getRawSocket(): any {
		return this._socket;
	}

	/**
	 * Get the history of a given state.
	 * @param id
	 * @param options
	 */
	getHistory(
		id: string,
		options: ioBroker.GetHistoryOptions,
	): Promise<ioBroker.GetHistoryResult> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		return new Promise((resolve, reject) =>
			this._socket.emit("getHistory", id, options, (err, values) =>
				err ? reject(err) : resolve(values!),
			),
		);
	}

	/**
	 * Get the history of a given state.
	 * @param id
	 * @param options
	 */
	getHistoryEx(
		id: string,
		options: ioBroker.GetHistoryOptions,
	): Promise<{
		values: ioBroker.GetHistoryResult;
		sessionId: string;
		stepIgnore: number;
	}> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		return new Promise((resolve, reject) =>
			this._socket.emit(
				"getHistory",
				id,
				options,
				(err, values, stepIgnore, sessionId) =>
					err
						? reject(err)
						: resolve({
								values: values!,
								sessionId: sessionId!,
								// TODO: WTF is up with the ignore thing?
								stepIgnore: stepIgnore!,
						  }),
			),
		);
	}

	/**
	 * Get the IP addresses of the given host.
	 * @param host
	 * @param update Force update.
	 */
	getIpAddresses(host: string, update: boolean): Promise<string[]> {
		if (!host.startsWith("system.host.")) {
			host = `system.host.${host}`;
		}

		const cacheKey = `IPs_${host}`;
		if (!update && cacheKey in this._promises) {
			return this._promises[cacheKey];
		}
		this._promises[cacheKey] = this.getObject(host).then((obj) =>
			obj && obj.common ? obj.common.address || [] : [],
		);

		return this._promises[cacheKey];
	}

	/**
	 * Gets the version.
	 */
	getVersion(): Promise<{ version: string; serverName: string }> {
		if (!("version" in this._promises)) {
			this._promises.version = new Promise((resolve, reject) => {
				this._socket.emit("getVersion", (err, version, serverName) => {
					// support of old socket.io
					if (
						err &&
						!version &&
						typeof err === "string" &&
						err.match(/\d+\.\d+\.\d+/)
					) {
						resolve({ version: err, serverName: "socketio" });
					} else {
						return err
							? reject(err)
							: resolve({ version, serverName });
					}
				});
			});
		}

		return this._promises.version;
	}

	/**
	 * Gets the web server name.
	 */
	getWebServerName(): Promise<string> {
		if (!("webName" in this._promises)) {
			this._promises.webName = new Promise((resolve, reject) => {
				this._socket.emit("getAdapterName", (err, name) =>
					err ? reject(err) : resolve(name),
				);
			});
		}
		return this._promises.webName;
	}

	/**
	 * Check if the file exists
	 * @param adapter adapter name
	 * @param filename file name with full path. it could be like vis.0/*
	 */
	fileExists(adapter: string, filename: string): Promise<boolean> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		return new Promise((resolve, reject) =>
			this._socket.emit("fileExists", adapter, filename, (err, exists) =>
				err ? reject(err) : resolve(!!exists),
			),
		);
	}

	/**
	 * Read current user
	 */
	getCurrentUser(): Promise<string> {
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}
		return new Promise((resolve) =>
			this._socket.emit("authEnabled", (isSecure, user) => resolve(user)),
		);
	}

	/**
	 * Get uuid
	 */
	getUuid(): Promise<ioBroker.Object[]> {
		if ("uuid" in this._promises) {
			return this._promises.uuid;
		}

		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		this._promises.uuid = this.getObject("system.meta.uuid").then(
			(obj) => obj?.native?.uuid,
		);

		return this._promises.uuid;
	}

	/**
	 * Checks if a given feature is supported.
	 * @param feature The feature to check.
	 * @param update Force update.
	 */
	checkFeatureSupported(feature: string, update?: boolean): Promise<any> {
		const cacheKey = `supportedFeatures_${feature}`;
		if (!update && cacheKey in this._promises) {
			return this._promises[cacheKey];
		}

		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		this._promises[cacheKey] = new Promise((resolve, reject) =>
			this._socket.emit(
				"checkFeatureSupported",
				feature,
				(err, features) => {
					if (err) reject(err);
					resolve(features);
				},
			),
		);

		return this._promises[cacheKey];
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
	): Promise<ioBroker.Object[]> {
		if (typeof adapter === "boolean") {
			update = adapter;
			adapter = "";
		}
		adapter = adapter || "";

		const cacheKey = `instances_${adapter}`;
		if (!update && cacheKey in this._promises) {
			return this._promises[cacheKey];
		}

		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		if (adapter) {
			this._promises[cacheKey] = this.getObjectView(
				`system.adapter.${adapter}.`,
				`system.group.${adapter}.\u9999`,
				"instance",
			);
		} else {
			this._promises[cacheKey] = this.getObjectView(
				"system.adapter.",
				"system.group.\u9999",
				"instance",
			);
		}

		return this._promises[cacheKey];
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
	): Promise<ioBroker.Object[]> {
		if (typeof adapter === "boolean") {
			update = adapter;
			adapter = "";
		}

		adapter = adapter || "";

		const cacheKey = `adapter_${adapter}`;
		if (!update && cacheKey in this._promises) {
			return this._promises[cacheKey];
		}

		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		if (adapter) {
			this._promises[cacheKey] = this.getObjectView(
				`system.adapter.${adapter}`,
				`system.group.${adapter}`,
				"adapter",
			).then((adapters) => {
				if (!adapters[`system.adapter.${adapter}`]) {
					return {};
				} else {
					return {
						[`system.adapter.${adapter}`]:
							adapters[`system.adapter.${adapter}`],
					};
				}
			});
		} else {
			this._promises[cacheKey] = this.getObjectView(
				"system.adapter.",
				"system.group.\u9999",
				"adapter",
			);
		}

		return this._promises[cacheKey];
	}
}
