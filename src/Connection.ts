import type { ConnectionProps } from "./ConnectionProps.js";
import { createDeferredPromise } from "./DeferredPromise.js";
import type {
	EmitEventHandler,
	ListenEventHandler,
	SocketClient,
} from "./SocketClient.js";
import { normalizeHostId, pattern2RegEx, wait } from "./tools.js";

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
	TIMEOUT = "timeout",
	NOT_ADMIN = "Allowed only in admin",
	NOT_SUPPORTED = "Not supported",
}

/** @deprecated Use {@link ERRORS.PERMISSION_ERROR} instead */
export const PERMISSION_ERROR = ERRORS.PERMISSION_ERROR;
/** @deprecated Use {@link ERRORS.NOT_CONNECTED} instead */
export const NOT_CONNECTED = ERRORS.NOT_CONNECTED;

/**
 * @internal
 * Options to use for the backend request wrapper
 */
export interface RequestOptions<T> {
	/** The key that is used to cache the results for later requests of the same kind */
	cacheKey?: string;
	/** Used to bypass the cache */
	forceUpdate?: boolean;
	/** Can be used to identify the request method in error messages */
	requestName?: string;
	/**
	 * The timeout in milliseconds after which the call will reject with a timeout error.
	 * If no timeout is given, the default is used. Set this to `false` to explicitly disable the timeout.
	 */
	commandTimeout?: number | false;
	/** Will be called when the timeout elapses */
	onTimeout?: () => void;
	/** Whether the call should only be allowed in the admin adapter */
	requireAdmin?: boolean;
	/** Require certain features to be supported for this call */
	requireFeatures?: string[];
	/** The function that does the actual work */
	executor: (
		resolve: (value: T | PromiseLike<T> | Promise<T>) => void,
		reject: (reason?: any) => void,
		/** Can be used to check in the executor whether the request has timed out and/or stop it from timing out */
		timeout: Readonly<{ elapsed: boolean; clearTimeout: () => void }>,
	) => void | Promise<void>;
}

export type SystemConfig = NonNullable<
	ioBroker.ObjectIdToObjectType<"system.config">
>;
export type BinaryStateChangeHandler = (
	id: string,
	base64: string | null,
) => void;

export interface OldObject {
	_id: string;
	type: string;
}

export type ObjectChangeHandler = (
	id: string,
	obj: ioBroker.Object | null | undefined,
	oldObj?: OldObject,
) => void | Promise<void>;

export class Connection<
	CustomListenEvents extends Record<
		keyof CustomListenEvents,
		ListenEventHandler
	> = Record<string, never>,
	CustomEmitEvents extends Record<
		keyof CustomEmitEvents,
		EmitEventHandler
	> = Record<string, never>,
