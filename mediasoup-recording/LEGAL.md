Legal / compliance: notifying users about call recording

General guidance (not legal advice):
- Follow local laws. Many jurisdictions require one-party or all-party consent before recording.
- Show an in-call banner that recording is active and visible to all participants.
- On call start (or before recording starts) present a modal: "This call may be recorded for quality and support. By continuing, you consent to recording." with an explicit Accept/Decline.
- Emit an audible beep at recording start or every N minutes if required by local law.
- Store consent metadata (userId, timestamp, consentText) together with the recording.
- Provide an endpoint for users to request deletion of recordings per retention policy.

Suggested in-app UX points:
- When a call that can be recorded is created, display a pre-call notice and store consent.
- If recording starts mid-call, notify participants in-app and via an audible tone.
- Show a persistent visible "REC" indicator during recording.

Server-side logging
- Log the recorder start/stop events, who initiated the recording, and consent state.
- Attach the consent & policy link to the recording metadata exported with the file.

Consult legal counsel to implement the appropriate consent flow for the countries where your service operates.
