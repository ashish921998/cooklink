# 06 — Add private photo and voice-note Chat

**What to build:** Extend Household Chat with photos and recorded voice notes
whose media, playback, transcripts, failures, and corrections remain private
to the authorized Household.

**Blocked by:** 04 — Connect the Household through text Chat.

**Status:** ready-for-agent

- [ ] A participant can send one compressed photo with an optional caption and
      see independent upload progress and retry state.
- [ ] A participant can record, review, send, play, and delete a bounded-length
      voice note.
- [ ] Private media is accessible only through short-lived authorized access
      and never through a public permanent URL.
- [ ] Voice transcription supports English, Hindi, and code-mixed speech;
      uncertain output is labelled and correctable.
- [ ] Correcting a transcript or photo caption re-runs any derived intent
      detection without rewriting the original media.
- [ ] Failed uploads and offline sends cannot create orphaned visible messages
      or actions.
- [ ] Removing membership immediately revokes media and transcript access.
- [ ] Automated authorization tests prove media references and transcripts
      cannot cross Household boundaries.

