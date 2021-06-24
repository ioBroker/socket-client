/** Defines which events are emitted by the server and can be listened on the client */
export interface IOListenEvents {
	objectChange: (id: string, obj: ioBroker.Object) => void;
	stateChange: (id: string, obj: ioBroker.State) => void;
	cmdStdout: (id: string, text: string) => void;
	cmdStderr: (id: string, text: string) => void;
	cmdExit: (id: string, exitCode: number) => void;

	connect: (noTimeout: boolean) => void;
	reconnect: () => void;
	disconnect: () => void;
	reauthenticate: () => void;

	log: (message: string) => void;

	error: (error: Error) => void;
	connect_error: (error: Error) => void;
	permissionError: (error: any) => void; // TODO: check ioBroker.admin/lib/socket.js for the shape of this
}

type GenericCallback<T> = ErrorAsString<ioBroker.GenericCallback<T>>;
type ErrorCallback = ErrorAsString<ioBroker.ErrorCallback>;

type AuthenticateCallback = (isOk: boolean, isSecure: boolean) => void;
type AuthEnabledCallback = (isSecure: boolean, user: string) => void;
export type GetUserPermissionsCallback = (err?: string, acl?: any) => void;
type ErrorAsString<T extends (...args: any[]) => void> = T extends (
	err: Error | null,
	...args: infer U
) => void
	? (err: string | null | undefined, ...args: U) => void
	: T extends (err?: Error | null | undefined, ...args: infer U) => void
	? (err: string | null | undefined, ...args: U) => void
	: never;

type GetBinaryStateCallback = (
	err?: string | null,
	stateBase64?: string,
) => void;
type ReadFile64Callback = (err?: string | null, file?: string) => void;

type GetVersionCallback = (
	err?: string | null,
	version?: string,
	serverName?: string,
) => void;

type GetAdapterNameCallback = (
	err?: string | null,
	serverName?: string,
) => void;

export interface DelObjectOptions {
	maintenance?: boolean;
	user?: string;
}

export interface DelObjectsOptions extends DelObjectOptions {
	recursive?: boolean;
}

/** Defines which events are emitted by the client and can be listened on the server */
export interface IOEmitEvents {
	authenticate(callback: AuthenticateCallback): void;
	authEnabled(callback: AuthEnabledCallback): void;
	getUserPermissions(callback?: GetUserPermissionsCallback): void;

	requireLog(enabled: boolean, callback?: ErrorCallback): void;

	subscribe(pattern: string, callback?: ErrorCallback): void;
	unsubscribe(pattern: string, callback?: ErrorCallback): void;
	subscribeObjects(pattern: string, callback?: ErrorCallback): void;
	unsubscribeObjects(pattern: string, callback?: ErrorCallback): void;

	getObjects(callback?: ErrorAsString<ioBroker.GetObjectsCallback>): void;
	getAllObjects(callback?: ErrorAsString<ioBroker.GetObjectsCallback>): void;
	getObjectView(
		design: string,
		search: string,
		params: ioBroker.GetObjectViewParams | null | undefined,
		callback: ErrorAsString<ioBroker.GetObjectViewCallback>,
	): void;

	delObject:
		| ((
				id: string,
				options: DelObjectOptions,
				callback?: ErrorAsString<ioBroker.GetObjectsCallback>,
		  ) => void)
		| ((
				id: string,
				callback?: ErrorAsString<ioBroker.GetObjectsCallback>,
		  ) => void);
	delObjects:
		| ((
				id: string,
				options: DelObjectsOptions,
				callback?: ErrorAsString<ioBroker.GetObjectsCallback>,
		  ) => void)
		| ((
				id: string,
				callback?: ErrorAsString<ioBroker.GetObjectsCallback>,
		  ) => void);
	setObject(
		id: string,
		val: ioBroker.SettableObject,
		callback?: ErrorCallback,
	): void;
	extendObject(
		id: string,
		objPart: ioBroker.PartialObject,
		callback?: ErrorAsString<ioBroker.SetObjectCallback>,
	): void;
	getObject(
		id: string,
		callback?: ErrorAsString<ioBroker.GetObjectCallback>,
	): void;
	getForeignObjects:
		| ((
				pattern: string,
				type: ioBroker.ObjectType,
				callback: ErrorAsString<ioBroker.GetObjectsCallback>,
		  ) => void)
		| ((
				pattern: string,
				callback: ErrorAsString<ioBroker.GetObjectsCallback>,
		  ) => void);

	getStates(callback?: ErrorAsString<ioBroker.GetStatesCallback>): void;
	getForeignStates(
		pattern: string,
		callback?: ErrorAsString<ioBroker.GetStatesCallback>,
	): void;

	getState(
		id: string,
		callback?: ErrorAsString<ioBroker.GetStateCallback>,
	): void;
	getBinaryState(id: string, callback?: GetBinaryStateCallback): void;

	setState(
		id: string,
		val: ioBroker.State | ioBroker.StateValue | ioBroker.SettableState,
		callback?: ErrorCallback,
	): void;
	setBinaryState(id: string, base64: string, callback?: ErrorCallback): void;

	readDir(
		adapterName: string | null,
		path: string,
		callback: ErrorAsString<ioBroker.ReadDirCallback>,
	): void;
	readFile(
		adapterName: string | null,
		path: string,
		callback: ErrorAsString<ioBroker.ReadFileCallback>,
	): void;
	readFile64(
		adapterName: string | null,
		path: string,
		callback: ReadFile64Callback,
	): void;
	writeFile(
		adapterName: string | null,
		path: string,
		data: string,
		callback: ErrorCallback,
	): void;
	writeFile64(
		adapterName: string | null,
		path: string,
		dataBase64: string,
		callback: ErrorCallback,
	): void;
	deleteFile(
		adapterName: string | null,
		path: string,
		callback: ErrorCallback,
	): void;
	deleteFolder(
		adapterName: string | null,
		path: string,
		callback: ErrorCallback,
	): void;
	fileExists(
		adapterName: string | null,
		path: string,
		callback: GenericCallback<boolean>,
	): void;

	getHistory(
		id: string,
		options: ioBroker.GetHistoryOptions,
		callback: ErrorAsString<ioBroker.GetHistoryCallback>,
	): void;

	getVersion(callback: GetVersionCallback): void;
	getAdapterName(callback: GetAdapterNameCallback): void;

	getCompactSystemConfig(
		callback: ErrorAsString<ioBroker.GetObjectCallback<"system.config">>,
	): void;
	checkFeatureSupported(
		featureName: string,
		callback: GenericCallback<boolean>,
	): void;

	sendTo(
		instance: string,
		command: string,
		data: ioBroker.MessagePayload,
		callback?: (result: ioBroker.Message) => void,
	): void;
	cmdExec(
		hostName: string,
		commandId: string,
		command: string,
		callback?: ErrorCallback,
	): void;
}
