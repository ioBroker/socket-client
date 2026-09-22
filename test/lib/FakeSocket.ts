import assert from 'node:assert/strict';

export type Callback = (...args: any[]) => void;

/** Gets the arguments of a request (without the callback) and returns the arguments of the answer */
export type Responder = (...args: any[]) => any[];

export interface Request {
    name: string;
    /** The arguments without the callback */
    args: any[];
    /** Answers the request like the server would. Does nothing if the request had no callback */
    answer: Callback;
}

/**
 * Socket in place of the ws client of ioBroker. Like there, the handlers of an event are called with forEach
 * directly on their array.
 *
 * A request is answered either by the test with `lastAnswer(name)(...)`, or automatically by a responder
 * registered with `respond(name, ...)`. Responders answer asynchronously like a real server.
 */
export class FakeSocket {
    readonly handlers: Record<string, Callback[]> = {};
    readonly requests: Request[] = [];
    readonly responders: Record<string, Responder> = {};
    readonly connected = true;

    /** The URL the connection asked to connect to */
    url?: string;
    /** The options the connection gave to the connect function */
    options?: any;
    closed = false;
    destroyed = false;

    on(name: string, cb: Callback): void {
        (this.handlers[name] ||= []).push(cb);
    }

    off(name: string, cb: Callback): void {
        const pos = this.handlers[name]?.indexOf(cb) ?? -1;
        if (pos !== -1) {
            this.handlers[name].splice(pos, 1);
        }
    }

    emit(name: string, ...args: any[]): boolean {
        const callback: Callback | undefined = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
        this.requests.push({ name, args, answer: callback ?? (() => {}) });

        const responder = this.responders[name];
        if (responder && callback) {
            queueMicrotask(() => callback(...responder(...args)));
        }
        return true;
    }

    /** Answers every following request with this name automatically */
    respond(name: string, responder: Responder): void {
        this.responders[name] = responder;
    }

    /** Simulates an event of the server */
    fire(name: string, ...args: any[]): void {
        this.handlers[name]?.forEach(cb => cb(...args));
    }

    requestsOf(name: string): Request[] {
        return this.requests.filter(request => request.name === name);
    }

    /** The last request with this name. Fails the test if there is none */
    lastRequest(name: string): Request {
        const requests = this.requestsOf(name);
        assert.ok(requests.length, `No "${name}" was requested`);
        return requests[requests.length - 1];
    }

    /** The answer to the last request with this name. Fails the test if there is none */
    lastAnswer(name: string): Callback {
        return this.lastRequest(name).answer;
    }

    clearRequests(): void {
        this.requests.length = 0;
    }

    listenerCount(name: string): number {
        return this.handlers[name]?.length ?? 0;
    }

    connect(): void {}

    close(): void {
        this.closed = true;
    }

    destroy(): void {
        this.destroyed = true;
    }
}
