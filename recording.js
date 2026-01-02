// Import required modules
const mediasoup = require('mediasoup');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
// Import get-port for dynamic port allocation
let getPort = null;
try {
  getPort = require('get-port');
  if (getPort && typeof getPort !== 'function' && getPort.default) getPort = getPort.default;
} catch (e) {
  console.error('get-port module not found; run `npm install get-port` in server directory');
  throw e;
}

// Mediasoup worker and router
let worker;
let router;

// Active rooms and recordings
const rooms = new Map();
const activeRecordings = new Map();

// Recording directory
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const TEMP_DIR = path.join(__dirname, 'temp');

// Optional robust recording manager (FFmpeg + mediasoup pipe)
let remoteRecorder;
try {
  remoteRecorder = require('./mediasoup-recording/recordingManager');
  console.log('[recording] using mediasoup-recording only');
} catch (e) {
  console.warn('mediasoup-recording/recordingManager not available:', e && e.message ? e.message : e);
}

// Initialize directories
async function initDirectories() {
  try {
    await fs.access(RECORDINGS_DIR);
  } catch {
    await fs.mkdir(RECORDINGS_DIR, { recursive: true });
  }
  
  try {
    await fs.access(TEMP_DIR);
  } catch {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  }
}

/**
 * Initialize mediasoup worker
 */
async function initializeWorker() {
  try {
    // Ensure directories exist before starting worker
    await initDirectories();
    
    worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
      ],
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    });

    worker.on('died', () => {
      console.error('Mediasoup worker died');
      process.exit(1);
    });

    // Create router with Opus codec for audio only
    router = await worker.createRouter({
      mediaCodecs: [
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
      ],
    });

    console.log('Mediasoup worker initialized');
  } catch (error) {
    console.error('Failed to initialize mediasoup worker:', error);
    throw error;
  }
}

/**
 * Create a room for a call
 */
function createRoom(roomId) {
  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }

  const room = {
    id: roomId,
    router: router,
    producers: new Map(),
    consumers: new Map(),
    transports: new Map(),
  };

  rooms.set(roomId, room);
  return room;
}

/**
 * Create RTP stream consumer for recording
 */
// This function is no longer used in mediasoup-only recording mode
async function createRtpStreamConsumer(room, producer) {
  console.error('createRtpStreamConsumer should not be called in mediasoup-only recording mode');
  throw new Error('createRtpStreamConsumer is deprecated in mediasoup-only recording mode');
}

/**
 * Create recording process (FFmpeg wrapper)
 */
function createRecordingProcess(streamInfo, filename) {
  try {
    console.error('createRecordingProcess should not be called in mediasoup-only recording mode');
  throw new Error('createRecordingProcess is deprecated in mediasoup-only recording mode');
  } catch (error) {
    console.error('Error creating recording process:', error);
    throw error;
  }
}

/**
 * Create WebRTC transport for signaling
 */
