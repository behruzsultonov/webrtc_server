Testing & Scaling guidance

Testing
- Integration tests:
  - Simulate two RN clients producing audio to mediasoup (use headless browsers or mediasoup-client in Node) and validate that startRecording produces a file that contains both audio tracks.
  - Verify ffmpeg exit codes and check file integrity (WAV headers, duration).
- Fault injection:
  - Kill ffmpeg mid-recording and ensure stopRecording cleans up resources and marks recording failed.
  - Terminate PlainRtpTransport and ensure no resource leak on mediasoup worker.
- Load tests:
  - Run a set of concurrent calls with recordings. Measure CPU, memory, network usage per mediasoup worker, port exhaustion, and ffmpeg process growth.
  - Typical bottlenecks: CPU (ffmpeg), I/O (writing files), network (RTP packets), and mediasoup worker CPU.

Scaling recommendations
- Horizontally scale mediasoup workers:
  - Use a sticky routing mechanism so that a call's participants are routed to the same worker (or implement a routing proxy that tracks session->worker mapping).
  - For recording-heavy workloads, dedicate a set of workers to recording duties or push RTP to a dedicated recording service.
- Offload transcoding/processing:
  - Capture raw RTP onto ephemeral UDP ports and forward a copy to a job queue. Workers that handle heavy CPU tasks (FFmpeg) should run on separate nodes (or containers) and pick up jobs from the queue.
- Storage:
  - Use object storage (S3) and stream uploads to S3 for long recordings; rotate local disk write to temporary storage to avoid I/O stalls.
- Observability:
  - Instrument metrics: number of active recordings, ffmpeg process CPU/memory, RTP packet loss, bytes in/out, worker CPU/memory.
  - Centralized logs (ffmpeg stderr), tracing and alerting on process crashes and resource saturation.

Operational tips
- Prefer short recordings into temporary files + post-process / transcode into final format asynchronously.
- Use per-tenant quotas, retention policies and automatic deletion jobs.
- Automate health checks: if worker CPU > X% for Y seconds, temporarily drain new recording jobs from that worker.

Common pitfalls & how to avoid them
- Wrong SDP/payloadType mismatch: always write SDP using producer.rtpParameters.codecs[].payloadType; otherwise FFmpeg can't decode.
- Port conflict: allocate free UDP ports programmatically (e.g., using get-port or OS ephemeral binding).
- Not handling ffmpeg exit: monitor ffmpeg process and set up restarting or cleanup to avoid orphaned transports.
- Improper shutdown: always signal ffmpeg (SIGINT) and close transports to ensure file integrity.
- Disk I/O saturation: avoid writing directly to slow disks; stream directly to S3 or use fast local disks with throttling.
