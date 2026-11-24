import net from 'node:net';

const port = Number(process.argv[2]);
const socket = net.connect(port, '127.0.0.1');
process.stdin.pipe(socket);
socket.pipe(process.stdout);
