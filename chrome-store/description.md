Download Microsoft Teams meeting recordings, transcripts and shared Stream videos when the download button is disabled, missing or limited.

Everything runs in your browser. You need view access to the recording. The extension does not bypass access restrictions.


WHERE IT WORKS

- teams.microsoft.com and teams.cloud.microsoft (Teams web client)
- *.sharepoint.com meeting recordings
- The Stream-on-SharePoint player, used for any MP4 stored on SharePoint or OneDrive


VIDEO AND AUDIO

Open a recording and use the "Download" menu in the command bar. Pick a format:

- Video + Audio (.mp4)
- Audio only (.m4a)
- Video only (.mp4)

Optional: add the transcript as a subtitle track, with speaker names.

- Parallel segment downloads with a concurrency setting (1 to 16)
- Automatic retry when SharePoint throttles requests
- Encrypted segments are decrypted automatically
- Muxing runs in a Web Worker, so the tab stays responsive
- DRM-protected recordings (Widevine, PlayReady, FairPlay) are detected and explained. They cannot be downloaded by any client-side tool.


TRANSCRIPTS

Pick "Transcript..." in the Download menu. Preview each format, edit the filename, then save.

- JSON (.json): original Stream format with full metadata
- WebVTT (.vtt): subtitles with speaker tags, optional speaker names in the text
- Grouped text (.txt): consecutive lines from one speaker merged, optional timestamps

If a meeting has no transcript, the extension tells you.


OTHER FEATURES

- Editable filename, with the meeting title filled in
- Remembers your last format
- Floating banner when SharePoint hides the command bar
- Dark mode follows your browser
- Toolbar popup with a short how-to and the supported sites


PRIVACY

- Video and transcript data stay in your browser. Nothing is sent to any third-party server.
- No analytics or tracking.
- Open source: https://github.com/brendangooden/ms-teams-sharepoint-downloader
- Permissions: storage (default format) plus access to the Microsoft sites above.


SUPPORT

Report bugs on GitHub using the bug report template. Remove tenant names and file titles before posting.
