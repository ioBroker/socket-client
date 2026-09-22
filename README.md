# ioBroker/socket-client

## Description

This library encapsulates the API from ioBroker backend to frontend.

There are 2 connection types in it:

-   `Connection` => for all Web Frontends;
-   `AdminConnection` => for Admin UI Connections, these have access to more commands.

## Build

`npm run build` for one-time builds.
`npm run watch` for continuous builds.

## Tests

`npm test` runs the unit tests of the frontend package (`test/`) and of the backend package (`backend/test/`) with the test runner of Node.js.
The frontend tests replace the socket with a fake one (`test/lib/FakeSocket.ts`), the backend tests talk to a real WebSocket server.

## How to use in frontend

Include the socket library from Admin or Web adapter:

```html
<script src="../lib/js/socket.io.js"></script>
```

Instantiate the connection:

```js
const adminConnection = new AdminConnection({
    protocol: 'ws',
    host: '192.168.1.2',
    port: 8081,
    admin5only: false,
    autoSubscribes: [],
    // optional: other options
});

await adminConnection.startSocket();
await adminConnection.waitForFirstConnection();
// and use it
console.log(await adminConnection.getHosts());
```

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
- (@GermanBluefox) Fixed a connection in the ioBroker cloud getting stuck if it was opened while the ioBroker of the user was not connected to the cloud, e.g. during its restart: every later connect got the same failed answer to `getVersion` from the cache and never authenticated. While the cloud reports `ioBroker is not connected`, the version is asked again every few seconds now, and a failed or interrupted request is not kept in the cache anymore
- (@GermanBluefox) Added unit tests for the frontend and the backend package
- (@GermanBluefox) A failed request is not kept in the cache anymore, the next call asks the server again. Until now e.g. `getEnums`, `getCompactSystemConfig`, `checkFeatureSupported`, `getGroups` or `getHostInfo` returned the same error until `update` was requested. Successful answers are cached as before
- (@GermanBluefox) `doNotLoadAllObjects: false` really loads all objects and passes them to `onReady`; until now `onReady` got an empty list. If the objects cannot be loaded, the error goes to `onError` and `onReady` is called anyway. `getObjects()` without `update` still answers from the cache
- (@GermanBluefox) Fixed subscriptions: `unsubscribeState` unsubscribed at the server also ids that still had other handlers, object subscriptions were sent twice after every reconnect, the state to ignore was subscribed at the server, `unsubscribeFromInstance` without a type sent an empty type, and `subscribeOnInstance` did not settle when the instance answered without a result (it resolves `null` now). An exception of one handler does not stop the other handlers anymore
- (@GermanBluefox) `destroy()` also works before the socket is created and stops the version request, the data loading, the token checks, the token refresh and the reloads of the page. A rejection of the access token during a running token refresh does not reload the page anymore, and broken stored tokens are ignored
- (@GermanBluefox) Fixed small things: `readMetaItems` without rows, `zh-CN` as browser language, the detection of the cloud (`iobroker.internal` is no cloud), socket errors without `toString`, errors thrown inside a request keep their message (`timeout` instead of `Error: timeout`), the data is loaded only once when the server answers slowly
- (@GermanBluefox) AdminConnection: `getInstalledResetCache` and `getRepositoryResetCache` accept a host name, `getRepository` shares the cache of a host name and its object id, `getHostByIp` answers for an unknown IP and rejects on a permission error, short PEM certificates and EC or encrypted private keys are recognized, `upgradeController` and `restartController` reject on a permission error
- (@GermanBluefox) Backend: fixed the query parameters of the URL, an answer without arguments (e.g. of `logout`) does not crash the process anymore, a second `authenticate` does not close the connection anymore, the authenticate timeout and errors of the WebSocket constructor reach the error handlers, the late close of a replaced socket does not close the new connection anymore, "too many attempts" is reported once, no double slash for the URL `/`, invalid messages are ignored, no debug output anymore. New option `callbackTimeout`: a request without answer gets `timeout` after this time (off by default, as before)

### 5.2.3 (2026-09-03)
- (@GermanBluefox) When the server rejects the access token (`reauthenticate`), the connection first tries to get a new one with the refresh token and only goes to the login page if that fails. Until now every `reauthenticate` led to the login page, although the user had asked to stay logged in
- (@GermanBluefox) A failed token refresh no longer throws the tokens away when another tab has renewed them in the meantime (a refresh token can be used only once); the new access token is announced to the server instead. Tokens are only deleted when the server has really rejected the refresh token, a server that cannot be reached leads to a retry
- (@GermanBluefox) Only one refresh request runs at a time, and waiting for the lock of another tab no longer spins synchronously

