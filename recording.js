// Import required modules
const mediasoup = require('mediasoup');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

// Promisify exec for easier use
const execAsync = promisify(exec);

// Mediasoup worker and router
let worker;
let router;

// Active rooms and recordings
const rooms = new Map();
const activeRecordings = new Map();

/**
 * Initialize mediasoup worker
 */
async function initializeWorker() {
  try {
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
        ip: process.env.WEBRTC_LISTEN_IP || '0.0.0.0',
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

    const producer = await transport.produce({
      kind,
      rtpParameters,
    });

    room.producers.set(producer.id, producer);
    return producer;
  } catch (error) {
    console.error('Error handling produce:', error);
    throw error;
  }
}

/**
 * Create consumer for recording
 */
async function createRecordingConsumer(room, producerId) {
  try {
    const producer = room.producers.get(producerId);
    if (!producer) {
      throw new Error('Producer not found');
    }

    // Create PlainTransport for recording
    const plainTransport = await createPlainTransport(room);

    // Create consumer that connects to the PlainTransport
    const consumer = await plainTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false,
    });

    // Connect the transports
    await plainTransport.connect({
      ip: '127.0.0.1',
      port: consumer.rtpParameters.encodings[0].ssrc || 5000,
    });

    return {
      consumer,
      transport: plainTransport,
    };
  } catch (error) {
    console.error('Error creating recording consumer:', error);
    throw error;
  }
}

/**
 * Start recording for a call
 */
async function startRecording(callId) {
  try {
    console.log(`Starting recording for call: ${callId}`);
    
    // Get or create room
    let room = rooms.get(callId);
    if (!room) {
      console.log(`Room ${callId} not found, creating new room`);
      room = createRoom(callId);
    }
    
    console.log(`Room ${callId} has ${room.producers.size} producers`);
    
    // Check if there are any producers to record
    if (room.producers.size === 0) {
      console.warn(`No producers found in room ${callId} for recording`);
      // Create an empty recording entry for now
      const emptyRecording = {
        callId,
        startTime: Date.now(),
        participants: [],
        tempFiles: [],
        mixedFile: null,
      };
      
      activeRecordings.set(callId, emptyRecording);
      console.log(`Started empty recording for call ${callId}`);
      return emptyRecording;
    }

    // Create temporary directory for recordings
    const tempDir = path.join(__dirname, 'temp_recordings');
    try {
      await fs.access(tempDir);
    } catch {
      await fs.mkdir(tempDir, { recursive: true });
    }

    // Create recording entry
    const recording = {
      callId,
      startTime: Date.now(),
      participants: [],
      tempFiles: [],
      mixedFile: null,
    };

    // For each producer, create a separate consumer for recording
    for (const [producerId, producer] of room.producers) {
      try {
        const { consumer, transport } = await createRecordingConsumer(room, producerId);
        
        // Create temporary file for this participant
        const participantFile = path.join(tempDir, `${callId}_${producerId}_${Date.now()}.rtp`);
        recording.tempFiles.push(participantFile);
        
        // Store participant info
        recording.participants.push({
          producerId,
          consumer,
          transport,
          tempFile: participantFile,
        });
        
        console.log(`Created recording consumer for producer ${producerId}`);
      } catch (error) {
        console.error(`Error creating recording consumer for producer ${producerId}:`, error);
      }
    }

    activeRecordings.set(callId, recording);
    console.log(`Started recording for call ${callId} with ${recording.participants.length} participants`);
    
    return recording;
  } catch (error) {
    console.error('Error starting recording:', error);
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

    // Stop all consumers and transports
    for (const participant of recording.participants) {
      try {
        if (participant.consumer) {
          participant.consumer.close();
        }
        if (participant.transport) {
          participant.transport.close();
        }
      } catch (error) {
        console.error('Error closing consumer/transport:', error);
      }
    }

    // Convert RTP files to Opus
    const opusFiles = [];
    for (const participant of recording.participants) {
      try {
        const opusFile = await convertRtpToOpus(participant.tempFile, participant.producerId);
        opusFiles.push(opusFile);
      } catch (error) {
        console.error(`Error converting RTP to Opus for producer ${participant.producerId}:`, error);
      }
    }

    // Mix audio files
    const mixedFile = await mixAudioFiles(opusFiles, callId);
    recording.mixedFile = mixedFile;

    // Make recording available for client download
    const downloadUrl = await makeRecordingAvailable(mixedFile, callId);

    // Clean up temporary files
    await cleanupTempFiles(recording.tempFiles.concat(opusFiles, [mixedFile]));

    // Calculate duration
    const duration = Date.now() - recording.startTime;

    // Remove recording from active recordings
    activeRecordings.delete(callId);

    console.log(`Stopped recording for call ${callId}, duration: ${duration}ms`);
    
    return {
      callId,
      duration,
      downloadUrl,
    };
  } catch (error) {
    console.error('Error stopping recording:', error);
    throw error;
  }
}

/**
 * Convert RTP packets to Opus format
 */
async function convertRtpToOpus(rtpFile, producerId) {
  const opusFile = rtpFile.replace('.rtp', '.opus');
  
  // This is a simplified conversion - in practice, you'd need to parse RTP headers
  // and extract the Opus payload properly
  try {
    // For demonstration, we'll just copy the file
    // In a real implementation, you'd use a proper RTP parser
    await fs.copyFile(rtpFile, opusFile);
    return opusFile;
  } catch (error) {
    console.error(`Error converting RTP to Opus for producer ${producerId}:`, error);
    throw error;
  }
}

/**
 * Mix multiple audio files into one
 */
async function mixAudioFiles(inputFiles, callId) {
  if (inputFiles.length === 0) {
    throw new Error('No input files to mix');
  }

  const outputFile = path.join(__dirname, 'temp_recordings', `${callId}_final.ogg`);
  
  try {
    if (inputFiles.length === 1) {
      // If only one participant, just convert the file
      await execAsync(`ffmpeg -i "${inputFiles[0]}" -c:a libopus -ar 48000 -ac 1 "${outputFile}"`);
    } else {
      // For multiple participants, mix them together
      // Create input string for ffmpeg
      let inputString = '';
      inputFiles.forEach(file => {
        inputString += `-i "${file}" `;
      });
      
      // Mix audio tracks
      await execAsync(`ffmpeg ${inputString}-filter_complex amix=inputs=${inputFiles.length}:duration=longest -c:a libopus -ar 48000 -ac 1 "${outputFile}"`);
    }
    
    return outputFile;
  } catch (error) {
    console.error('Error mixing audio files:', error);
    throw error;
  }
}

/**
 * Make recording available for client download
 */
async function makeRecordingAvailable(filePath, callId) {
  try {
    // In this implementation, we'll just return a download URL
    // The file is stored temporarily on the server's filesystem
    // Client can download it directly via HTTP
    const fileName = path.basename(filePath);
    const downloadUrl = `/download-recording/${callId}/${fileName}`;
    
    console.log(`Recording available for download: ${downloadUrl}`);
    return downloadUrl;
  } catch (error) {
    console.error('Error making recording available:', error);
    throw error;
  }
}

/**
 * Clean up temporary files
 */
async function cleanupTempFiles(files) {
  for (const file of files) {
    try {
      await fs.unlink(file);
      console.log(`Cleaned up temporary file: ${file}`);
    } catch (error) {
      // File might not exist, that's OK
      console.log(`Could not clean up file ${file}:`, error.message);
    }
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
};