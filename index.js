const path = require('path');
const { createServer } = require('http');

const express = require('express');
const { getIO, initIO } = require('./socket');
const { initializeWorker } = require('./recording');

const app = express();

app.use('/', express.static(path.join(__dirname, 'static')));
app.use(express.json());

const httpServer = createServer(app);

let port = process.env.PORT || 3500;

// Start server only after mediasoup worker is initialized
(async () => {
  try {
    await initializeWorker();
    console.log('Mediasoup worker initialized');

    // Safe to start Socket.IO now
    initIO(httpServer);

    // Start HTTP server
    httpServer.listen(port);
    console.log('Server started on', port);
  } catch (err) {
    console.error('Failed to initialize mediasoup worker or start server:', err);
    process.exit(1);
  }
})();

// Recording API endpoints
const recording = require('./recording');

// Start recording endpoint
app.post('/start-recording', async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) {
      return res.status(400).json({ error: 'callId is required' });
    }
    
    console.log(`[debug] /start-recording called for ${callId}`);
    const recordingResult = await recording.startRecording(callId);
    res.json({ success: true, recording: recordingResult });
  } catch (error) {
    console.error('[debug] Error starting recording:', error && error.message ? error.message : error);
    res.status(500).json({ error: error.message });
  }
});

// Stop recording endpoint
app.post('/stop-recording', async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) {
      return res.status(400).json({ error: 'callId is required' });
    }
    
    console.log(`[debug] /stop-recording called for ${callId}`);
    const result = await recording.stopRecording(callId);
    res.json({ success: true, result });
  } catch (error) {
    console.error('[debug] Error stopping recording:', error && error.message ? error.message : error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoints
app.get('/debug/recordings/status', (req, res) => {
  try {
    const status = recording.getStatus();
    res.json({ success: true, status });
  } catch (err) {
    console.error('[debug] failed to get recordings status', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message });
  }
});

// Expose router RTP capabilities for quick debugging
app.get('/debug/router-rtp-capabilities', (req, res) => {
  try {
    const resObj = recording.getRouterRtpCapabilities();
    res.json(Object.assign({ success: true }, resObj));
  } catch (err) {
    console.error('[debug] failed to get router rtp capabilities', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/debug/recordings/start', async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId required' });
    const result = await recording.startRecording(callId);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[debug] start recording failed', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/debug/recordings/stop', async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId required' });
    const result = await recording.stopRecording(callId);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[debug] stop recording failed', err && err.message ? err.message : err);
    res.status(500).json({ error: err.message });
  }
});

// Serve recording files for download
app.use('/recordings', express.static(path.join(__dirname, 'recordings')));

// Recording finished webhook
app.post('/recording-finished', async (req, res) => {
  try {
    const { callId, duration, downloadUrl } = req.body;
    
    // Here you would typically send this data to your PHP server
    // For now, we'll just log it
    console.log('Recording finished:', { callId, duration, downloadUrl });
    
    // TODO: Send to PHP server
    // sendToPHPServer({ callId, duration, downloadUrl });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error handling recording finished:', error);
    res.status(500).json({ error: error.message });
  }
});

