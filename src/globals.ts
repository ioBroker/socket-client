import type { Socket } from 'socket.io'

export { };

declare global {
  interface Window {
    io: { connect: (name: string, par: any) => Socket };
    socketUrl: string;
    registerSocketOnLoad: Function;
  }

  interface Navigator {
    userLanguage: string;
  }
}