# Documentation of @iobroker/socket-client

This library connects GUIs of ioBroker (admin, vis, the settings and tabs of adapters) and Node.js tools with an ioBroker server over a websocket.

- `Connection` is for all web frontends, e.g. the pages of a web adapter or vis.
- `AdminConnection` extends `Connection` with the commands of the admin (hosts, adapters, repository, users, ...). It works only with the admin adapter.
- The package `@iobroker/socket-client-backend` provides both classes for Node.js, together with a websocket client.

All methods that ask the server return a promise. The types of all methods and their parameters are part of the package.

**Contents**

- [Connecting](#connecting)
- [Options](#options)
- [Connection state and events](#connection-state-and-events)
- [States](#states)
- [Objects](#objects)
- [`autoSubscribes` and `onObjectChange`](#autosubscribes-and-onobjectchange)
- [Files](#files)
- [Messages to instances](#messages-to-instances)
- [Logs](#logs)
- [History](#history)
- [Commands on a host](#commands-on-a-host)
- [System](#system)
- [Errors, timeouts and caching](#errors-timeouts-and-caching)
- [AdminConnection](#adminconnection)
- [Authentication](#authentication)

## Connecting

### In the browser

The page must load the socket library of the adapter that serves it, e.g. of the admin or the web adapter:

```html
<script src="../lib/js/socket.io.js"></script>
```

Then create the connection:

```ts
import { Connection } from '@iobroker/socket-client';

const connection = new Connection({
    name: 'my-page',
    onReady: () => console.log(`Connected, language: ${connection.systemLang}`),
    onError: error => console.error(error),
});

await connection.waitForFirstConnection();
const state = await connection.getState('system.adapter.admin.0.alive');
```

The constructor starts the connection by itself, you do not have to call `startSocket()`. It waits up to 3 seconds until the socket library is loaded and connects to the server the page came from. Protocol, host and port can be given as [options](#options).

These global variables of the page change how the connection is made:

| Variable                       | Meaning                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `window.socketUrl`             | Connect to this URL instead of the server of the page. The web adapter defines it. Makes `Connection.isWeb()` true |
| `window.socketPath`            | Path that is appended to the URL, e.g. behind a reverse proxy                                                      |
| `window.socketForceWebSockets` | Use only websockets, no long polling (socket.io)                                                                   |
| `window.registerSocketOnLoad`  | A function of the page that calls back when the socket library is loaded, instead of waiting for it                |

### In an adapter GUI

`GenericApp` of [@iobroker/adapter-react-v5](https://github.com/ioBroker/adapter-react-v5) creates the connection and provides it as `this.socket`.

### In Node.js

Use the package [@iobroker/socket-client-backend](../backend/README.md) and give the connection a function that creates the websocket:

```ts
import WebSocket from 'ws';
import { AdminConnection, SocketClient } from '@iobroker/socket-client-backend';

const connection = new AdminConnection({
    name: 'my-tool',
    host: '192.168.1.2',
    port: 8081,
    onReady: () => console.log('ready'),
    connect: (url: string): any => {
        const client = new SocketClient();
        client.connect(url.replace(/^http/, 'ws'), { name: 'my-tool', WebSocket });
        return client;
    },
});
```

Please note: in Node.js an unhandled rejection ends the process by default. Handle the errors of all requests, a lost connection rejects the requests that are on their way.

## Options

| Option                | Default             | Meaning                                                                                                                                               |
| --------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                |                     | Name of the connection, sent to the server                                                                                                            |
| `protocol`            | of the page         | `'http:'`, `'https:'`, `'ws:'` or `'wss:'`                                                                                                            |
| `host`                | of the page         | Host name or IP of the server                                                                                                                         |
| `port`                | of the page         | Port of the server. A page on port 3000 (development server) connects to 8081                                                                         |
| `ioTimeout`           | 20000               | Timeout to connect in ms, at least 20000                                                                                                              |
| `cmdTimeout`          | 5000                | Timeout in ms, at least 5000, of `cmdExec` and of most methods of `AdminConnection`, see [Errors, timeouts and caching](#errors-timeouts-and-caching) |
| `autoSubscribes`      | `[]`                | **Object** ID patterns to subscribe on every connect, see [below](#autosubscribes-and-onobjectchange)                                                 |
| `autoSubscribeLog`    | `false`             | Receive the log messages of ioBroker, see [Logs](#logs)                                                                                               |
| `doNotLoadAllObjects` | `true`              | `false` loads all objects at start and passes them to `onReady`. Can be a lot of data                                                                 |
| `doNotLoadACL`        | `true`              | `false` loads the permissions of the user at start (`connection.acl`)                                                                                 |
| `admin5only`          | `false`             | Use the compact system config of the admin. `onReady` gets no objects then                                                                            |
| `uuid`                |                     | UUID of the device to communicate with                                                                                                                |
| `token`               |                     | Access token to authenticate with                                                                                                                     |
| `tokenTimeoutHandler` |                     | Asked 30 seconds before the access token expires, see [Authentication](#authentication)                                                               |
| `connect`             | `window.io.connect` | Function that creates the socket (Node.js)                                                                                                            |
| `onProgress`          |                     | `(progress: PROGRESS) => void`, see [below](#connection-state-and-events)                                                                             |
| `onReady`             |                     | `(objects) => void`, called once when the connection is ready                                                                                         |
| `onError`             |                     | `(error) => void`. Errors while loading at start and permission errors. Without it, they are written to the console                                   |
| `onLog`               |                     | `(message: LogMessage) => void`, see [Logs](#logs)                                                                                                    |
| `onObjectChange`      |                     | `(id, obj) => void`, see [below](#autosubscribes-and-onobjectchange)                                                                                  |
| `onLanguage`          |                     | `(language) => void`, called with the language of the system                                                                                          |

## Connection state and events

```ts
import { Connection, PROGRESS } from '@iobroker/socket-client';

const connection = new Connection({
    onProgress: progress => {
        if (progress === PROGRESS.CONNECTING) {
            console.log('The connection is lost, it reconnects by itself');
        }
    },
    onReady: objects => console.log(`Ready, the system config is ${objects['system.config'] ? '' : 'not '}loaded`),
});

connection.registerConnectionHandler(connected => console.log(connected ? 'connected' : 'disconnected'));
```

- `onProgress` reports `PROGRESS.CONNECTING` (0) when the connection is lost, `PROGRESS.CONNECTED` (1) when the system config is loaded, `PROGRESS.OBJECTS_LOADED` (2) when all objects are loaded and `PROGRESS.READY` (3) when the connection is ready.
- `onReady(objects)` is called once. `objects` holds `system.config`, all objects with `doNotLoadAllObjects: false`, and nothing with `admin5only: true`.
- `waitForFirstConnection()` resolves after the first authentication, `isConnected()` tells the current state.
- `registerConnectionHandler(handler)` calls the handler with `true` or `false` on every connect and disconnect. `unregisterConnectionHandler(handler)` removes it.
- `connection.systemLang` and `connection.systemConfig` hold the language and the system config, `onLanguage` reports the language.
- The connection reconnects by itself. After the reconnect it subscribes everything again. If the connection dropped before the data was loaded at start, it loads the data after the reconnect.
- `destroy()` closes the connection for good, e.g. when a component is removed. The requests that are on their way are rejected.

## States

### Read and write

```ts
const state = await connection.getState('javascript.0.temperature'); // null if it does not exist
const states = await connection.getStates('javascript.0.*'); // pattern or array of ids
const foreign = await connection.getForeignStates('hm-rpc.0.*.TEMPERATURE');

await connection.setState('javascript.0.temperature', 21.5); // a command: ack = false
await connection.setState('javascript.0.temperature', 21.5, true); // ack = true
await connection.setState('javascript.0.temperature', { val: 21.5, ack: true, q: 0 });
```

### Subscribe

```ts
const handler: ioBroker.StateChangeHandler = (id, state) => {
    console.log(`${id} = ${state?.val}`); // state is null if the state was deleted
};

await connection.subscribeState('javascript.0.temperature', handler);
await connection.subscribeState(['javascript.0.a', 'javascript.0.b'], handler);
await connection.subscribeState('javascript.0.*', handler); // pattern

connection.unsubscribeState('javascript.0.temperature', handler);
connection.unsubscribeState('javascript.0.*'); // all handlers of the pattern
```

- The handler gets the current value right after subscribing, `subscribeState` resolves after that. Then it gets every change.
- The server is asked only once per id, however many handlers there are, and only when the last handler is removed, the id is unsubscribed at the server.
- Subscriptions made before the connection is established, or while it is lost, are sent when it connects. Their handlers get the changes from then on, but not the current value.
- An exception or a rejected promise of a handler is written to the console and does not stop the other handlers.

## Objects

### Read and write

```ts
const obj = await connection.getObject('javascript.0.temperature');

await connection.setObject('javascript.0.temperature', {
    type: 'state',
    common: { name: 'Temperature', type: 'number', role: 'value.temperature', read: true, write: false },
    native: {},
});
await connection.extendObject('javascript.0.temperature', { common: { unit: '°C' } }); // creates it if it does not exist

await connection.delObject('javascript.0.temperature');
await connection.delObjects('javascript.0.myFolder', false); // with all its children
```

Read many objects:

| Method                                             | Result                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `getObjectsById(ids)`                              | The objects with these ids                                                                                                  |
| `getForeignObjects(pattern, type)`                 | The objects of a type that match the pattern, e.g. `getForeignObjects('hm-rpc.0.*', 'channel')`                             |
| `getObjectViewSystem(type, start?, end?)`          | The objects of a type in a range of ids, e.g. `getObjectViewSystem('instance', 'system.adapter.', 'system.adapter.\u9999')` |
| `getObjectViewSystemCached(type, start?, end?)`    | The same, cached                                                                                                            |
| `getObjectViewCustom(design, type, start?, end?)`  | The objects of a custom view                                                                                                |
| `getEnums(name?, update?)`                         | The enums, e.g. `getEnums('rooms')`                                                                                         |
| `getAdapters(name?)`, `getAdapterInstances(name?)` | Adapter and instance objects                                                                                                |
| `getGroups()`                                      | The user groups                                                                                                             |
| `getObjects(update?)`                              | All objects, see below                                                                                                      |

`getObjects()` answers from the objects that the connection already knows: by default only `system.config`. `getObjects(true)` loads all objects of the server. That can be a lot of data, use the methods above if you need only some objects.

### Subscribe

```ts
await connection.subscribeObject('javascript.0.*', (id, obj, oldObj) => {
    if (!obj) {
        console.log(`${id} was deleted`);
    } else {
        console.log(`${id} was changed, the type was ${oldObj?.type ?? 'not known'}`);
    }
});
```

- Unlike `subscribeState`, the handler is not called with the current object.
- `obj` is `null` or `undefined` if the object was deleted. `oldObj` is `{ _id, type }` of the previous object, if the connection knew it.
- `unsubscribeObject(id, handler)` removes the handler, without a handler all handlers of the id.

## `autoSubscribes` and `onObjectChange`

`autoSubscribes` is a list of **object** ID patterns, not state IDs. The connection subscribes them on every connect, and every change of such an object is passed to `onObjectChange`:

```ts
const connection = new Connection({
    autoSubscribes: ['system.adapter.*', 'enum.*'],
    onObjectChange: (id, obj) => {
        // obj is null or undefined if the object was deleted
        console.log(`Object ${id} ${obj ? 'changed' : 'deleted'}`);
    },
});
```

`onObjectChange` is called only for real changes, and also for the objects subscribed with `subscribeObject`. To receive the values of states, use [`subscribeState`](#subscribe).

## Files

The files of ioBroker belong to an adapter or instance, e.g. `vis-2.0` or `admin`:

```ts
const files = await connection.readDir('vis-2.0', 'main');
const { file, mimeType } = await connection.readFile('vis-2.0', 'main/vis-views.json');
const image = await connection.readFile('vis-2.0', 'main/img/logo.png', true); // file is base64

await connection.writeFile64('vis-2.0', 'main/notes.txt', 'Hello'); // a string is written as text
await connection.writeFile64('vis-2.0', 'main/img/logo.png', arrayBuffer); // binary data

await connection.rename('vis-2.0', 'main/old', 'main/new'); // file or folder
await connection.deleteFile('vis-2.0', 'main/notes.txt');
await connection.deleteFolder('vis-2.0', 'main/img');
const exists = await connection.fileExists('vis-2.0', 'main/vis-views.json');

await connection.subscribeFiles('vis-2.0', 'main/*', (id, fileName, size) => {
    console.log(`${id}/${fileName} ${size === null ? 'deleted' : 'changed'}`);
});
```

`unsubscribeFiles(id, pattern, handler?)` removes the handler.

## Messages to instances

```ts
const answer = await connection.sendTo('email.0', 'send', { to: 'me@example.com', text: 'Hello' });
```

`sendTo` resolves with the answer of the instance and waits for it without timeout. An error of the instance is part of the answer, it does not reject.

An instance can also send messages to the GUI, e.g. the pictures of a camera:

```ts
const onPicture = (data: any, sourceInstance: string, messageType: string): void => {
    console.log(`${messageType} from ${sourceInstance}`, data);
};

const result = await connection.subscribeOnInstance('cameras.0', 'startCamera/cam1', { width: 640 }, onPicture);
// result: { accepted, heartbeat, error } or null, if the instance answered without a result

await connection.unsubscribeFromInstance('cameras.0', 'startCamera/cam1', onPicture);
```

## Logs

```ts
const connection = new Connection({
    autoSubscribeLog: true,
    onLog: message => console.log(`${message.severity} ${message.from}: ${message.message}`),
});

// or at any time
await connection.requireLog(true);
connection.registerLogHandler(message => console.log(message.message));

// write to the log of ioBroker
await connection.log('Hello from my page', 'info');
```

## History

```ts
const values = await connection.getHistory('javascript.0.temperature', {
    instance: 'history.0',
    start: Date.now() - 24 * 3_600_000,
    end: Date.now(),
    aggregate: 'minmax',
    count: 100,
});
```

`getHistoryEx` resolves with `{ values, step, sessionId }`.

## Commands on a host

```ts
connection.registerCmdStdoutHandler((id, text) => console.log(text));
connection.registerCmdStderrHandler((id, text) => console.error(text));
connection.registerCmdExitHandler((id, exitCode) => console.log(`exit code ${exitCode}`));

await connection.cmdExec('myHost', 'list adapters', 1);
```

`cmdExec` runs a command of the ioBroker command line on the host, e.g. `'list adapters'` for `iobroker list adapters`. The handlers get the output of all commands, the `id` tells which command it is (the third parameter of `cmdExec`). The user needs the permission to execute commands.

## System

| Method                                       | Result                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `getSystemConfig(update?)`                   | The object `system.config` (`getCompactSystemConfig` for a smaller version) |
| `setSystemConfig(obj)`                       | Writes `system.config`                                                      |
| `getVersion(update?)`                        | `{ version, serverName }` of the server                                     |
| `getUuid()`                                  | UUID of the installation                                                    |
| `getCurrentUser()`                           | The user of the connection                                                  |
| `getIpAddresses(host)`                       | The IP addresses of a host                                                  |
| `getWebServerName()`                         | Name of the adapter that serves the page                                    |
| `checkFeatureSupported(feature)`             | If the js-controller supports a feature, e.g. `'CONTROLLER_CMD_EXEC_FILES'` |
| `logout()`                                   | Logs out the user                                                           |
| `Connection.isWeb()`, `Connection.isCloud()` | If the page runs in a web adapter, or in the ioBroker cloud                 |

## Errors, timeouts and caching

A request that fails rejects its promise. The reason is either an `Error` with one of the messages of `ERRORS`, or the error the server sent, often a string like `'permissionError'`:

```ts
import { ERRORS } from '@iobroker/socket-client';

try {
    await connection.setState('javascript.0.temperature', 21.5);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === ERRORS.NOT_CONNECTED) {
        // try again after the reconnect
    } else if (message === ERRORS.PERMISSION_ERROR) {
        // the user may not write this state
    }
}
```

| `ERRORS`           | Message                   | When                                                                               |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| `NOT_CONNECTED`    | `'notConnectedError'`     | The connection is down, or it dropped while the request was waiting for its answer |
| `TIMEOUT`          | `'timeout'`               | No answer within the timeout (`cmdExec` and most methods of `AdminConnection`)     |
| `PERMISSION_ERROR` | `'permissionError'`       | The user has no permission (the server sends it as a string)                       |
| `NOT_ADMIN`        | `'Allowed only in admin'` | A method of `AdminConnection` in a web adapter                                     |
| `NOT_SUPPORTED`    | `'Not supported'`         | The js-controller does not support the command                                     |

**Lost connection:** a request that is made while the connection is down rejects at once. A request that is waiting for its answer when the connection drops is rejected, too. The server may have executed it already, only the answer is lost. Keep that in mind before you repeat a command like `sendTo` or `cmdExec`.

**Timeouts:** the requests of `Connection` wait for their answer without timeout, except `cmdExec`. Most methods of `AdminConnection` reject after `cmdTimeout` (default 5 seconds), those that ask a host take their own timeout as last parameter. When the connection drops, a waiting request is rejected, so no request waits forever.

**Cache:** some requests are cached: the second call gets the answer of the first one without asking the server. Among them are `getSystemConfig`, `getVersion`, `getEnums`, `getGroups`, `getAdapters`, `getAdapterInstances`, `getIpAddresses`, `checkFeatureSupported` and many methods of `AdminConnection`. Their parameter `update = true` asks the server again. A request that failed is not cached. `resetCache(key)` forgets a cached answer.

## AdminConnection

`AdminConnection` has all methods of `Connection` and the commands of the admin. It works only with the admin adapter: in a web adapter every method rejects with `ERRORS.NOT_ADMIN`.

```ts
import { AdminConnection } from '@iobroker/socket-client';

const connection = new AdminConnection({ port: 8081, admin5only: true });
await connection.waitForFirstConnection();

const hosts = await connection.getCompactHosts();
const info = await connection.getHostInfo(hosts[0]._id);
```

Host names can be given as `'myHost'` or as object id `'system.host.myHost'`.

| Topic                   | Methods                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosts                   | `getHosts`, `getCompactHosts`, `getHostInfo`, `getHostInfoShort`, `getHostByIp`, `getIpAddresses`, `getDiagData`, `readBaseSettings`, `writeBaseSettings`, `restartController`, `upgradeController`, `upgradeOsPackages`                                         |
| Adapters and repository | `getRepository`, `getCompactRepository`, `getInstalled`, `getCompactInstalled`, `getAdapters`, `getCompactAdapters`, `getAdapterInstances`, `getCompactInstances`, `getCompactSystemRepositories`, `getRatings`, `upgradeAdapterWithWebserver`, `updateLicenses` |
| Reset caches            | `getRepositoryResetCache`, `getInstalledResetCache`, `getAdaptersResetCache`, `getAdapterInstancesResetCache`                                                                                                                                                    |
| Logs and notifications  | `getLogs`, `getLogsFiles`, `delLogs`, `getNotifications`, `clearNotifications`                                                                                                                                                                                   |
| Users and groups        | `getUsers`, `getGroups`, `renameGroup`, `changePassword`                                                                                                                                                                                                         |
| Files                   | `chmodFile`, `chownFile`, and the file methods of `Connection`                                                                                                                                                                                                   |
| Security                | `getCertificates`, `encrypt`, `decrypt`                                                                                                                                                                                                                          |
| Admin                   | `getCurrentInstance`, `getCurrentSession`, `getEasyMode`, `getIsEasyModeStrict`                                                                                                                                                                                  |

The methods that ask a host (`getHostInfo`, `getRepository`, `getInstalled`, ...) take a timeout in ms as last parameter, and reject with `'May not read "..."'` if the user has no permission.

## Authentication

The connection uses the login of the page, e.g. of the admin. If the login page stored OAuth2 tokens, the connection renews the access token before it expires, tells the server about the new one and coordinates this with the other tabs of the browser. If the server rejects the token, the connection tries to get a new one before it opens the login page.

`tokenTimeoutHandler` lets the GUI ask the user whether to prolong the session:

```ts
const connection = new Connection({
    tokenTimeoutHandler: async expiresAt => {
        // true: renew the token, false: reload the page when it expires
        return window.confirm(`Your session ends at ${new Date(expiresAt).toLocaleTimeString()}. Stay logged in?`);
    },
});
```

`logout()` logs the user out.