async function createWebRtcTransport(room) {
  try {
    const transport = await room.router.createWebRtcTransport({
      listenIps: [
        {
          ip: process.env.WEBRTC_LISTEN_IP || '0.0.0.0',
          announcedIp: process.env.WEBRTC_ANNOUNCED_IP || undefined,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });

    room.transports.set(transport.id, transport);
    return transport;
  } catch (error) {
    console.error('Error creating WebRTC transport:', error);
    throw error;
  }
}

/**
 * Create PlainTransport for recording
 */
async function createPlainTransport(room) {
  try {
    const transport = await room.router.createPlainTransport({
      listenIp: {
        ip: process.env.WEBRTC_LISTEN_IP || '127.0.0.1',
      },
      rtcpMux: true,
      comedia: false,
    });

    room.transports.set(transport.id, transport);
    return transport;
  } catch (error) {
    console.error('Error creating PlainTransport:', error);
    throw error;
  }
}

/**
 * Handle producer (audio track from client)
 */
async function handleProduce(room, transportId, kind, rtpParameters) {
  try {
    const transport = room.transports.get(transportId);
    if (!transport) {
      throw new Error('Transport not found');
    }

    // Validate rtpParameters early to avoid mediasoup transport.produce TypeError: empty codecs
    if (!rtpParameters || !rtpParameters.codecs || !rtpParameters.codecs.length) {
      throw new Error('Invalid rtpParameters: empty codecs');
    }
    
    // Validate that the codecs are for audio/opus as expected
    const validCodecs = rtpParameters.codecs.every(codec => {
      return codec.mimeType && 
             codec.mimeType.toLowerCase().includes('audio') && 
             (codec.mimeType.toLowerCase().includes('opus') || codec.payloadType === 111);
    });
    
    if (!validCodecs) {
      console.warn(`[recording] Invalid codec format detected:`, rtpParameters.codecs.map(c => ({ mime: c.mimeType, payload: c.payloadType })));
      throw new Error('Invalid rtpParameters: codecs must be audio/opus format');
    }

    const producer = await transport.produce({
      kind,
      rtpParameters,
    });

    // concise debug log for producer creation
    const codecSummary = (rtpParameters && rtpParameters.codecs) ? rtpParameters.codecs.map(c => ({ mime: c.mimeType, payload: c.payloadType })) : [];
    console.log(`[recording] producer created: id=${producer.id} kind=${kind} codecs=${JSON.stringify(codecSummary)}`);
    
    // Store the producer
    room.producers.set(producer.id, producer);
    
    // Verify that the stored producer has the correct kind
    const storedProducer = room.producers.get(producer.id);
    console.log(`[recording] Stored producer ${producer.id} has kind: ${storedProducer.kind}, expected: ${kind}`);
    
    return producer;
  } catch (error) {
    console.error('[recording] Error handling produce:', error && error.message ? error.message : error);
    throw error;
  }
}

// This function is no longer used in mediasoup-only recording mode
async function createRecordingConsumer(room, producerId) {
  console.error('createRecordingConsumer should not be called in mediasoup-only recording mode');
  throw new Error('createRecordingConsumer is deprecated in mediasoup-only recording mode');
}

/**
 * Start recording for a call
 */
async function waitForProducers(room, timeoutMs = 10000, intervalMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (room && room.producers && room.producers.size > 0) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function startRecording(callId) {
  try {
    console.log(`Starting recording for call: ${callId}`);
    
    // Check if recording already exists for this callId
    if (activeRecordings.has(callId)) {
      const existing = activeRecordings.get(callId);
      console.log(`Recording already exists for call ${callId}, returning existing`);
      return existing;
    }

    // Get or create room
    let room = rooms.get(callId);
    if (!room) {
      console.log(`Room ${callId} not found, creating new room`);
      room = createRoom(callId);
    }

    console.log(`Room ${callId} has ${room.producers.size} producers`);
    
    // Debug: log the full structure of all producers
    for (const [producerId, producer] of room.producers) {
      console.log(`Producer ${producerId} full structure:`, {
        id: producer.id,
        kind: producer.kind,
        type: typeof producer,
        hasKind: 'kind' in producer,
        keys: Object.keys(producer).slice(0, 10), // first 10 keys
        kindType: typeof producer.kind,
        kindValue: producer.kind
      });
    }
    
    // If no producers right now, wait briefly for them to appear
    if (room.producers.size === 0) {
      console.warn(`[recording] No producers found in room ${callId} for recording - waiting up to 10s for producers to appear`);
      const appeared = await waitForProducers(room, 10000, 250);
      if (!appeared) {
        console.warn(`[recording] Timeout waiting for producers in room ${callId}`);
        // Return a retryable error object so socket handler can reply accordingly
        return { error: 'Cannot start recording - no audio producers available', retryable: true };
      }
      console.log(`[recording] Producers appeared for room ${callId}, continuing start`);
    }

    // Validate callId
    if (!callId) {
      console.error('[recording] startRecording: callId is required');
      return { error: 'callId is required', retryable: false };
    }
    
    // Validate that remoteRecorder is available
    if (!remoteRecorder || typeof remoteRecorder.startRecording !== 'function') {
      console.error('[recording] Recording service unavailable. mediasoup-recording not initialized.');
      return { error: 'Recording service unavailable. mediasoup-recording not initialized.', retryable: false };
    }
    
    // Filter for audio producers only and take only the last 2 (to avoid 19-input FFmpeg scenarios)
    const allProducers = Array.from(room.producers.values());
    console.log(`[recording] All producers before filtering:`, allProducers.map(p => ({ id: p.id, kind: p.kind }))); 
    const allAudioProducers = allProducers.filter(producer => {
      const isAudio = producer.kind === 'audio';
      console.log(`[recording] Producer ${producer.id} kind check: ${producer.kind} === 'audio' -> ${isAudio}`);
      return isAudio;
    });
    
    // Take only the last 2 audio producers to avoid overloading FFmpeg with too many inputs
    const audioProducers = allAudioProducers.slice(-2);
    console.log(`[recording] Selected ${audioProducers.length} producers for recording out of ${allAudioProducers.length} available:`, audioProducers.map(p => ({ id: p.id, kind: p.kind })));
    
    console.log(`[recording] Found ${allProducers.length} total producers, ${audioProducers.length} audio producers for call ${callId}`);
    
    if (audioProducers.length < 2) {
      console.warn(`[recording] Need 2 audio producers for call ${callId}, but only found ${audioProducers.length}, cannot start recording`);
      return { error: 'Need 2 audio producers (both peers must publish to server)', retryable: true };
    }
    
    console.log(`[recording] Starting recording for call ${callId} with ${audioProducers.length} audio producers`);
    
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('remoteRecorder.startRecording timed out')), 30000); // 30 second timeout
    });
    
    const fileName = `call_${callId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`;
    
    const rr = await Promise.race([
      remoteRecorder.startRecording({ callId, router: room.router, producers: audioProducers, fileName }),
      timeoutPromise
    ]);
    
    // Normalize response: rr may contain outPath
    const recording = {
      callId,
      startTime: Date.now(),
      outPath: rr && rr.outPath ? rr.outPath : null,
      fileName,
      provider: 'mediasoup-recording',
    };
    
    activeRecordings.set(callId, recording);
    console.log(`[recording] Started recording (delegated) for call ${callId}, out=${recording.outPath}`);
    return recording;
  } catch (error) {
    console.error('Error starting recording:', error, error.stack);
    throw error;
  }
}