### 5.2.1 (2026-06-21)
-   (@GermanBluefox) Added support for web-socket-only (socket.io) communication

### 5.2.0 (2026-06-12)
-   (@SimonFischer04) Added socketPath to allow for (web) running behind reverse proxy

### 5.1.4 (2026-06-08)
-   (@GermanBluefox) Extended cmdExec with files
-   (@GermanBluefox) Migrated to TS 6

### 5.1.2 (2026-04-17)
-   (@GermanBluefox) Allowed to call getCompactSystemConfig in web too

### 5.1.1 (2026-02-25)
-   (@GermanBluefox) Updated packages
-   (@bloop16) Better error handling implemented
-   (@bloop16) Added destroy method to close the connection

### 5.0.3 (2025-10-25)
-   (@GermanBluefox) Updated packages
-   (@GermanBluefox) Improved typing

### 5.0.2 (2025-08-30)

-   (@GermanBluefox) Updated packages, e.g. TypeScript 5.9
-   (@GermanBluefox) Added new method: getObjectViewSystemCached

### 5.0.1 (2025-06-21)

-   (@GermanBluefox) Allowed using of this library in Node.js

### 4.1.3 (2025-04-29)

-   (@GermanBluefox) Added debug information

### 4.1.2 (2025-04-01)

-   (@GermanBluefox) Corrected redirect by login

### 4.1.0 (2025-03-05)

-   (@GermanBluefox) Updated packages. TypeScript 5.8

### 4.0.21 (2025-02-28)

-   (@GermanBluefox) Added support for OAuth2 authentication

### 4.0.0 (2024-12-12)

-   (@GermanBluefox) Updated js-controller 7 packages

### 3.1.3 (2024-11-30)

-   (@GermanBluefox) Prevented small possible error by subscribeStates

### 3.1.2 (2024-11-15)

-   (@GermanBluefox) Added the log message type

### 3.1.1 (2024-10-02)

-   (@GermanBluefox) Changed behavior by timeout: do not cache such responses

### 3.1.0 (2024-09-30)
-   (@GermanBluefox) Added new `socket.io` namespace `iob`

### 3.0.1 (2024-09-15)
-   (@GermanBluefox) Migrated to eslint@9
-   (@GermanBluefox) Breaking change: all thrown errors are now instances of `Error` class

### 2.4.18 (2024-06-06)

-   (@GermanBluefox) made protocol and host optional

### 2.4.16 (2024-06-02)

-   (@GermanBluefox) Corrected typing of `CompactInstanceInfo`

### 2.4.14 (2024-05-25)

-   (@GermanBluefox) Corrected typing of cmdExec

### 2.4.13 (2024-05-24)

-   (@GermanBluefox) Corrected upgradeController

### 2.4.12 (2024-05-23)

-   (@GermanBluefox) Added admin functions: upgradeAdapterWithWebserver, upgradeController, upgradeOsPackages, updateLicenses

### 2.4.11 (2024-05-21)

-   (@GermanBluefox) Better typing for subscribeOnInstance

### 2.4.10 (2024-05-16)

-   (@GermanBluefox) Added source files for TypeScript

### 2.4.9 (2024-05-03)

-   (@GermanBluefox) Replaced the SystemConfig type with ioBroker.SystemConfigObject

### 2.4.8 (2024-04-30)

-   (@GermanBluefox) Allowed calling getObjectView, getObjectViewSystem and getObjectViewCustom without options

### 2.4.7 (2024-04-20)

-   (@GermanBluefox) Improved getNotifications command

### 2.4.6 (2024-04-11)

-   (@GermanBluefox) Corrected the object subscribing

### 2.4.3 (2024-04-01)

-   (@GermanBluefox) Corrected types

### 2.4.0 (2024-03-30)

-   (@GermanBluefox) Allowed subscribing and unsubscribing on arrays of IDs

### 2.3.16 (2024-03-16)

-   (@GermanBluefox) Changed systemLang to writable, as it can be changed on the fly

### 2.3.15 (2024-03-08)

-   (foxriver76) fix `cjs` types export
-   (@GermanBluefox) Better typing for getLogs

### 2.3.14 (2024-03-07)

-   (@GermanBluefox) Better typing for getNotifications

### 2.3.13 (2023-12-14)

-   (@GermanBluefox) updated packages

### 2.3.12 (2023-12-04)

-   (foxriver76) port to `@iobroker/types`

### 2.3.11 (2023-10-24)

-   (foxriver76) improve performance on `subscribeState` without wildcard

### 2.3.10 (2023-10-19)

-   (@GermanBluefox) Added return value for `subscribeOnInstance`

### 2.3.9 (2023-09-29)

