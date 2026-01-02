const path = require('path');
const { createServer } = require('http');

const express = require('express');
const { getIO, initIO } = require('./socket');
const { initializeWorker, getAvailableRecordings } = require('./recording');

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

// List recordings endpoint - NEW
app.get('/api/recordings', async (req, res) => {
  try {
    console.log('[debug] /api/recordings called');
    
    // Get user ID from header
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'X-User-Id header is required' 
      });
    }
    
    console.log(`[debug] Fetching recordings for user ID: ${userId}`);
    
    // Get available recordings
    const recordings = await getAvailableRecordings();
    
    // Filter recordings for the current user
    const userRecordings = recordings.filter(rec => {
      // Extract user IDs from filename using regex pattern: call_(\d+)-(\d+)_
      const match = rec.fileName.match(/^call_(\d+)-(\d+)_/);
      if (match) {
        const id1 = parseInt(match[1]);
        const id2 = parseInt(match[2]);
        
        // Check if current user is one of the participants
        return parseInt(userId) === id1 || parseInt(userId) === id2;
      }
      return false;
    });
    
    // Format the recordings for the API response
    const formattedRecordings = userRecordings.map(rec => ({
      name: rec.fileName,
      size: rec.size,
      mtime: Math.floor(rec.date.getTime() / 1000), // Convert to Unix timestamp
      url: `/api/recordings/file/${encodeURIComponent(rec.fileName)}`
    }));
    
    // Sort by modification time (newest first)
    formattedRecordings.sort((a, b) => b.mtime - a.mtime);
    
    res.json({ 
      success: true, 
      items: formattedRecordings 
    });
  } catch (error) {
    console.error('[debug] Error listing recordings:', error && error.message ? error.message : error);
    res.status(500).json({ error: error.message });
  }
});

// Get specific recording file - NEW
app.get('/api/recordings/file/:filename', async (req, res) => {
  try {
    console.log(`[debug] /api/recordings/file/${req.params.filename} called`);
    
    // Get user ID from header
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'X-User-Id header is required' 
      });
    }
    
    const filename = req.params.filename;
    
    // Validate filename format: call_(\d+)-(\d+)_...\.wav
    const match = filename.match(/^call_(\d+)-(\d+)_.+\.wav$/);
    if (!match) {
      return res.status(403).json({ 
        success: false, 
        message: 'Invalid filename format' 
      });
    }
    
    const id1 = parseInt(match[1]);
    const id2 = parseInt(match[2]);
    
    // Check if current user is one of the participants
    if (parseInt(userId) !== id1 && parseInt(userId) !== id2) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }
    
    // Construct the file path
    const filePath = path.join(__dirname, 'recordings', filename);
    
    // Check if file exists
    const fs = require('fs').promises;
    try {
      await fs.access(filePath);
    } catch (err) {
      return res.status(404).json({ 
        success: false, 
        message: 'File not found' 
      });
    }
    
    // Serve the file
    res.sendFile(filePath);
  } catch (error) {
    console.error('[debug] Error serving recording file:', error && error.message ? error.message : error);
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

// Serve recording files for download - only for internal use, not direct access
// app.use('/recordings', express.static(path.join(__dirname, 'recordings')));

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