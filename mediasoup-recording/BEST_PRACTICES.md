Best practices for server-side audio recording (production-ready)

Why record on the server (not on client)
- Security & trust: server-side recordings are canonical and tamper-resistant compared to client-local files which can be modified or lost.
- Consistency & compliance: centralized storage lets you control retention, encryption, access logs, and deletion policies to meet legal/regulatory requirements.
- Privacy & user experience: avoids storing audio files on user devices and reduces battery/network usage on mobile.

iOS-specific notes
- Microphone permission must be requested in Info.plist (NSMicrophoneUsageDescription). The client still only captures audio and sends to server; no local recording.
- Background limitations: if you want calls to continue in background, ensure appropriate audio session configuration and VoIP background modes when needed (but app review scrutiny is higher). For recording, do not rely on client to persist recording.

Correctly finishing recordings
- Gracefully stop FFmpeg (SIGINT) to ensure file footers/headers are properly written and no corruption.
- Close associated PlainRtpTransports on mediasoup to free resources and stop RTP flow.
- Implement timeouts: if FFmpeg dies unexpectedly, mark the recording as failed and restart or notify operators.
- Use atomic output: write to a temporary filename and move to final path when finished to avoid partial files being consumed by downstream services.

Operational and security considerations
- Enforce encryption at rest for recorded files (SSE, or encrypted storage).
- Access audit logs and RBAC for who can download or delete recordings.
- Rate-limit and quota recordings per account to avoid abuse and unexpected storage bills.
- Store metadata (callId, participants, start/stop timestamps, file path) in DB for retrieval and compliance.

Mixing and quality
- Prefer recording at 48kHz (Opus native), downsample when producing WAV/MP3 if needed.
- Consider per-participant tracks (record each stream to separate files) if post-processing requires speaker separation.

Scaling to production
- Horizontal scale mediasoup workers via a session affinity mechanism (pins have to be routed to the same worker if necessary, or use a central metadata store to coordinate).
- Use a dedicated recording worker pool or containers per tenant when necessary.
- Offload heavy transcoding to dedicated FFmpeg worker containers (queue jobs) if you need to transcode after capture.
