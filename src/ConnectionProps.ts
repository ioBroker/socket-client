export interface ConnectionProps {
	/** The socket name. */
	name?: string;
	/** State IDs to always automatically subscribe to. */
	autoSubscribes?: string[];
	/** Automatically subscribe to logging. */
	autoSubscribeLog?: boolean;
	/** The protocol to use for the socket.io connection. */
	protocol?: string;
	/** The host name to use for the socket.io connection. */
	host?: string;
	/** The port to use for the socket.io connection. */
	port: string | number;
	/** The socket.io connection timeout. */
	ioTimeout?: number;
	/** The socket.io command timeout. */
	cmdTimeout?: number;
	/** Flag to indicate if all objects should be loaded or not. Default true (not loaded) */
	doNotLoadAllObjects?: boolean;
	/** Flag to indicate if AccessControlList for current user will be loaded or not. Default true (not loaded) */
	doNotLoadACL?: boolean;
	/** Progress callback. */
	onProgress?: (progress: number) => void;
	/** Ready callback. */
	onReady?: (objects: Record<string, ioBroker.Object>) => void;
	/** Log callback. */
	onLog?: (text: string) => void;
	/** Error callback. */
	onError?: (error: any) => void;
	/** Object change callback. */
	onObjectChange?: ioBroker.ObjectChangeHandler;
	/** Gets called when the system language is determined */
	onLanguage?: (lang: ioBroker.Languages) => void;
	/** Forces the use of the Compact Methods, wich only exists in admin 5 UI. */
	admin5only?: boolean;
	/** The device UUID with which the communication must be established */
	uuid?: string;
	/** Authentication token (used only in cloud) */
	token?: string;
}
