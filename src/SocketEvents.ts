import type { ERRORS } from "./Connection.js";

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

export type GenericCallback<T> = ErrorAsString<ioBroker.GenericCallback<T>>;
export type ErrorCallback = ErrorAsString<ioBroker.ErrorCallback>;

export type AuthenticateCallback = (isOk: boolean, isSecure: boolean) => void;
export type AuthEnabledCallback = (isSecure: boolean, user: string) => void;
export type GetUserPermissionsCallback = (err?: string, acl?: any) => void;
export type ErrorAsString<T extends (...args: any[]) => void> = T extends (
	err: Error | null,
	...args: infer U
) => void
	? (err: string | null | undefined, ...args: U) => void
	: T extends (err?: Error | null | undefined, ...args: infer U) => void
	? (err: string | null | undefined, ...args: U) => void
	: never;

export type GetBinaryStateCallback = (
	err?: string | null,
	stateBase64?: string,
) => void;
export type ReadFile64Callback = (err?: string | null, file?: string) => void;

export type GetVersionCallback = (
	err?: string | null,
	version?: string,
	serverName?: string,
) => void;

export type GetAdapterNameCallback = (
	err?: string | null,
	serverName?: string,
) => void;

export type GetHostByIPCallback = (
	ip: string,
	host: ioBroker.HostObject,
) => void;

export type GenericCallbackNoExtraError<T> = (
	result?: ERRORS.PERMISSION_ERROR | T,
) => void;

export interface DelObjectOptions {
	maintenance?: boolean;
	user?: string;
}

export interface DelObjectsOptions extends DelObjectOptions {
	recursive?: boolean;
}

export interface CompactInstanceInfo {
	adminTab: ioBroker.AdapterCommon["adminTab"];
	name: ioBroker.InstanceCommon["name"];
	icon: ioBroker.InstanceCommon["icon"];
	enabled: ioBroker.InstanceCommon["enabled"];
}

export interface CompactAdapterInfo {
	icon: ioBroker.AdapterCommon["icon"];
	v: ioBroker.AdapterCommon["version"];
	iv?: boolean;
}

export type CompactInstalledInfo = Record<
	string,
	{
		version: string;
	}
>;

export type CompactRepository = Record<
	string,
	{
		icon: ioBroker.AdapterCommon["icon"];
		version: string;
	}
>;

export type CompactHost = {
	_id: ioBroker.HostObject["_id"];
	common: {
		name: ioBroker.HostCommon["name"];
		icon: ioBroker.HostCommon["icon"];
		color: any; // TODO: what's the type of this?
		installedVersion: ioBroker.HostCommon["installedVersion"];
	};
	native: {
		hardware: {
			networkInterfaces?: ioBroker.HostNative["hardware"]["networkInterfaces"];
		};
	};
};

export interface LogFile {
	fileName: string;
	size: number;
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

	sendTo<T = any>(
		instance: string,
		command: string,
		data?: any,
		callback?: (result: T) => void,
	): void;
	cmdExec(
		hostName: string,
		commandId: string,
		command: string,
		callback?: ErrorCallback,
	): void;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export type AdminListenEvents = {};

export interface AdminEmitEvents {
	sendToHost<T = any>(
		hostname: string,
		command: string,
		data?: any,
		callback?: (result: T) => void,
	): void;

	changePassword(
		user: string,
		password: string,
		callback?: ErrorCallback,
	): void;

	getHostByIp(ipOrHostName: string, callback: GetHostByIPCallback): void;

	encrypt(plaintext: string, callback: GenericCallback<string>): void;
	decrypt(ciphertext: string, callback: GenericCallback<string>): void;

	chmodFile(
		adapter: string | null,
		path: string,
		options?: { mode: number | string },
		callback?: ErrorAsString<ioBroker.ChownFileCallback>,
	): void;
	chownFile(
		adapter: string | null,
		path: string,
		options?: { owner: string; ownerGroup: string },
		callback?: ErrorAsString<ioBroker.ChownFileCallback>,
	): void;

	getIsEasyModeStrict(callback: GenericCallback<boolean>): void;
	getEasyMode(
		callback: GenericCallback<{
			strict: boolean;
			configs: any[];
		}>,
	): void;

	// TODO: What's the return type here?
	getRatings(update: boolean, callback: GenericCallback<any>): void;

	getCurrentInstance(callback: GenericCallback<string>): void;
	getAdapters(
		adapterName: string | null | undefined,
		callback: GenericCallback<ioBroker.AdapterObject[]>,
	): void;
	getAdapterInstances(
		adapterName: string | null | undefined,
		callback: GenericCallback<ioBroker.InstanceObject[]>,
	): void;
	getCompactInstances(
		callback: GenericCallback<Record<string, CompactInstanceInfo>>,
	): void;
	getCompactAdapters(
		callback: GenericCallback<Record<string, CompactAdapterInfo>>,
	): void;
	getCompactInstalled(
		host: string,
		callback: GenericCallbackNoExtraError<CompactInstalledInfo>,
	): void;
	getCompactRepository(
		host: string,
		callback: GenericCallbackNoExtraError<CompactRepository>,
	): void;
	getCompactHosts(callback: GenericCallback<CompactHost[]>): void;

	readLogs(host: string, callback: GenericCallback<LogFile[]>): void;
}
