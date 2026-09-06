import http from 'node:http';
import os from 'node:os';
import { createApp } from './app.js';
import { createHttpServer } from './http/routes.js';

const PORT = Number(process.env.PORT || 3030);
const app = createApp();
const handler = createHttpServer(app);

const server = http.createServer(handler);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ERROR: port ${PORT} is already in use. Use PORT=XXXX npm start`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '0.0.0.0', () => {
  const admin = app.auth.listUsers().find(u => u.role === 'owner');
  console.log(`GraySale running at http://localhost:${PORT}`);
  console.log(`Default admin: ${admin?.username} / admin123  (change it!)`);
  const ifaces = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal);
  for (const i of ifaces) console.log(`  LAN: http://${i.address}:${PORT}`);
});