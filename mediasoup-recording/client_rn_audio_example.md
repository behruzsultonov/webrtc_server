React Native (rn-webrtc) — minimal audio-only sender example

Prereqs:
- install react-native-webrtc
- request microphone permission (Android: RECORD_AUDIO; iOS: NSMicrophoneUsageDescription in Info.plist)

Example (simplified):

import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';

async function startCall(signalingSend) {
  // 1) get local audio stream
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false });

  // 2) create RTCPeerConnection
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // 3) add audio track to PC (no local recording)
  const audioTrack = stream.getAudioTracks()[0];
  pc.addTrack(audioTrack, stream);

  // 4) handle ICE candidates and local description via your signaling
  pc.onicecandidate = ({ candidate }) => signalingSend({ type: 'ice', candidate });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // send offer.sdp to your server so it can answer and create a mediasoup producer
  signalingSend({ type: 'offer', sdp: offer.sdp });

  // get answer from server and setRemoteDescription
  signalingReceive = async (msg) => {
    if (msg.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    } else if (msg.type === 'ice') {
      await pc.addIceCandidate(msg.candidate);
    }
  };

  return { pc, localStream: stream };
}

Notes:
- This is a bare minimum. In production, use mediasoup-client for better interoperability with mediasoup features (and for handling RTP/SRTP parameters).
- The client must NOT record. All recording is server-side.
