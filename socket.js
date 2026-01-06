const { Server } = require("socket.io");
const { createRoom, createWebRtcTransport, handleProduce } = require('./recording');

let IO;

module.exports.initIO = (httpServer) => {
  IO = new Server(httpServer);

  IO.use((socket, next) => {
    if (socket.handshake.query) {
      let callerId = socket.handshake.query.callerId;
      socket.user = callerId;
      next();
    }
  });

  IO.on("connection", (socket) => {
    const remoteAddr = (socket.handshake && (socket.handshake.address || (socket.handshake.headers && socket.handshake.headers['x-forwarded-for']))) || 'unknown';
    console.log(`[socket:${process.pid}] Connected socket=${socket.id} user=${socket.user} remote=${remoteAddr}`);
    socket.join(socket.user);

    // Mediasoup signaling events
    socket.on("join-room", (data) => {
      const { roomId } = data;
      socket.join(roomId);
      socket.roomId = roomId;
      
      // Create room if it doesn't exist
      const room = createRoom(roomId);
      
      socket.emit("joined-room", { roomId });
    });

    socket.on("create-transport", async (data) => {
      try {
        const { roomId } = data;
        const room = createRoom(roomId);
        
        const transport = await createWebRtcTransport(room);
        
        socket.emit("transport-created", {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (error) {
        console.error("Error creating transport:", error);
        socket.emit("error", { message: "Failed to create transport" });
      }
    });

    // Provide router RTP capabilities to clients (used by mediasoup-client Device.load)
    socket.on('get-router-rtp-capabilities', async (data) => {
      try {
        const recording = require('./recording');

        // Try a short retry loop to avoid returning false-positives during brief startup races
        let attempts = 0;
        let res;
        while (attempts < 3) {
          res = recording.getRouterRtpCapabilities();
          if (res && res.ready) break;
          attempts += 1;
          if (attempts < 3) {
            // small backoff
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        const remoteAddr = (socket.handshake && (socket.handshake.address || (socket.handshake.headers && socket.handshake.headers['x-forwarded-for']))) || 'unknown';

        // Emit enriched response to help clients and debugging
        const reply = Object.assign({
          pid: process.pid,
          socketId: socket.id,
          remoteAddr,
          timestamp: new Date().toISOString(),
        }, res);

        // Log concise summary to server logs (avoid dumping full caps)
        if (reply.ready) {
          const capsSummary = { codecs: (reply.caps && reply.caps.codecs) ? reply.caps.codecs.length : 0, headerExtensions: (reply.caps && reply.caps.headerExtensions) ? reply.caps.headerExtensions.length : 0 };
          console.log(`[socket:${process.pid}] get-router-rtp-capabilities -> socket=${socket.id} remote=${remoteAddr} ready=true capsSummary=${JSON.stringify(capsSummary)}`);
        } else {
          console.warn(`[socket:${process.pid}] get-router-rtp-capabilities -> socket=${socket.id} remote=${remoteAddr} ready=false message=${reply.message || ''}`);
        }

        socket.emit('router-rtp-capabilities', reply);
      } catch (err) {
        console.error('[socket] get-router-rtp-capabilities failed:', err && err.message ? err.message : err);
        socket.emit('router-rtp-capabilities', { ready: false, message: 'Failed to get router rtp capabilities', pid: process.pid, socketId: socket.id });
      }
    });

    socket.on("produce", async (data) => {
      try {
        const { roomId, transportId, kind, rtpParameters } = data;
        const room = createRoom(roomId);
        
        const producer = await handleProduce(room, transportId, kind, rtpParameters);
        
        socket.emit("produced", { id: producer.id });
      } catch (error) {
        console.error("Error producing:", error);
        // Emit a specific produce error so it doesn't get treated as a generic recording error on the client
        socket.emit("produce-error", { message: "Failed to produce", details: error.message || error.toString() });
      }
    });

    // Client requests to connect DTLS for a transport
    socket.on('connect-transport', async (data) => {
      try {
        const { roomId, transportId, dtlsParameters } = data;
        const room = createRoom(roomId);
        const transport = room.transports.get(transportId);
        if (!transport) throw new Error('Transport not found');
        await transport.connect({ dtlsParameters });
        socket.emit('transport-connected', { transportId });
        console.log(`[socket] transport ${transportId} connected for room ${roomId}`);
      } catch (err) {
        console.error('[socket] connect-transport error:', err && err.message ? err.message : err);
        socket.emit('error', { message: `connect-transport failed: ${err.message}` });
      }
    });

    // Allow clients to query current producers in a room (useful for polling before starting recording)
    socket.on("get-room-producers", (data) => {
      try {
        const { roomId } = data;
        const room = createRoom(roomId);
        const producers = room.producers ? Array.from(room.producers.keys()) : [];
        socket.emit("room-producers", { callId: roomId, producersCount: producers.length, producers });
      } catch (error) {
        console.error("Error getting room producers:", error);
        socket.emit("error", { message: "Failed to get room producers" });
      }
    });

    socket.on("consume", async (data) => {
      try {
        const { roomId, transportId, producerId } = data;
        const room = createRoom(roomId);
        
        const transport = room.transports.get(transportId);
        if (!transport) {
          throw new Error('Transport not found');
        }
        
        const producer = room.producers.get(producerId);
        if (!producer) {
          throw new Error('Producer not found');
        }
        
        const consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities: room.router.rtpCapabilities,
          paused: false,
        });
        
        socket.emit("consumed", {
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      } catch (error) {
        console.error("Error consuming:", error);
        socket.emit("error", { message: "Failed to consume" });
      }
    });

    socket.on("start-recording", async (data) => {
      try {
        const { callId } = data;
        console.log(`Received start-recording request for call: ${callId}`);
        
        // Validate callId
        if (!callId) {
          console.error('start-recording: callId is required');
          socket.emit("recording-failed", { error: 'callId is required', retryable: false });
          return;
        }
        
        const recording = await require('./recording').startRecording(callId);
        
        // Check if recording has an error property (special case for retryable errors)
        if (recording && recording.error) {
          socket.emit("recording-failed", { error: recording.error, retryable: recording.retryable });
        } else {
          socket.emit("recording-started", { callId, recording });
        }
      } catch (error) {
        console.error("Error starting recording:", error);
        socket.emit("recording-failed", { error: `Failed to start recording: ${error.message}`, retryable: false });
      }
    });

    socket.on("stop-recording", async (data) => {
      try {
        const { callId } = data;
        console.log(`Received stop-recording request for call: ${callId}`);
        
        // Validate callId
        if (!callId) {
          console.error('stop-recording: callId is required');
          socket.emit("recording-failed", { error: 'callId is required', retryable: false });
          return;
        }
        
        const result = await require('./recording').stopRecording(callId);
        
        socket.emit("recording-stopped", result);
      } catch (error) {
        console.error("Error stopping recording:", error);
        socket.emit("recording-failed", { error: `Failed to stop recording: ${error.message}`, retryable: false });
      }
    });

    // Existing call events
    socket.on("call", (data) => {
      let calleeId = data.calleeId;
      let rtcMessage = data.rtcMessage;
      let callType = data.callType;

      socket.to(calleeId).emit("newCall", {
        callerId: socket.user,
        callType: callType,
        rtcMessage: rtcMessage,
      });
    });

    socket.on("answerCall", (data) => {
      let callerId = data.callerId;
      rtcMessage = data.rtcMessage;

      socket.to(callerId).emit("callAnswered", {
        callee: socket.user,
        rtcMessage: rtcMessage,
      });
    });

    socket.on("ICEcandidate", (data) => {
      console.log("ICEcandidate data.calleeId", data.calleeId);
      let calleeId = data.calleeId;
      let rtcMessage = data.rtcMessage;
      console.log("socket.user emit", socket.user);

      socket.to(calleeId).emit("ICEcandidate", {
        sender: socket.user,
        rtcMessage: rtcMessage,
      });
    });

    // Handle leave call event
    socket.on("leaveCall", (data) => {
      console.log("User left call", data);
      let userId = data.userId;
      
      // Notify the other user that this user has left
      socket.to(userId).emit("userLeft", {
        userId: socket.user,
      });
    });
    
    // Handle reject call event
    socket.on("rejectCall", (data) => {
      console.log("User rejected call", data);
      let userId = data.userId;
      
      // Notify the caller that the call was rejected
      socket.to(userId).emit("callRejected", {
        userId: socket.user,
      });
    });
    
    // Handle disconnect and stop recording if active
    socket.on("disconnect", async () => {
      console.log(`[socket] Disconnected socket=${socket.id} user=${socket.user} remote=${remoteAddr}`);
      try {
        if (socket.roomId) {
          await require('./recording').stopRecording(socket.roomId);
        }
      } catch (e) {
        console.warn('[socket] stopRecording on disconnect failed:', e.message);
      }
    });
  });
};

module.exports.getIO = () => {
  if (!IO) {
    throw Error("IO not initilized.");
  } else {
    return IO;
  }
};