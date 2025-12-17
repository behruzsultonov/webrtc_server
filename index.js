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

// Initialize mediasoup worker
initializeWorker().then(() => {
  console.log('Mediasoup worker initialized');
}).catch(err => {
  console.error('Failed to initialize mediasoup worker:', err);
});

initIO(httpServer);

// Recording API endpoints
const recording = require('./recording');

// Start recording endpoint
app.post('/start-recording', async (req, res) => {
  try {
    const { callId } = req.body;
    if (!callId) {
      return res.status(400).json({ error: 'callId is required' });
    }
    
    const recordingResult = await recording.startRecording(callId);
    res.json({ success: true, recording: recordingResult });
  } catch (error) {
    console.error('Error starting recording:', error);
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
    
    const result = await recording.stopRecording(callId);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Error stopping recording:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve recording files for download
app.use('/download-recording', express.static(path.join(__dirname, 'temp_recordings')));

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

httpServer.listen(port)
console.log("Server started on ", port);

getIO();