# ioBroker/socket-client

## Description

This library encapsulates the API from ioBroker backend to frontend.

There are 2 connection types in it:

-   `Connection` => for all Web Frontends;
-   `AdminConnection` => for Admin UI Connections, these have access to more commands.

## Build

`npm run build` for one-time builds.
`npm run watch` for continuous builds.

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
### 4.0.19 (2025-02-28)

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

-   (@GermanBluefox) Added source files for typescript

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

-   (@GermanBluefox) Allowed call of getStates with pattern

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

-   (@GermanBluefox) Corrected cache problem by `getInstalled` and `getRepository` commands

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

Copyright (c) 2021-2025 Jochen Kühner
