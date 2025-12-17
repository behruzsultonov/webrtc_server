# CallApp WebRTC Server with Audio Recording

This is the Node.js server for the CallApp React Native application with server-side audio recording capabilities.

## Features

- WebRTC signaling using Socket.IO
- Mediasoup SFU for audio/video streaming
- Server-side audio recording pipeline
- Client-side recording delivery
- REST API for recording control

## Prerequisites

- Node.js 16+
- npm or yarn
- FFmpeg

## Installation

```bash
cd server
npm install
```

## Configuration

Set the following environment variables:

```bash
WEBRTC_LISTEN_IP=0.0.0.0
WEBRTC_ANNOUNCED_IP=your_public_ip
```

## Running the Server

```bash
npm start
```

The server will start on port 3500 by default.

## Recording API

### Start Recording

```http
POST /start-recording
Content-Type: application/json

{
  "callId": "unique_call_identifier"
}
```

### Stop Recording

```http
POST /stop-recording
Content-Type: application/json

{
  "callId": "unique_call_identifier"
}
```

### Recording Finished Webhook

```http
POST /recording-finished
Content-Type: application/json

{
  "callId": "unique_call_identifier",
  "duration": 120000,
  "downloadUrl": "/download-recording/callId/filename.ogg"
}
```

## Socket.IO Events

### Client to Server

- `join-room` - Join a call room
- `create-transport` - Create WebRTC transport
- `produce` - Publish audio track
- `consume` - Subscribe to audio track
- `start-recording` - Begin call recording
- `stop-recording` - End call recording

### Server to Client

- `joined-room` - Acknowledge room join
- `transport-created` - Return transport parameters
- `produced` - Acknowledge producer creation
- `consumed` - Return consumer parameters
- `recording-started` - Acknowledge recording start
- `recording-stopped` - Return recording result
- `error` - Report errors

## Architecture

```
Client (React Native) 
  ↔ Socket.IO Signaling 
  ↔ Mediasoup SFU 
  ↔ Recording Pipeline 
  ↔ Client Download
```

## Recording Pipeline

1. **Capture**: Each producer gets a dedicated consumer for recording
2. **Transport**: PlainTransport receives RTP packets with Opus audio
3. **Conversion**: RTP packets are converted to Opus format
4. **Mixing**: Audio from all participants is mixed together
5. **Encoding**: Mixed audio is encoded to OGG/Opus format
6. **Delivery**: Final recording is made available for client download
7. **Cleanup**: Temporary files are removed

## Deployment

### Docker

Build and run with Docker:

```bash
docker build -t callapp-server .
docker run -p 3500:3500 -p 40000-49999:40000-49999/udp callapp-server
```

### Render.com

The server is configured for deployment on Render.com with the provided Dockerfile.

## Legal Considerations

- User consent must be obtained before recording
- Recordings are delivered directly to clients
- No permanent server-side storage
- Comply with local privacy laws and regulations

## Technical Notes

- Uses Opus codec for optimal audio quality and compression
- Supports group calls with audio mixing
- Handles ephemeral filesystem limitations of cloud platforms
- Implements proper error handling and cleanup procedures