-   (foxriver76) Corrected import of modules

### 2.3.7 (2023-09-28)

-   (@GermanBluefox) Added implicit export of AdminConnection

### 2.3.6 (2023-09-28)

-   (jogibear9988) Updated Connection api documentation

### 2.3.4 (2023-08-10)

-   (@GermanBluefox) Added `subscribeStateAsync` method for legacy compatibility

### 2.3.3 (2023-08-01)

-   (@GermanBluefox) Added the subscribing on the specific instance messages

### 2.2.1 (2023-07-31)

-   (@GermanBluefox) Update packages

### 2.2.0 (2023-07-07)

-   (@GermanBluefox) added new method - `getObjectsById`

### 2.1.0 (2023-06-14)

-   (rovo89) Typescript types tuning
-   (@GermanBluefox) The path was removed from `socket.io` URL

### 2.0.7 (2023-03-24)

-   (@GermanBluefox) better detection of chained certificates

### 2.0.6 (2023-03-22)

-   (@GermanBluefox) packages updated

### 2.0.5 (2023-03-16)

-   (@GermanBluefox) Added `rename` and `renameFile` methods

### 2.0.4 (2023-02-15)

-   (@GermanBluefox) Made the fix for `material` and `echarts`

### 2.0.2 (2023-02-02)

-   (@GermanBluefox) Caught errors on state/object changes
-   (@GermanBluefox) Special changes for vis and "nothing_selected" ID

### 2.0.1 (2022-12-19)

-   (@GermanBluefox) Added `log` command

### 2.0.0 (2022-11-30)

-   (jogibear9988) Added getObjectViewSystem and getObjectViewCustom and deprecated getObjectView

### 1.1.14 (2022-09-12)

-   (@GermanBluefox) Added support of authentication token

### 1.1.13 (2022-08-30)

-   (@GermanBluefox) Working on cloud connection

### 1.1.12 (2022-08-18)

-   (@GermanBluefox) Added method getCompactSystemRepositories

### 1.1.11 (2022-08-01)

-   (@GermanBluefox) Added ack parameter to `setState` method.

### 1.1.10 (2022-07-05)

-   (@GermanBluefox) Allowed call of getStates with a pattern

### 1.1.9 (2022-07-04)

-   (@GermanBluefox) Errors on connection are handled now

### 1.1.8 (2022-06-22)

-   (@GermanBluefox) Added preparations for iobroker cloud

### 1.1.7 (2022-06-21)

-   (@GermanBluefox) Added functions to reset cache

### 1.1.6 (2022-06-20)

-   (@GermanBluefox) Allowed connections behind reverse proxy

### 1.1.4 (2022-06-19)

-   (@GermanBluefox) Added functions to reset cache

### 1.1.2 (2022-06-17)

-   (@GermanBluefox) Corrected the cache problem by `getInstalled` and `getRepository` commands

### 1.1.1 (2022-06-09)

-   (@GermanBluefox) Allowed connections behind reverse proxy

### 1.1.0 (2022-05-24)

-   (@GermanBluefox) Added methods: subscribeFiles, unsubscribeFiles

### 1.0.12 (2022-05-09)

-   (@GermanBluefox) Extended `getVersion` command with update

### 1.0.11 (2022-03-20)

-   (AlCalzone) corrected: reload on websocket error instead of alert()-ing

### 1.0.10 (2022-01-29)

-   (@GermanBluefox) Added `logout` command
-   (@GermanBluefox) Move `getGroups` to web connection

### 1.0.9 (2021-12-21)

-   (jogibear998) Fix connection with web adapter
-   (jogibear998 & AlCalzone) Convert package to a CommonJS/ESM hybrid

### 1.0.8 (2021-10-30)

-   (@GermanBluefox) Fixed `getInstalled` command

### 1.0.7 (2021-10-30)

-   (@GermanBluefox) Improved the vendor support

### 1.0.6 (2021-10-20)

-   (AlCalzone) setSystemConfig simplified

### 1.0.5 (2021-09-13)

-   (AlCalzone) The package was completely rewritten to make proper use of TypeScript

### 1.0.4 (2021-07-12)

-   (@GermanBluefox) Fix the renaming of groups

### 1.0.3 (2021-06-10)

-   (jogibear9988) Test release

### 1.0.2 (2021-06-10)

-   (@GermanBluefox) Update methods
-   (UncleSamSwiss) Add release script and release workflow

### 1.0.0 (2021-06-08)

-   (jogibear9988) Create the Repository from the Code in https://github.com/ioBroker/adapter-react

## License

The MIT License (MIT)

Copyright (c) 2021-2026 Jochen Kühner
