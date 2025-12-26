// Small example recording manager for mediasoup + FFmpeg
// Requires: mediasoup >= v3, get-port, ffmpeg installed on server

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
let getPort = null;
try {
  getPort = require('get-port');
  if (getPort && typeof getPort !== 'function' && getPort.default) getPort = getPort.default;
} catch (e) {
  throw new Error('get-port module not found; run `npm install get-port` in server directory');
}

// In-memory recordings map
const recordings = new Map(); // callId -> { ffmpegProc, transports: [PlainTransport], sdpFiles: [] }

function generateSdp({ ip = '127.0.0.1', port, payloadType = 111, codec = 'opus', clockRate = 48000, channels = 2 }) {
  return `v=0
o=- 0 0 IN IP4 ${ip}
s=mediasoup-ffmpeg
c=IN IP4 ${ip}
t=0 0
m=audio ${port} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${codec}/${clockRate}/${channels}
a=rtcp-mux
`;
}

async function startRecording({ callId, router, producers }) {
  if (!callId) throw new Error('callId required');
  if (!router) throw new Error('router required');
  if (!producers || producers.length === 0) throw new Error('no producers to record');

  if (recordings.has(callId)) {
    // If a recording for this callId already exists, verify it's still active and healthy.
    const existing = recordings.get(callId);

    const isExited = existing?.ffmpeg && existing.ffmpeg.exitCode !== null;
    const outPath = existing?.outPath || existing?.filePath;

    let sizeOk = false;
    try {
      if (outPath) {
        const st = fs.statSync(outPath);
        sizeOk = st.size > 44; // at least WAV header + data
      }
    } catch (e) {}

    const isHealthy = existing?.ffmpeg && !isExited && sizeOk;

    if (!isHealthy) {
      console.warn(`[mediasoup-recording] stale recording for ${callId}: exited=${isExited} sizeOk=${sizeOk}. Cleaning up...`);
      try { existing?.transports?.forEach(t => t?.close?.()); } catch {}
      try { existing?.sdpFiles?.forEach(f => { try { fs.unlinkSync(f); } catch {} }); } catch {}
      recordings.delete(callId);
    } else {
      console.warn(`[mediasoup-recording] recording for ${callId} already in progress - returning existing metadata`);
      return { outPath, provider: 'mediasoup-recording', reconciled: true };
    }
  }

  // verify ffmpeg is available
  const ffCheck = spawnSync('ffmpeg', ['-version']);
  if (ffCheck.error || ffCheck.status !== 0) throw new Error('ffmpeg not found or not runnable in PATH; install ffmpeg on the server');

  // recordings directory (configurable)
  const recordingsDir = process.env.RECORDINGS_DIR || __dirname;
  const tmpDir = path.join(recordingsDir, 'tmp');
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const transports = [];
  const consumers = [];
  const sdpFiles = [];
  const inputs = [];

  try {
    // for each producer create a PlainRtpTransport + assign ports, pipe producer to transport
    for (let i = 0; i < producers.length; ++i) {
      const producer = producers[i];

      const rtpPort = await getPort();

      // Create a plain transport (compatible with this mediasoup version)
      const transport = await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1' },
        rtcpMux: true,
        comedia: false
      });

      // connect transport so mediasoup will send RTP to ffmpeg listening at (127.0.0.1:rtpPort)
      await transport.connect({ ip: '127.0.0.1', port: rtpPort });
      console.log(`[recording] transport connected to 127.0.0.1:${rtpPort} (rtcp-mux enabled) for call ${callId} input ${i}`);

      // Create a consumer on the plain transport that consumes from the producer (paused initially)
      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true
      });

      // Store consumer to resume later
      consumers.push(consumer);

      transports.push(transport);

      // derive codec info from consumer.rtpParameters (more reliable)
      const codec = (consumer && consumer.rtpParameters && consumer.rtpParameters.codecs && consumer.rtpParameters.codecs[0]) || {};
      const payloadType = codec.payloadType || codec.payload || 111;
      if (!consumer.rtpParameters || !consumer.rtpParameters.codecs || !consumer.rtpParameters.codecs.length) {
        console.warn(`[recording] consumer for producer ${producer.id} has no rtpParameters.codecs; payloadType fallback to ${payloadType}`);
      }

      const sdp = generateSdp({ port: rtpPort, payloadType, codec: codec.mimeType ? codec.mimeType.split('/')[1] : 'opus', clockRate: codec.clockRate || 48000, channels: codec.channels || 2 });

      const sdpPath = path.join(tmpDir, `${callId}_in${i}.sdp`);
      fs.writeFileSync(sdpPath, sdp);
      console.log(`[recording] wrote SDP ${sdpPath} for call ${callId} input ${i}`);
      sdpFiles.push(sdpPath);

      inputs.push({ sdpPath });
    }

    // Prepare ffmpeg args. If two inputs -> merge with amerge, else single input.
    const outPath = path.join(recordingsDir, `call_${callId}.wav`);

    let ffArgs = ['-y', '-hide_banner', '-loglevel', 'info'];

    inputs.forEach(inp => {
      ffArgs.push('-protocol_whitelist', 'file,udp,rtp,crypto', '-f', 'sdp', '-i', inp.sdpPath);
    });

    if (inputs.length === 1) {
      ffArgs.push('-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '1', outPath);
    } else {
      // mix inputs using amix (works with any number of inputs) and output as stereo WAV
      ffArgs.push('-filter_complex', `amix=inputs=${inputs.length}:duration=longest`, '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2', outPath);
    }

    // spawn ffmpeg with a simple fallback: if one input fails to open, retry without it
    let ff = null;
    let alreadyRetried = false;

    function buildFfArgs(currentInputs) {
      let args = ['-y', '-hide_banner', '-loglevel', 'info'];
      currentInputs.forEach(inp => {
        args.push('-protocol_whitelist', 'file,udp,rtp,crypto', '-f', 'sdp', '-i', inp.sdpPath);
      });

      if (currentInputs.length === 1) {
        args.push('-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '1', outPath);
      } else {
        args.push('-filter_complex', `amix=inputs=${currentInputs.length}:duration=longest`, '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2', outPath);
      }
      return args;
    }

    function spawnFfmpeg(currentInputs) {
      const args = buildFfArgs(currentInputs);
      console.log(`[recording] spawning ffmpeg for call ${callId} with inputs ${currentInputs.map(i=>path.basename(i.sdpPath)).join(', ')}`);
      ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      ff.stdout.on('data', d => console.log(`[ffmpeg ${callId}] ${d.toString()}`));
      ff.stderr.on('data', d => {
        const text = d.toString();
        console.log(`[ffmpeg ${callId}][ERR] ${text}`);

        // detect "Error opening input file <path>" and if we still have >1 input, retry without the failing input
        const m = text.match(/Error opening input file\s+([^\s]+\.sdp)/i);
        if (m && !alreadyRetried && currentInputs.length > 1) {
          alreadyRetried = true;
          // sanitize reported path: strip quotes and trailing punctuation that ffmpeg sometimes prints (e.g., ".")
          let badPath = m[1].trim().replace(/^["'`]+|["'`]+$/g, '');
          badPath = badPath.replace(/[\.,;:\)\]]+$/g, '');
          console.warn(`[recording] ffmpeg reported bad input ${badPath}; retrying without it`);
          try { ff.kill('SIGKILL'); } catch (e) {}

          // restart ffmpeg with inputs that do not match badPath (compare resolved paths)
          const filtered = currentInputs.filter(inp => path.resolve(inp.sdpPath) !== path.resolve(badPath));
          if (filtered.length === 0) {
            console.error('[recording] no remaining inputs after filtering - aborting recording start');
            return;
          }

          setTimeout(() => {
            const newFf = spawnFfmpeg(filtered);
            // update recordings map to point to the new ffmpeg process so stopRecording acts on the right proc
            recordings.set(callId, { ffmpeg: newFf, transports, sdpFiles, outPath });
          }, 250);
        }
      });

      ff.on('error', err => {
        console.error(`[ffmpeg ${callId}] spawn error:`, err);
      });
      ff.on('exit', (code, signal) => console.log(`ffmpeg exited for call ${callId} with code ${code} signal ${signal}`));

      return ff;
    }

    // initial spawn
    ff = spawnFfmpeg(inputs);

    // Resume all consumers after ffmpeg is spawned
    for (const c of consumers) {
      try { await c.resume(); } catch (e) { console.warn('[recording] consumer resume failed', e); }
    }

    // Wait until ffmpeg actually writes something useful to disk (small WAV header alone isn't enough if process exits immediately)
    const waitForOutputFile = (minBytes = 44, timeoutMs = 5000) => new Promise((resolve) => {
      const start = Date.now();
      (function check() {
        fs.stat(outPath, (err, st) => {
          if (!err && st.size > minBytes) return resolve(true);
          if (Date.now() - start > timeoutMs) return resolve(false);
          setTimeout(check, 200);
        });
      })();
    });

    let wrote = await waitForOutputFile(44, 15000);

    if (!wrote) {
      console.warn(`[recording] ffmpeg did not produce output within timeout for call ${callId}; attempting fallback`);

      // If we haven't retried yet and there are multiple inputs, try single-input fallback (pick first input)
      if (!alreadyRetried && inputs.length > 1) {
        alreadyRetried = true;
        try { ff.kill('SIGKILL'); } catch (e) {}
        console.log(`[recording] retrying ffmpeg for call ${callId} with single input ${path.basename(inputs[0].sdpPath)}`);
        const single = [inputs[0]];
        const newFf = spawnFfmpeg(single);

        // wait again for output
        const ok = await waitForOutputFile(44, 15000);
        if (!ok) {
          try { newFf.kill('SIGKILL'); } catch (e) {}
          throw new Error('ffmpeg failed to produce output after fallback attempt');
        }
        // success with fallback; update ff reference
        ff = newFf;
      } else {
        try { ff.kill('SIGKILL'); } catch (e) {}
        throw new Error('ffmpeg failed to produce output file');
      }
    }

    // At this point we have a running ffmpeg that produced output; track it in the map
    recordings.set(callId, { ffmpeg: ff, transports, sdpFiles, outPath });

    console.log(`Recording started for call ${callId}, file: ${outPath}`);

    return { outPath };
  } catch (err) {
    // cleanup on error
    transports.forEach(t => t && t.close && t.close());
    sdpFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    throw err;
  }
}

async function stopRecording(callId) {
  const rec = recordings.get(callId);
  if (!rec) throw new Error('no recording');

  // request FFmpeg to finish gracefully
  try {
    if (rec.ffmpeg.stdin && !rec.ffmpeg.stdin.destroyed) rec.ffmpeg.stdin.end();
  } catch (e) { console.warn(e); }

  try {
    rec.ffmpeg.kill('SIGINT');
  } catch (e) { console.warn(e); }

  // wait for process to exit or timeout
  await new Promise(resolve => {
    let finished = false;
    const onExit = () => { if (!finished) { finished = true; resolve(); } };
    rec.ffmpeg.once('exit', onExit);
    setTimeout(() => { if (!finished) { finished = true; try { rec.ffmpeg.kill('SIGKILL'); } catch (e) {} resolve(); } }, 5000);
  });

  // close transports
  rec.transports.forEach(t => { try { t.close(); } catch (e) {} });

  // remove sdps
  rec.sdpFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });

  recordings.delete(callId);

  console.log(`Recording stopped for call ${callId}`);
}

module.exports = { startRecording, stopRecording };
