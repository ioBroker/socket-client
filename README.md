# ioBroker/socket-client

## Description
This library encapsulates the API from ioBroker backend to frontend.

There are 2 connection types in it:
- `Connection` => for all Web Frontends;
- `AdminConnection` => for Admin UI Connections, these have access to more commands.

## Build
`npm run tsc -watch`

## How to use in frontend

- Create Socket instance:
  window.io = new SocketIo();
- build connection:
  const adminConnection = new AdminConnection({ protocol: 'http', host: '192.168.1.2', port: 8081, admin5only: true, autoSubscribes: [] });
  await adminConnection.startSocket();
  await adminConnection.waitForFirstConnection();
  console.log(await adminConnection.getHosts());

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->
### 1.0.10 (2021-12-14)
* (jogibear998) Add TS Version from socket.io from admin ui

### 1.0.9 (2021-12-14)
* (jogibear998) Add ES6 Modules Version

### 1.0.8 (2021-10-30)
* (bluefox) Fixed `getInstalled` command

### 1.0.7 (2021-10-30)
* (bluefox) Improved the vendor support

### 1.0.6 (2021-10-20)
* (AlCalzone) setSystemConfig simplified

### 1.0.5 (2021-09-13)
* (AlCalzone) The package was completely rewritten to make proper use of TypeScript

### 1.0.4 (2021-07-12)
* (bluefox) Fix the renaming of groups

### 1.0.3 (2021-06-10)
* (jogibear9988) Test release

### 1.0.2 (2021-06-10)
* (bluefox) Update methods
* (UncleSamSwiss) Add release script and release workflow

### 1.0.0 (2021-06-08)
* (jogibear9988) Create the Repository from the Code in https://github.com/ioBroker/adapter-react

## License
The MIT License (MIT)

Copyright (c) 2014-2021 bluefox <dogafox@gmail.com>,
