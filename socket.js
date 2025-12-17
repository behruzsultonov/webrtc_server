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
    console.log(socket.user, "Connected");
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

    socket.on("produce", async (data) => {
      try {
        const { roomId, transportId, kind, rtpParameters } = data;
        const room = createRoom(roomId);
        
        const producer = await handleProduce(room, transportId, kind, rtpParameters);
        
        socket.emit("produced", { id: producer.id });
      } catch (error) {
        console.error("Error producing:", error);
        socket.emit("error", { message: "Failed to produce" });
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
        const recording = await require('./recording').startRecording(callId);
        
        socket.emit("recording-started", { callId, recording });
      } catch (error) {
        console.error("Error starting recording:", error);
        socket.emit("error", { message: "Failed to start recording" });
      }
    });

    socket.on("stop-recording", async (data) => {
      try {
        const { callId } = data;
        const result = await require('./recording').stopRecording(callId);
        
        socket.emit("recording-stopped", result);
      } catch (error) {
        console.error("Error stopping recording:", error);
        socket.emit("error", { message: "Failed to stop recording" });
      }
    });

    // Existing call events
    socket.on("call", (data) => {
      let calleeId = data.calleeId;
      let rtcMessage = data.rtcMessage;

      socket.to(calleeId).emit("newCall", {
        callerId: socket.user,
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
  });
};

module.exports.getIO = () => {
  if (!IO) {
    throw Error("IO not initilized.");
  } else {
    return IO;
  }
};