/**
 * Stop recording for a call
 */
async function stopRecording(callId) {
  try {
    console.log(`Stopping recording for call: ${callId}`);
    
    const recording = activeRecordings.get(callId);
    if (!recording) {
      console.warn(`Recording not found for call ${callId}`);
      // Return a default response instead of throwing an error
      return {
        callId,
        duration: 0,
        downloadUrl: null,
        message: 'No recording was found for this call'
      };
    }

    // Validate callId
    if (!callId) {
      console.error('[recording] stopRecording: callId is required');
      return { callId, duration: 0, downloadUrl: null };
    }
    
    // Validate that remoteRecorder is available
    if (!remoteRecorder || typeof remoteRecorder.stopRecording !== 'function') {
      console.error('[recording] Recording service unavailable. mediasoup-recording not initialized.');
      return { callId, duration: 0, downloadUrl: null };
    }
    
    console.log(`[recording] Stopping recording for call ${callId}`);
    
    try {
      await remoteRecorder.stopRecording(callId);

      // outPath is usually located in mediasoup-recording dir (e.g., call_<callId>.wav)
      const expectedOut =
        recording.outPath ||
        (recording.fileName ? path.join(__dirname, 'mediasoup-recording', recording.fileName)
                          : path.join(__dirname, 'mediasoup-recording', `call_${callId}.wav`));
      
      // Wait for the WAV file to actually appear on disk (poll for 4 seconds)
      const maxWaitTime = 4000; // 4 seconds
      const pollInterval = 100; // 100ms between checks
      const startTime = Date.now();
      
      while (Date.now() - startTime < maxWaitTime) {
        try {
          await fs.access(expectedOut);
          // File exists, break out of the loop
          break;
        } catch (e) {
          // File doesn't exist yet, wait and try again
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
      }
      
      // If file still doesn't exist after waiting, return a retryable error
      try {
        await fs.access(expectedOut);
      } catch (e) {
        console.warn('[recording] File did not appear after stop, returning retryable error');
        return { callId, duration: Date.now() - recording.startTime, error: 'File did not appear after stop', retryable: true };
      }

      // Ensure recordings dir exists
      try { await fs.access(RECORDINGS_DIR); } catch { await fs.mkdir(RECORDINGS_DIR, { recursive: true }); }

      const fileName = path.basename(expectedOut);
      const finalPath = path.join(RECORDINGS_DIR, fileName);

      // Move file to recordings dir (copy then delete original if present)
      try {
        await fs.copyFile(expectedOut, finalPath);
      } catch (e) {
        console.warn('[recording] copy of out file failed:', e && e.message ? e.message : e);
      }

      // Check file size to ensure it's not empty
      try {
        const st = await fs.stat(finalPath);
        if (st.size <= 44) { // 44 bytes is the size of a minimal WAV header
          console.error(`[recording] output file is empty: ${finalPath} size=${st.size}`);
          return { callId, duration: Date.now() - recording.startTime, downloadUrl: null, error: 'Recorded file is empty', retryable: true };
        }
      } catch (e) {
        console.error(`[recording] could not stat output file: ${finalPath}`, e.message);
      }

      // Clean up any temp sdp files or intermediate files is handled by remoteRecorder

      const duration = Date.now() - recording.startTime;
      activeRecordings.delete(callId);

      const downloadUrl = `/recordings/${fileName}`;
      console.log(`[recording] Stopped delegated recording for ${callId}, file=${finalPath} duration=${duration}ms`);

      return { callId, duration, downloadUrl };
    } catch (err) {
      console.error('[recording] remoteRecorder.stopRecording failed:', err && err.message ? err.message : err, err.stack);
      
      const duration = Date.now() - recording.startTime;
      activeRecordings.delete(callId);
      
      // Return the expected file path if available
      const fileName = recording.outPath ? path.basename(recording.outPath) :
                   recording.fileName ? recording.fileName :
                   `call_${callId}.wav`;
      const downloadUrl = `/recordings/${fileName}`;
      
      return { callId, duration, downloadUrl };
    }
  } catch (error) {
    console.error('Error stopping recording:', error);
    throw error;
  }
}





/**
 * Make recording available for client download
 */
async function makeRecordingAvailable(filePath, callId) {
  try {
    // Move the final recording to the recordings directory
    const fileName = path.basename(filePath);
    const finalPath = path.join(RECORDINGS_DIR, fileName);
    
    // Copy the file to the recordings directory
    await fs.copyFile(filePath, finalPath);
    
    // The file is now stored permanently on the server's filesystem
    // Client can download it directly via HTTP
    const downloadUrl = `/recordings/${fileName}`;
    
    console.log(`Recording available for download: ${downloadUrl}`);
    return downloadUrl;
  } catch (error) {
    console.error('Error making recording available:', error);
    throw error;
  }
}



// Status helper for debug endpoints
function getStatus() {
  const roomsSummary = {};
  for (const [roomId, room] of rooms) {
    roomsSummary[roomId] = {
      producers: [...room.producers.entries()].map(([id, p]) => ({ id, codecs: p.rtpParameters && p.rtpParameters.codecs ? p.rtpParameters.codecs.map(c => ({ mime: c.mimeType, payload: c.payloadType })) : [] })),
      transports: [...room.transports.keys()],
    };
  }

  const active = {};
  for (const [callId, rec] of activeRecordings) {
    active[callId] = { startTime: rec.startTime, outPath: rec.outPath, fileName: rec.fileName };
  }

  return { rooms: roomsSummary, activeRecordings: active };
}

function getRouterRtpCapabilities() {
  try {
    if (!router) {
      console.warn('[recording] getRouterRtpCapabilities: router NOT initialized');
      return { ready: false, message: 'Mediasoup router not initialized' };
    }

    const caps = router.rtpCapabilities || null;
    console.debug && console.debug('[recording] getRouterRtpCapabilities: router ready, capsPresent=', !!caps);
    if (!caps) {
      return { ready: false, message: 'Router initialized but rtpCapabilities missing' };
    }

    return { ready: true, caps };
  } catch (err) {
    console.error('[recording] getRouterRtpCapabilities error:', err && err.message ? err.message : err);
    return { ready: false, message: 'Internal error fetching router caps' };
  }
}

// Get available recordings from the recordings directory
async function getAvailableRecordings() {
  try {
    console.log('Getting available recordings from:', RECORDINGS_DIR);
    
    // Check if recordings directory exists
    try {
      await fs.access(RECORDINGS_DIR);
    } catch {
      console.log('Recordings directory does not exist, creating it');
      await fs.mkdir(RECORDINGS_DIR, { recursive: true });
      return [];
    }
    
    // Read all files from the recordings directory
    const files = await fs.readdir(RECORDINGS_DIR);
    
    // Filter for .wav files and create recording objects
    const wavFiles = files
      .filter(file => file.toLowerCase().endsWith('.wav'))
      .map(file => {
        const filePath = path.join(RECORDINGS_DIR, file);
        return {
          fileName: file,
          downloadUrl: `/recordings/${file}`,
          filePath: filePath,
          date: new Date(), // Will be updated with actual file stats below
          size: 0, // Will be updated with actual file stats below
        };
      });
    
    // Get file stats for each recording
    const recordingsWithStats = await Promise.all(wavFiles.map(async (rec) => {
      try {
        const stats = await fs.stat(rec.filePath);
        return {
          ...rec,
          date: stats.mtime, // Use actual modification time
          size: stats.size,
        };
      } catch (err) {
        console.error('Error getting file stats for', rec.fileName, err);
        return rec; // Return without stats if error
      }
    }));
    
    console.log(`Found ${recordingsWithStats.length} recordings`);
    
    // Sort by date (newest first)
    recordingsWithStats.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    return recordingsWithStats;
  } catch (error) {
    console.error('Error getting available recordings:', error);
    return [];
  }
}

// Delete a specific recording file
async function deleteRecording(fileName) {
  try {
    console.log('Deleting recording:', fileName);
    
    // Validate filename to prevent directory traversal
    if (!fileName || typeof fileName !== 'string' || !fileName.endsWith('.wav')) {
      return { success: false, error: 'Invalid filename' };
    }
    
    // Sanitize filename to prevent directory traversal attacks
    const sanitizedFileName = path.basename(fileName);
    const filePath = path.join(RECORDINGS_DIR, sanitizedFileName);
    
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return { success: false, error: 'File does not exist' };
    }
    
    // Delete the file
    await fs.unlink(filePath);
    
    console.log('Successfully deleted recording:', fileName);
    return { success: true };
  } catch (error) {
    console.error('Error deleting recording:', error);
    return { success: false, error: error.message };
  }
}

// Export functions
module.exports = {
  initializeWorker,
  createRoom,
  createWebRtcTransport,
  handleProduce,
  startRecording,
  stopRecording,
  makeRecordingAvailable,
  getStatus,
  getRouterRtpCapabilities,
  getAvailableRecordings,
  deleteRecording,
};
