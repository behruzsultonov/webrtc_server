FFmpeg and RTP → file (notes)

Installation
- Ubuntu/Debian: sudo apt update && sudo apt install ffmpeg
- macOS (brew): brew install ffmpeg
- Windows: download from https://ffmpeg.org/ or use choco

Why use SDP files
- RTP streams use dynamic payload types. FFmpeg needs an SDP (or explicit codec params) so it knows how to decode incoming RTP packets.
- We generate small .sdp files with the correct rtpmap payloadType matching the mediasoup producer's codec info.

Example SDP content
v=0
o=- 0 0 IN IP4 127.0.0.1
s=mediasoup-ffmpeg
c=IN IP4 127.0.0.1
t=0 0
m=audio 5004 RTP/AVP 111
a=rtpmap:111 opus/48000/2

Single input command
ffmpeg -protocol_whitelist file,udp,rtp -i in.sdp -acodec pcm_s16le -ar 48000 -ac 1 call_<id>.wav

Two inputs merged into WAV (modern mixing)
ffmpeg -protocol_whitelist file,udp,rtp -i in1.sdp -i in2.sdp -filter_complex "[0:a][1:a]amerge=inputs=2[a]" -map "[a]" -acodec pcm_s16le -ar 48000 -ac 2 call_<id>.wav

Two inputs mixed using amix (mix + normalize)
ffmpeg -protocol_whitelist file,udp,rtp -i in1.sdp -i in2.sdp -filter_complex "[0:a][1:a]amix=inputs=2:dropout_transition=2" -acodec libmp3lame call_<id>.mp3

Notes
- Choose pcm_s16le WAV for lossless archival, or libmp3lame for MP3 to reduce storage.
- For >2 participants, increase amerge/amix inputs and manage channels/sample rates.
- Monitor ffmpeg stderr for packet loss / codec errors.
