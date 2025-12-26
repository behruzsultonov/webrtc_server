const fetch = require('node-fetch');

async function main() {
  const url = process.env.URL || 'http://localhost:3500/debug/router-rtp-capabilities';
  console.log('Checking router RTP capabilities at', url);

  try {
    const r = await fetch(url);
    const json = await r.json();
    console.log('Response:', JSON.stringify(json, null, 2));

    if (json && json.ready) {
      console.log('Router is ready');
      process.exit(0);
    } else {
      console.error('Router not ready:', json && json.message ? json.message : 'no message');
      process.exit(2);
    }
  } catch (err) {
    console.error('HTTP check failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

main();