> {
	constructor(props: Partial<ConnectionProps>) {
		this.props = this.applyDefaultProps(props);

		this.waitForSocketLib()
			.then(() => this.startSocket())
			.catch((e) => {
				alert(`Socket connection could not be initialized: ${e}`);
			});
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
			admin5only: props.admin5only || false,
			autoSubscribes: props.autoSubscribes ?? [],
			autoSubscribeLog: props.autoSubscribeLog ?? false,
			doNotLoadACL: props.doNotLoadACL ?? true,
			doNotLoadAllObjects: props.doNotLoadAllObjects ?? true,
		};
	}

	private readonly props: ConnectionProps;

	private connected: boolean = false;
	private subscribed: boolean = false;
	private firstConnect: boolean = true;
	public waitForRestart: boolean = false;
	public loaded: boolean = false;

	private readonly statesSubscribes: Record<
		string,
		{
			reg: RegExp;
			cbs: (ioBroker.StateChangeHandler | BinaryStateChangeHandler)[];
		}
	> = {};
	private readonly objectsSubscribes: Record<
		string,
		{ reg: RegExp; cbs: ObjectChangeHandler[] }
	> = {};
	private objects: Record<string, ioBroker.Object> = {};
	private states: Record<string, ioBroker.State> = {};

	public acl: any = null;
	public isSecure: boolean = false;

	private readonly onConnectionHandlers: ((connected: boolean) => void)[] =
		[];
	private readonly onLogHandlers: ((message: string) => void)[] = [];

	private onCmdStdoutHandler?: (id: string, text: string) => void;
	private onCmdStderrHandler?: (id: string, text: string) => void;
	private onCmdExitHandler?: (id: string, exitCode: number) => void;
	private onError(error: any): void {
		(this.props.onError ?? console.error)(error);
	}

	/** The socket instance */
	protected _socket!: SocketClient<CustomListenEvents, CustomEmitEvents>;

	private _waitForSocketPromise?: Promise<void>;
	private readonly _waitForFirstConnectionPromise = createDeferredPromise();

	/** Cache for server requests */
	private readonly _promises: Record<string, Promise<any>> = {};

	protected _authTimer: any;

	protected _systemConfig?: SystemConfig;
	/** The "system.config" object */
	public get systemConfig(): Readonly<SystemConfig> | undefined {
		return this._systemConfig;
	}

	private _systemLang: ioBroker.Languages = "en";
	public get systemLang(): ioBroker.Languages {
		return this._systemLang;
	}

	/**
	 * Checks if this connection is running in a web adapter and not in an admin.
	 * @returns {boolean} True if running in a web adapter or in a socketio adapter.
	 */
	static isWeb(): boolean {
		return window.socketUrl !== undefined;
	}

	private waitForSocketLib(): Promise<void> {
		// Only wait once
		if (this._waitForSocketPromise) return this._waitForSocketPromise;

		this._waitForSocketPromise = new Promise(async (resolve, reject) => {
			// If socket io is not yet loaded, we need to wait for it
			if (typeof window.io === "undefined") {
				// If the registerSocketOnLoad function is defined in index.html,
				// we can use it to know when the socket library was loaded
				if (typeof window.registerSocketOnLoad === "function") {
					window.registerSocketOnLoad(() => resolve());
				} else {
					// otherwise we need to poll
					for (let i = 1; i <= 30; i++) {
						if (window.io) return resolve();
						await wait(100);
					}

					reject(new Error("Socket library could not be loaded!"));
				}
			} else {
				resolve();
			}
		});
		return this._waitForSocketPromise;
	}

	/**
	 * Starts the socket.io connection.
	 */
	async startSocket(): Promise<void> {
		if (this._socket) return;

		let host = this.props.host;
		let port = this.props.port;
		let protocol = this.props.protocol.replace(":", "");

		// if web adapter, socket io could be on other port or even host
		if (window.socketUrl) {
			const parsed = new URL(window.socketUrl);
			host = parsed.hostname;
			port = parsed.port;
			protocol = parsed.protocol.replace(":", "");
		}

		const url = `${protocol}://${host}:${port}`;

		this._socket = window.io.connect(url, {
			query: protocol == "ws" || protocol == "wss" ? "ws=true" : "",
			name: this.props.name,
			timeout: this.props.ioTimeout,
		});

		this._socket.on("connect", (noTimeout) => {
			// If the user is not admin it takes some time to install the handlers, because all rights must be checked
			if (noTimeout !== true) {
				this.connected = true;
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
				window.location.reload();
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
			} else if (typeof err.toString === "function") {
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
	 */
	private onPreConnect(isOk: boolean, isSecure: boolean) {
		if (this._authTimer) {
			clearTimeout(this._authTimer);
			this._authTimer = null;
		}

		this.connected = true;
		this.isSecure = isSecure;

		if (this.waitForRestart) {
			window.location.reload();
		} else {
			if (this.firstConnect) {
				this.loadData();
			} else {
				this.props.onProgress?.(PROGRESS.READY);
			}

			this._subscribe(true);
			this.onConnectionHandlers.forEach((cb) => cb(true));
		}

		this._waitForFirstConnectionPromise.resolve();
	}

	/**
	 * Checks if the socket is connected.
	 * @returns {boolean} true if connected.
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Returns a promise which is resolved when the socket is connected.
	 */
	waitForFirstConnection(): Promise<void> {
		return this._waitForFirstConnectionPromise;
	}

	/**
	 * Called internally.
	 */
	private async getUserPermissions(): Promise<any> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getUserPermissions", (err, acl) => {
					if (err) reject(err);
					resolve(acl!);
				});
			},
		});
	}

	/** Loads the important data and retries a couple of times if it takes too long */
	private async loadData(): Promise<void> {
		if (this.loaded) return;
		const maxAttempts = 10;
		for (let i = 1; i <= maxAttempts; i++) {
			this.doLoadData();
			if (this.loaded) return;
			await wait(1000);
		}
	}

	/**
	 * Called after the socket is connected. Loads the necessary data.
	 */
	private async doLoadData() {
		if (this.loaded) return;

		// Load ACL if not disabled
		if (!this.props.doNotLoadACL) {
			try {
				this.acl = await this.getUserPermissions();
			} catch (e) {
				this.onError(`Cannot read user permissions: ${e}`);
				return;
			}
		}

		// Load system config if not disabled
		try {
			if (
				this.props.admin5only &&
				!Connection.isWeb() &&
				(!window.vendorPrefix ||
					window.vendorPrefix === "@@vendorPrefix@@")
			) {
				this._systemConfig = await this.getCompactSystemConfig();
			} else {
				this._systemConfig = await this.getSystemConfig();
			}
		} catch (e) {
			this.onError(`Cannot read system config: ${e}`);
			return;
		}

		// Detect the system language
		this._systemLang = this._systemConfig.common?.language;
		if (!this._systemLang) {
			this._systemLang = (window.navigator.userLanguage ||
				window.navigator.language) as any;
			// Browsers may report languages like "de-DE", "en-US", etc.
			// ioBroker expects "de", "en", ...
			if (/^(en|de|ru|pt|nl|fr|it|es|pl)\-?/.test(this._systemLang)) {
				this._systemLang = this._systemLang.substr(0, 2) as any;
			} else if (
				!/^(en|de|ru|pt|nl|fr|it|es|pl|zh-cn)$/.test(this._systemLang)
			) {
				this._systemLang = "en";
			}
			this._systemConfig.common.language = this._systemLang;
		}
		this.props.onLanguage?.(this.systemLang);

		// We are now connected
		this.loaded = true;
		this.props.onProgress?.(PROGRESS.CONNECTED);
		this.firstConnect = false;

		// Load all objects if desired
		if (!this.props.doNotLoadAllObjects) {
			this.objects = await this.getObjects();
		} else if (this.props.admin5only) {
			this.objects = {};
		} else {
			this.objects = { "system.config": this._systemConfig };
		}

		this.props.onProgress?.(PROGRESS.READY);
		this.props.onReady?.(this.objects);
	}

	/**
	 * Called internally.
	 */
	private authenticate() {
		if (window.location.search.includes("&href=")) {
			window.location.href = `${window.location.protocol}//${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`;
		} else {
			window.location.href = `${window.location.protocol}//${window.location.host}${window.location.pathname}?login&href=${window.location.search}${window.location.hash}`;
		}
	}

	/**
	 * Subscribe to changes of the given state.
	 * @param id The ioBroker state ID.
	 * @param binary Set to true if the given state is binary and requires Base64 decoding.
	 * @param cb The callback.
	 */

	subscribeState(
		id: string,
		binary: true,
		cb: BinaryStateChangeHandler,
	): Promise<void>;

	subscribeState(
		id: string,
		binary: false,
		cb: ioBroker.StateChangeHandler,
	): Promise<void>;

	subscribeState(id: string, cb: ioBroker.StateChangeHandler): Promise<void>;

	async subscribeState(
		...args:
			| [id: string, binary: true, cb: BinaryStateChangeHandler]
			| [id: string, binary: false, cb: ioBroker.StateChangeHandler]
			| [id: string, cb: ioBroker.StateChangeHandler]
	): Promise<void> {
		let id: string;
		let binary: boolean;
		let cb: ioBroker.StateChangeHandler | BinaryStateChangeHandler;
		if (args.length === 3) {
			[id, binary, cb] = args;
		} else {
			[id, cb] = args;
			binary = false;
		}

		if (typeof cb !== "function") {
			throw new Error("The state change handler must be a function!");
		}

		if (!this.statesSubscribes[id]) {
			this.statesSubscribes[id] = {
				reg: new RegExp(pattern2RegEx(id)),
				cbs: [cb],
			};
			if (this.connected) this._socket.emit("subscribe", id);
		} else {
			!this.statesSubscribes[id].cbs.includes(cb) &&
				this.statesSubscribes[id].cbs.push(cb);
		}

		if (this.connected) {
			// Try to get the current value(s) of the state(s) and call the change handlers
			if (binary) {
				let base64: string | undefined;
				try {
					base64 = await this.getBinaryState(id);
				} catch (e) {
					console.error(
						`Cannot getBinaryState "${id}": ${JSON.stringify(e)}`,
					);
				}
				if (base64 != undefined) {
					(cb as BinaryStateChangeHandler)(id, base64);
				}
			} else {
				let states: Record<string, ioBroker.State> | undefined;
				try {
					states = await this.getForeignStates(id);
				} catch (e) {
					console.error(
						`Cannot getForeignStates "${id}": ${JSON.stringify(e)}`,
					);
					return;
				}
				if (states) {
					for (const [id, state] of Object.entries(states)) {
						(cb as ioBroker.StateChangeHandler)(id, state);
					}
				}
			}
		}
	}

	/**
	 * Unsubscribes the given callback from changes of the given state.
	 * @param id The ioBroker state ID.
	 * @param cb The callback.
	 */
	unsubscribeState(id: string, cb?: ioBroker.StateChangeHandler): void {
		if (this.statesSubscribes[id]) {
			const sub = this.statesSubscribes[id];
			if (cb) {
				const pos = sub.cbs.indexOf(cb);
				pos !== -1 && sub.cbs.splice(pos, 1);
			} else {
				sub.cbs = [];
			}

			if (!sub.cbs || !sub.cbs.length) {
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
	subscribeObject(id: string, cb: ObjectChangeHandler): Promise<void> {
		if (!this.objectsSubscribes[id]) {
			this.objectsSubscribes[id] = {
				reg: new RegExp(pattern2RegEx(id)),
				cbs: [cb],
			};
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
	unsubscribeObject(id: string, cb: ObjectChangeHandler): Promise<void> {
		if (this.objectsSubscribes[id]) {
			const sub = this.objectsSubscribes[id];
			if (cb) {
				const pos = sub.cbs.indexOf(cb);
				pos !== -1 && sub.cbs.splice(pos, 1);
			} else {
				sub.cbs = [];
			}

			if (this.connected && (!sub.cbs || !sub.cbs.length)) {
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

		// Remember the id and type of th old object
		let oldObj: OldObject | undefined;
		if (this.objects[id]) {
			oldObj = { _id: id, type: this.objects[id].type };
		}

		let changed = false;
		if (obj) {
			// The object was added, updated or changed

			// Copy the _rev property (whatever that is)
			if ((obj as any)._rev && this.objects[id]) {
				(this.objects[id] as any)._rev = (obj as any)._rev;
			}

			// Detect if there was a change
			if (
				!this.objects[id] ||
				JSON.stringify(this.objects[id]) !== JSON.stringify(obj)
			) {
				this.objects[id] = obj;
				changed = true;
			}
		} else if (this.objects[id]) {
			// The object was deleted
			delete this.objects[id];
			changed = true;
		}

		// Notify all subscribed listeners
		for (const [_id, sub] of Object.entries(this.objectsSubscribes)) {
			if (_id === id || sub.reg.test(id)) {
				sub.cbs.forEach((cb) => cb(id, obj, oldObj));
			}
		}

		// Notify the default listener on change
		if (changed) this.props.onObjectChange?.(id, obj);
	}

	/**
	 * Called internally.
	 * @param id
	 * @param state
	 */
	private stateChange(id: string, state: ioBroker.State | null | undefined) {
		for (const sub of Object.values(this.statesSubscribes)) {
			if (sub.reg.test(id)) {
				for (const cb of sub.cbs) {
					// TODO: This might not be correct - check what happens if state is a binary state
					cb(id, (state ?? null) as any);
				}
			}
		}
	}

	/** Requests data from the server or reads it from the cache */
	protected async request<T>({
		cacheKey,
		forceUpdate,
		commandTimeout,
		onTimeout,
		requireAdmin,
		requireFeatures,
		// requestName,
		executor,
	}: RequestOptions<T>): Promise<T> {
		// TODO: mention requestName in errors

		// If the command requires the admin adapter, enforce it
		if (requireAdmin && Connection.isWeb()) {
			return Promise.reject(ERRORS.NOT_ADMIN);
		}

		// Return the cached value if allowed
		if (cacheKey && !forceUpdate && cacheKey in this._promises) {
			return this._promises[cacheKey];
		}

		// Require the socket to be connected
		if (!this.connected) {
			return Promise.reject(ERRORS.NOT_CONNECTED);
		}

		// Check if all required features are supported
		if (requireFeatures?.length) {
			for (const feature of requireFeatures) {
				if (!(await this.checkFeatureSupported(feature))) {
					throw ERRORS.NOT_SUPPORTED;
				}
			}
		}

		const promise = new Promise<T>(async (resolve, reject) => {
			const timeoutControl = {
				elapsed: false,
				clearTimeout: () => {
					// no-op unless there is a timeout
				},
			};
			let timeout: NodeJS.Timeout | undefined;
			if (commandTimeout !== false) {
				timeout = setTimeout(() => {
					timeoutControl.elapsed = true;
					// Let the caller know that the timeout elapsed
					onTimeout?.();
					reject(ERRORS.TIMEOUT);
				}, commandTimeout ?? this.props.cmdTimeout);
				timeoutControl.clearTimeout = () => {
					clearTimeout(timeout!);
				};
			}
			// Call the actual function - awaiting it allows us to catch sync and async errors
			// no matter if the executor is async or not
			try {
				await executor(resolve, reject, timeoutControl);
			} catch (e) {
				reject(e);
			}
		});
		if (cacheKey) {
			this._promises[cacheKey] = promise;
		}
		return promise;
	}

	/**
	 * Gets all states.
	 * @param disableProgressUpdate don't call onProgress() when done
	 */
	getStates(): // disableProgressUpdate?: boolean,
	Promise<Record<string, ioBroker.State>> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getStates", (err, res) => {
					this.states = res ?? {};

					// if (!disableProgressUpdate) {
					// 	this.props.onProgress?.(PROGRESS.STATES_LOADED);
					// }
					if (err) reject(err);
					resolve(this.states);
				});
			},
		});
	}

	/**
	 * Gets the given state.
	 * @param id The state ID.
	 */
	getState(id: string): Promise<ioBroker.State | null | undefined> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getState", id, (err, state) => {
					if (err) reject(err);
					resolve(state);
				});
			},
		});
	}

	/**
	 * Gets the given binary state Base64 encoded.
	 * @param id The state ID.
	 */
	getBinaryState(id: string): Promise<string | undefined> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getBinaryState", id, (err, state) => {
					if (err) reject(err);
					resolve(state);
				});
			},
		});
	}

	/**
	 * Sets the given binary state.
	 * @param id The state ID.
	 * @param base64 The Base64 encoded binary data.
	 */
	setBinaryState(id: string, base64: string): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("setBinaryState", id, base64, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
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
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("setState", id, val, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
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
		update?: boolean,
		disableProgressUpdate?: boolean,
	): Promise<Record<string, ioBroker.Object>> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				if (!update && this.objects) {
					resolve(this.objects);
					return;
				}

				this._socket.emit(
					Connection.isWeb() ? "getObjects" : "getAllObjects",
					(err, res) => {
						if (!disableProgressUpdate)
							this.props.onProgress?.(PROGRESS.OBJECTS_LOADED);
						if (err) reject(err);
						this.objects = res ?? {};
						resolve(this.objects);
					},
				);
			},
		});
	}

	/**
	 * Called internally.
	 * @param isEnable
	 */
	private _subscribe(isEnable: boolean) {
		if (isEnable && !this.subscribed) {
			this.subscribed = true;
			if (this.props.autoSubscribes) {
				this.props.autoSubscribes.forEach((id) =>
					this._socket.emit("subscribeObjects", id),
				);
			}
			// re subscribe objects
			Object.keys(this.objectsSubscribes).forEach((id) =>
				this._socket.emit("subscribeObjects", id),
			);
			// re-subscribe logs
			this.props.autoSubscribeLog &&
				this._socket.emit("requireLog", true);
			// re subscribe states
			Object.keys(this.statesSubscribes).forEach((id) =>
				this._socket.emit("subscribe", id),
			);
		} else if (!isEnable && this.subscribed) {
			this.subscribed = false;
			// un-subscribe objects
			if (this.props.autoSubscribes) {
				this.props.autoSubscribes.forEach((id) =>
					this._socket.emit("unsubscribeObjects", id),
				);
			}
			Object.keys(this.objectsSubscribes).forEach((id) =>
				this._socket.emit("unsubscribeObjects", id),
			);
			// un-subscribe logs
			this.props.autoSubscribeLog &&
				this._socket.emit("requireLog", false);

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
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("requireLog", isEnabled, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Deletes the given object.
	 * @param id The object ID.
	 * @param maintenance Force deletion of non conform IDs.
	 */
	delObject(id: string, maintenance: boolean = false): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("delObject", id, { maintenance }, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Deletes the given object and all its children.
	 * @param id The object ID.
	 * @param maintenance Force deletion of non conform IDs.
	 */
	delObjects(id: string, maintenance: boolean): Promise<void> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("delObjects", id, { maintenance }, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Sets the object.
	 * @param id The object ID.
	 * @param obj The object.
	 */
	setObject(id: string, obj: ioBroker.SettableObject): Promise<void> {
		if (!obj) {
			return Promise.reject("Null object is not allowed");
		}

		obj = JSON.parse(JSON.stringify(obj));
		delete obj.from;
		delete obj.user;
		delete obj.ts;

		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("setObject", id, obj, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Gets the object with the given id from the server.
	 * @param id The object ID.
	 * @returns {ioBroker.GetObjectPromise} The object.
	 */
	getObject<T extends string>(id: T): ioBroker.GetObjectPromise<T> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getObject", id, (err, obj) => {
					if (err) reject(err);
					resolve(obj as any);
				});
			},
		});
	}

	/**
	 * Sends a message to a specific instance or all instances of some specific adapter.
	 * @param instance The instance to send this message to.
	 * @param command Command name of the target instance.
	 * @param data The message data to send.
	 */
	sendTo<T = any>(instance: string, command: string, data?: any): Promise<T> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve) => {
				this._socket.emit(
					"sendTo",
					instance,
					command,
					data,
					(result: any) => {
						resolve(result);
					},
				);
			},
		});
	}

	/**
	 * Extend an object and create it if it might not exist.
	 * @param id The id.
	 * @param obj The object.
	 */
	extendObject(id: string, obj: ioBroker.PartialObject): Promise<void> {
		if (!obj) {
			return Promise.reject("Null object is not allowed");
		}

		obj = JSON.parse(JSON.stringify(obj));
		delete obj.from;
		delete obj.user;
		delete obj.ts;

		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("extendObject", id, obj, (err) => {
					if (err) reject(err);
					resolve();
				});
			},
		});
	}

	/**
	 * Register a handler for log messages.
	 * @param handler The handler.
	 */
	registerLogHandler(handler: (message: string) => void): void {
		if (!this.onLogHandlers.includes(handler)) {
			this.onLogHandlers.push(handler);
		}
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
		if (!this.onConnectionHandlers.includes(handler)) {
			this.onConnectionHandlers.push(handler);
		}
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
	): Promise<Record<string, ioBroker.EnumObject>> {
		return this.request({
			cacheKey: `enums_${_enum || "all"}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getObjectView",
					"system",
					"enum",
					{
						startkey: `enum.${_enum || ""}`,
						endkey: _enum ? `enum.${_enum}.\u9999` : `enum.\u9999`,
					},
					(err, res) => {
						if (err) reject(err);
						const _res: Record<string, ioBroker.EnumObject> = {};
						if (res) {
							for (let i = 0; i < res.rows.length; i++) {
								if (
									_enum &&
									res.rows[i].id === `enum.${_enum}`
								) {
									continue;
								}
								_res[res.rows[i].id] = res.rows[i]
									.value as ioBroker.EnumObject;
							}
						}
						resolve(_res);
					},
				);
			},
		});
	}

	/**
	 * Query a predefined object view.
	 * @param start The start ID.
	 * @param end The end ID.
	 * @param type The type of object.
	 */
	getObjectView<T extends ioBroker.ObjectType>(
		start: string,
		end: string,
		type: T,
	): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				start = start || "";
				end = end || "\u9999";

				this._socket.emit(
					"getObjectView",
					"system",
					type,
					{ startkey: start, endkey: end },
					(err, res) => {
						if (err) reject(err);

						const _res: Record<
							string,
							ioBroker.AnyObject & { type: T }
						> = {};
						if (res && res.rows) {
							for (let i = 0; i < res.rows.length; i++) {
								_res[res.rows[i].id] = res.rows[i].value as any;
							}
						}
						resolve(_res);
					},
				);
			},
		});
	}

	/**
	 * Read the meta items.
	 */
	readMetaItems(): Promise<ioBroker.Object[]> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
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
				);
			},
		});
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
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"readDir",
					adapterName,
					path,
					(err, files) => {
						if (err) reject(err);
						resolve(files!);
					},
				);
			},
		});
	}

	readFile(
		adapterName: string | null,
		fileName: string,
		base64?: boolean,
	): Promise<{ file: string; mimeType: string }> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					base64 ? "readFile64" : "readFile",
					adapterName,
					fileName,
					(err, data, type) => {
						if (err) reject(err);
						resolve({ file: data as string, mimeType: type! });
					},
				);
			},
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
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
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
	 * Gets the system configuration.
	 * @param update Force update.
	 */
	getSystemConfig(update?: boolean): Promise<SystemConfig> {
		return this.request({
			cacheKey: "systemConfig",
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				let systemConfig = await this.getObject("system.config");
				(systemConfig as any) ??= {};
				(systemConfig as any).common ??= {};
				(systemConfig as any).native ??= {};

				resolve(systemConfig!);
			},
		});
	}

	// returns very optimized information for adapters to minimize connection load
	getCompactSystemConfig(update?: boolean): Promise<SystemConfig> {
		return this.request({
			cacheKey: "systemConfigCommon",
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			requireAdmin: true,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getCompactSystemConfig",
					(err, systemConfig) => {
						if (err) reject(err);
						(systemConfig as any) ??= {};
						(systemConfig as any).common ??= {};
						(systemConfig as any).native ??= {};
						resolve(systemConfig!);
					},
				);
			},
		});
	}

	/**
	 * Read all states (which might not belong to this adapter) which match the given pattern.
	 * @param pattern
	 */
	getForeignStates(
		pattern?: string | null | undefined,
	): ioBroker.GetStatesPromise {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getForeignStates",
					pattern || "*",
					(err, states) => {
						if (err) reject(err);
						resolve(states ?? {});
					},
				);
			},
		});
	}

	/**
	 * Get foreign objects by pattern, by specific type and resolve their enums.
	 * @param pattern
	 * @param type
	 */
	getForeignObjects<T extends ioBroker.ObjectType>(
		pattern: string | null | undefined,
		type: T,
	): Promise<Record<string, ioBroker.AnyObject & { type: T }>> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getForeignObjects",
					pattern || "*",
					type,
					(err, objects) => {
						if (err) reject(err);
						resolve(objects as any);
					},
				);
			},
		});
	}

	/**
	 * Sets the system configuration.
	 * @param obj
	 */
	setSystemConfig(
		obj: ioBroker.SettableObjectWorker<ioBroker.OtherObject>,
	): Promise<void> {
		return this.setObject("system.config", obj);
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
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getHistory", id, options, (err, values) => {
					if (err) reject(err);
					resolve(values!);
				});
			},
		});
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
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"getHistory",
					id,
					options,
					(err, values, stepIgnore, sessionId) => {
						if (err) reject(err);
						resolve({
							values: values!,
							sessionId: sessionId!,
							// TODO: WTF is up with the ignore thing?
							stepIgnore: stepIgnore!,
						});
					},
				);
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
			executor: async (resolve) => {
				const obj = await this.getObject(host);
				resolve(obj?.common.address ?? []);
			},
		});
	}

	/**
	 * Gets the version.
	 */
	getVersion(): Promise<{ version: string; serverName: string }> {
		return this.request({
			cacheKey: "version",
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getVersion", (err, version, serverName) => {
					// Old socket.io had no error parameter
					if (
						err &&
						!version &&
						typeof err === "string" &&
						err.match(/\d+\.\d+\.\d+/)
					) {
						resolve({ version: err, serverName: "socketio" });
					} else {
						if (err) reject(err);
						resolve({ version: version!, serverName: serverName! });
					}
				});
			},
		});
	}

	/**
	 * Gets the web server name.
	 */
	getWebServerName(): Promise<string> {
		return this.request({
			cacheKey: "webName",
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit("getAdapterName", (err, name) => {
					if (err) reject(err);
					resolve(name!);
				});
			},
		});
	}

	/**
	 * Check if the file exists
	 * @param adapter adapter name
	 * @param filename file name with full path. it could be like vis.0/*
	 */
	fileExists(adapter: string, filename: string): Promise<boolean> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"fileExists",
					adapter,
					filename,
					(err, exists) => {
						if (err) reject(err);
						resolve(!!exists);
					},
				);
			},
		});
	}

	/**
	 * Read current user
	 */
	getCurrentUser(): Promise<string> {
		return this.request({
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve) => {
				this._socket.emit("authEnabled", (_isSecure, user) => {
					resolve(user);
				});
			},
		});
	}

	/**
	 * Get uuid
	 */
	getUuid(): Promise<ioBroker.Object[]> {
		return this.request({
			cacheKey: "uuid",
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				const obj = await this.getObject("system.meta.uuid");
				resolve(obj?.native?.uuid);
			},
		});
	}

	/**
	 * Checks if a given feature is supported.
	 * @param feature The feature to check.
	 * @param update Force update.
	 */
	checkFeatureSupported(feature: string, update?: boolean): Promise<any> {
		return this.request({
			cacheKey: `supportedFeatures_${feature}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: (resolve, reject) => {
				this._socket.emit(
					"checkFeatureSupported",
					feature,
					(err, features) => {
						if (err) reject(err);
						resolve(features);
					},
				);
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
		adapter = adapter || "";

		return this.request({
			cacheKey: `instances_${adapter}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				const startKey = adapter
					? `system.adapter.${adapter}.`
					: "system.adapter.";
				const endKey = `${startKey}\u9999`;

				const instances = await this.getObjectView(
					startKey,
					endKey,
					"instance",
				);
				const instanceObjects = Object.values(instances);
				if (adapter) {
					resolve(
						instanceObjects.filter(
							(o) => o.common.name === adapter,
						),
					);
				} else {
					resolve(instanceObjects);
				}
			},
		});
	}

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
		adapter = adapter || "";

		return this.request({
			cacheKey: `adapter_${adapter}`,
			forceUpdate: update,
			// TODO: check if this should time out
			commandTimeout: false,
			executor: async (resolve) => {
				const adapters = await this.getObjectView(
					`system.adapter.${adapter || ""}`,
					`system.adapter.${adapter || "\u9999"}`,
					"adapter",
				);
				const adapterObjects = Object.values(adapters);
				if (adapter) {
					resolve(
						adapterObjects.filter((o) => o.common.name === adapter),
					);
				} else {
					resolve(adapterObjects);
				}
			},
		});
	}
}
