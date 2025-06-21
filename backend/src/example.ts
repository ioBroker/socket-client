import WebSocket from 'ws';
import { AdminConnection } from '@iobroker/socket-client';
import { SocketClient } from './socket.io';

const socket = new AdminConnection({
    name: 'Backend Test Client',
    host: 'localhost',
    port: 5680,
    doNotLoadAllObjects: true,
    doNotLoadACL: true,
    onProgress: progress => console.log(`Progress: ${progress}`),
    onReady: async _objects => {
        console.log(`Ready with ${Object.keys(_objects).length} objects`);
        const objects = await socket.getObjects(true);
        console.log('Received objects:', Object.keys(objects).length);
        void socket.subscribeState('system.adapter.admin.0.cputime', (id, state) => {
            console.log(`State changed for ${id}:`, state);
        });
    },
    onLog: message => console.log(`Log: ${message.message}`),
    onError: error => console.error(`Error: ${error}`),
    connect: (url: string): any => {
        const socketClient = new SocketClient();
        socketClient.connect(url.replace(/^http/, 'ws'), {
            name: 'TestClient',
            pongTimeout: 10000,
            pingInterval: 5000,
            connectTimeout: 5000,
            authTimeout: 5000,
            connectInterval: 1000,
            connectMaxAttempt: 10,
            WebSocket,
        });
        return socketClient;
    },
});
socket.registerConnectionHandler(isConnected => {
    console.log(`Socket connection status: ${isConnected ? 'connected' : 'disconnected'}`);
});
