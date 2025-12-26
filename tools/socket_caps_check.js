const io = require('socket.io-client');

async function main() {
  const argUrl = process.argv[2];
  const url = argUrl || process.env.URL || 'http://localhost:3500';
  console.log('Connecting to socket at', url);
  const socket = io(url, { transports: ['websocket'] });

  socket.on('connect', () => {
    console.log('Socket connected, id=', socket.id);
    socket.emit('get-router-rtp-capabilities');

    socket.once('router-rtp-capabilities', (data) => {
      console.log('router-rtp-capabilities:', data);
      socket.close();
      process.exit(data && data.ready ? 0 : 2);
    });

    setTimeout(() => {
      console.error('Timeout waiting for router-rtp-capabilities');
      socket.close();
      process.exit(1);
    }, 5000);
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connect error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

main();