// export type ListenEventHandler =
// 	// Add more overloads as necessary
// 	| ((arg1: any, arg2: any, arg3: any, arg4: any, arg5: any) => void)
// 	| ((arg1: any, arg2: any, arg3: any, arg4: any) => void)
// 	| ((arg1: any, arg2: any, arg3: any) => void)
// 	| ((arg1: any, arg2: any) => void)
// 	| ((arg1: any) => void)
// 	| ((...args: any[]) => void);

import type { IOEmitEvents, IOListenEvents } from "./SocketEvents";

export interface ConnectOptions {
	/** Timeout for answer for ping (pong) */
	pongTimeout?: number;
	/** Ping interval */
	pingInterval?: number;
	/** connection request timeout */
	connectTimeout?: number;
	/** Authentication timeout */
	authTimeout?: number;
	/** Interval between connection attempts */
	connectInterval?: number;
	/** Every connection attempt the interval increasing at options.connectInterval till max this number */
	connectMaxAttempt?: number;
}

export type EventHandlers = Record<string, (...args: any[]) => void>;

export type ListenEventHandler<T extends any[] = any[]> = (...args: T) => void;

export type EmitEventHandler<
	TSent extends any[] = any[],
	TCallback extends any[] = any[],
> = (...args: TSent[], callback?: (...args: TCallback[]) => void) => void;

export interface SocketClient<
	TListenEvents extends Record<
		keyof TListenEvents,
		ListenEventHandler
	> = Record<string, never>,
	TEmitEvents extends Record<keyof TEmitEvents, EmitEventHandler> = Record<
		string,
		never
	>,
> {
	connect(url?: string, options?: ConnectOptions): void;
	close(): void;
	destroy(): void;

	readonly connected: boolean;

	on<TEvent extends keyof IOListenEvents>(
		event: TEvent,
		callback: IOListenEvents[TEvent],
	): void;
	on<TEvent extends keyof TListenEvents>(
		event: TEvent,
		callback: TListenEvents[TEvent],
	): void;
	off<TEvent extends keyof IOListenEvents>(
		event: TEvent,
		callback: IOListenEvents[TEvent],
	): void;
	off<TEvent extends keyof TListenEvents>(
		event: TEvent,
		callback: TListenEvents[TEvent],
	): void;

	emit<TEvent extends keyof TEmitEvents>(
		event: TEvent,
		...args: Parameters<TEmitEvents[TEvent]>
	): boolean;
	emit<TEvent extends keyof IOEmitEvents>(
		event: TEvent,
		...args: Parameters<IOEmitEvents[TEvent]>
	): boolean;
}
