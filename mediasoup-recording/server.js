// Simple mediasoup bootstrap for demo. Not a full signaling server.
// This demonstrates how to initialize mediasoup, keep producers per call, and call start/stop recording.

const mediasoup = require('mediasoup');
const os = require('os');

const { startRecording, stopRecording } = require('./recordingManager');

// Keep in-memory maps for demo
const calls = new Map(); // callId -> { producers: [Producer] }

let worker, router;

async function startMediasoup() {
  worker = await mediasoup.createWorker({
    rtcMinPort: 10000,
    rtcMaxPort: 10100
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting 2 seconds...');
    setTimeout(() => process.exit(1), 2000);
  });

  // create router supporting opus only (audio-only)
  router = await worker.createRouter({ mediaCodecs: [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2
    }
  ]});

  console.log('Mediasoup router created');
}

// Demo helper to register a producer to a call (in practice this happens when producer is created earlier)
function registerProducer(callId, producer) {
  if (!calls.has(callId)) calls.set(callId, { producers: [] });
  const c = calls.get(callId);
  c.producers.push(producer);
  console.log(`Producer ${producer.id} registered to call ${callId}`);
}

// Demo: call startRecording when there are >=2 producers.
async function tryStartRecordingDemo(callId) {
  const c = calls.get(callId);
  if (!c || c.producers.length < 1) {
    console.log('not enough producers yet');
    return;
  }
  try {
    await startRecording({ callId, router, producers: c.producers });
  } catch (err) {
    console.error('Failed to start recording:', err);
  }
}

// Demo usage: start mediasoup, then you would register producers as they arrive.
// Only auto-start when this file is executed directly. When required as a module, the caller should invoke `startMediasoup()` explicitly.
if (require.main === module) {
  (async () => {
    await startMediasoup();

    // For demonstration we don't create real producers here - integrations typically
    // create WebRtcTransports and producers off an RTCPeerConnection from clients.

    // Placeholder: show API usage
    console.log('\nUsage notes:');
    console.log('- When a client creates a producer and you have the Producer object, call registerProducer(callId, producer)');
    console.log('- When you want to start recording a call, call startRecording({ callId, router, producers })');

    process.on('SIGINT', async () => {
      console.log('closing');
      try { if (worker) await worker.close(); } catch (e) {}
      process.exit(0);
    });
  })();
} else {
  console.log('[mediasoup-recording] module loaded (auto-start disabled)');
}

module.exports = { startMediasoup, registerProducer, startRecording: (opts) => startRecording(opts), stopRecording };
