// Self-test for server recording: sends a tone via ffmpeg RTP sender and records it using the same SDP-based FFmpeg reader.
// Usage: node selftest.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
let getPort = null;
try {
  getPort = require('get-port');
  if (getPort && typeof getPort !== 'function' && getPort.default) getPort = getPort.default;
} catch (e) {
  throw new Error('get-port module not found; run `npm install get-port` in server directory');
}

(async () => {
  try {
    // pick ports
    const rtpPort = await getPort();
    const rtcpPort = await getPort();

    console.log('Selected ports', { rtpPort, rtcpPort });

    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const sdpPath = path.join(tmpDir, `selftest_in.sdp`);
    const payloadType = 111;

    // Use a dedicated recorder port and a probe port; the probe will receive RTP from sender and forward to recorder
    const recorderPort = await getPort();
    const probePort = rtpPort;

    // Bind the recorder SDP to 127.0.0.1 to ensure proper localhost communication
    const recorderAddr = process.env.SELFTEST_REC_ADDR || '127.0.0.1';

    const sdp = `v=0
o=- 0 0 IN IP4 ${recorderAddr}
s=mediasoup-ffmpeg-selftest
c=IN IP4 ${recorderAddr}
t=0 0
m=audio ${recorderPort} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} opus/48000/1
`;

    fs.writeFileSync(sdpPath, sdp);
    console.log('Wrote SDP to', sdpPath, 'recorderAddr=', recorderAddr, 'recorderPort=', recorderPort, 'probePort=', probePort);

    const outPath = path.join(__dirname, `call_selftest.wav`);

    // Start ffmpeg recorder (reads from SDP). Use quiet mode by default; enable verbose with SELFTEST_VERBOSE=1
    const VERBOSE = !!process.env.SELFTEST_VERBOSE;
    const recorderLogLevel = VERBOSE ? 'debug' : 'info';
    const recorderArgs = ['-y', '-protocol_whitelist', 'file,udp,rtp', '-hide_banner', '-loglevel', recorderLogLevel, '-i', sdpPath, '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '1', outPath];
    const recorder = spawn('ffmpeg', recorderArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    recorder.stdout.on('data', d => {
      const s = d.toString();
      if (VERBOSE) console.log('[recorder]', s);
      // Always print key hints about RTP/packet status even when not verbose
      if (/RTP: Received/.test(s) || /received\s+no\s+packets/i.test(s) || /Nothing was written into output file/.test(s) || /Error opening input file/i.test(s)) {
        console.warn('[recorder][HINT]', s.split('\n').slice(0,2).join(' | '));
      }
    });
    recorder.stderr.on('data', d => {
      const s = d.toString();
      if (VERBOSE) console.log('[recorder][ERR]', s);
      if (/RTP: Received/.test(s) || /received\s+no\s+packets/i.test(s) || /Nothing was written into output file/.test(s) || /Error opening input file/i.test(s)) {
        console.warn('[recorder][HINT]', s.split('\n').slice(0,2).join(' | '));
      }
    });
    recorder.on('exit', code => {
      console.log('recorder exited', code);
    });

    // Give recorder a longer moment to bind its UDP socket and be ready to receive
    await new Promise(r => setTimeout(r, 1000));

    // Start a tiny UDP relay: listen on probePort and forward packets to recorderPort
    const dgram = require('dgram');
    const relay = dgram.createSocket('udp4');
    relay.on('error', (err) => { console.warn('relay error', err && err.message ? err.message : err); relay.close(); });
    relay.on('message', (msg, rinfo) => {
      // forward to recorder
      relay.send(msg, 0, msg.length, recorderPort, '127.0.0.1');
    });

    // Bind relay; allow overriding bind address to handle Docker/namespace cases
    // Default to 0.0.0.0 for better compatibility with containers and host networking
    const bindAddr = process.env.SELFTEST_BIND_ADDR || '0.0.0.0';

    // Counters for diagnostics
    let relayReceived = 0;
    let relayForwarded = 0;
    let lastStatsReceived = 0;
    let lastStatsForwarded = 0;

    await new Promise((resolve, reject) => {
      relay.bind(probePort, bindAddr, () => { console.log('Relay bound on probePort', probePort, 'bindAddr', bindAddr); resolve(); });
    });

    // Log forwarded packet counts periodically (only when numbers change)
    const statsInterval = setInterval(() => {
      if (relayReceived !== lastStatsReceived || relayForwarded !== lastStatsForwarded) {
        console.log(`[relay][STATS] received=${relayReceived} forwarded=${relayForwarded}`);
        lastStatsReceived = relayReceived;
        lastStatsForwarded = relayForwarded;
      }
    }, 2000);

    // Print brief diagnostics for the first few packets to confirm RTP shape, then keep quiet
    const MAX_VERBOSE_RELAY = VERBOSE ? Infinity : 5;

    relay.on('message', (msg, rinfo) => {
      relayReceived++;

      // Detect RTP-like packets (RTP version 2 in high two bits)
      const isRtp = (msg && msg.length > 0) ? ((msg[0] >> 6) === 2) : false;
      if (relayReceived <= MAX_VERBOSE_RELAY) {
        // Print basic info and first 12 bytes in hex for diagnostics
        const head = Array.prototype.slice.call(msg, 0, 12).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`[relay] recv len=${msg.length} from ${rinfo.address}:${rinfo.port} rtp=${isRtp} head=${head}`);
      }

      const targetAddr = process.env.SELFTEST_REC_ADDR || '127.0.0.1';
      relay.send(msg, 0, msg.length, recorderPort, targetAddr, (err, bytes) => {
        if (err) {
          console.warn('[relay] send error', err && err.message ? err.message : err, { from: rinfo, to: { port: recorderPort, addr: targetAddr } });
        } else {
          relayForwarded++;
          if (relayForwarded <= MAX_VERBOSE_RELAY) console.log(`[relay] forwarded ${bytes} bytes to ${targetAddr}:${recorderPort} rtp=${isRtp}`);
        }
      });
    });

    // Ensure we stop the interval after the test
    const stopStatsInterval = () => {
      try { clearInterval(statsInterval); } catch (e) { /* ignore */ }
    };
    relay.on('close', () => stopStatsInterval());

    // Start ffmpeg sender (generates tone and sends RTP to probePort) with debug logs
    // We use libopus to produce opus payload with payload_type=111
    const senderArgs = ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-ac', '1', '-c:a', 'libopus', '-loglevel', 'debug', '-f', 'rtp', `rtp://127.0.0.1:${probePort}?payload_type=${payloadType}`];
    const sender = spawn('ffmpeg', senderArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    sender.stdout.on('data', d => {
      const s = d.toString();
      if (VERBOSE) console.log('[sender]', s);
    });
    sender.stderr.on('data', d => {
      const s = d.toString();
      if (VERBOSE || /Error|failed|RTP:|Warning|could not/i.test(s)) {
        console.log('[sender][ERR]', s.split('\n').slice(0,2).join(' | '));
      }
    });
    sender.on('exit', code => console.log(`sender exited ${code}`));

    console.log('Recording for 12 seconds...');
    await new Promise(r => setTimeout(r, 12000));

    // stop sender then recorder, wait a bit
    try { sender.kill('SIGINT'); } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
    try { recorder.kill('SIGINT'); } catch (e) {}

    // wait for a short time to ensure file is flushed
    await new Promise(r => setTimeout(r, 1000));

    if (fs.existsSync(outPath)) {
      const stats = fs.statSync(outPath);
      console.log('Selftest recorded file:', outPath, 'size:', stats.size);
    } else {
      console.error('Selftest failed: output file not found');
    }

    // cleanup sdp
    try { fs.unlinkSync(sdpPath); } catch (e) {}
  } catch (err) {
    console.error('Selftest error', err);
    process.exit(1);
  }
})();
