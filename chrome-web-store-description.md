MS Teams Video & Transcript Downloader is a Chrome extension that solves a common frustration: downloading Microsoft Teams meeting recordings, transcripts, and shared Microsoft Stream videos when the download button is disabled, missing, or limited by organizational permissions.

Whether you need to save a recording for offline viewing, extract audio for a podcast, grab a transcript for notes, or download an MP4 someone uploaded to SharePoint or OneDrive — this extension gives you full access.


THE PROBLEM WE SOLVE

Microsoft Teams, SharePoint, and Microsoft Stream often restrict downloads based on organizational permissions or meeting settings. Even when you can view a recording or transcript, the download button may be disabled, missing, or limited.

This leaves users unable to:
- Save meeting recordings for offline viewing
- Extract audio from meetings
- Download transcripts for reference
- Process transcripts with AI tools
- Create subtitles or captions
- Keep a copy of a video a colleague uploaded to Stream / SharePoint / OneDrive


WHERE IT WORKS

- teams.microsoft.com and teams.cloud.microsoft (the Teams web client)
- *.sharepoint.com meeting-recording links
- The Stream-on-SharePoint player at *.sharepoint.com/.../_layouts/15/stream.aspx — used whenever an MP4 lives on SharePoint or OneDrive

(Microsoft retired the standalone Stream Classic at web.microsoftstream.com in early 2024. The current Stream product reuses the SharePoint player, which this extension covers automatically.)


VIDEO & AUDIO DOWNLOAD

A red "Download Video" button appears in the top command bar of any recording. Click it and choose how you want to download.

3 download tools:
- In Browser (recommended) — Downloads Video+Audio, Audio (M4A), or Video Only directly in the browser. No extra tools needed. A progress bar shows segment-by-segment status. Encrypted segments (SharePoint's newer "SEA" encryption) are decrypted automatically.
- ffmpeg — Generates a ready-to-paste terminal command. Simple, widely available, sequential.
- yt-dlp — Generates a parallel-segment command (-N 16), significantly faster for large recordings.

Five format options:
🎬 Video + Audio (.mp4) — Best quality, original streams copied
🎵 Audio Only (.m4a) — Original audio, no re-encoding
🎵 Audio Only (.mp3) — Universal compatibility (requires ffmpeg or yt-dlp)
🎵 Audio Only (.wav) — Uncompressed audio (requires ffmpeg or yt-dlp)
🎬 Video Only (.mp4) — No audio track

If a recording is genuinely DRM-protected (Widevine / PlayReady), the extension detects this and shows a clear dialog instead of producing a broken file. Real DRM content cannot be downloaded by any tool — only by the browser's built-in DRM module during playback.

Note for CLI commands: the URL contains a temporary auth token that expires after a short window. Generate and run the command promptly.


TRANSCRIPT DOWNLOAD

Three professional formats:

📋 RAW JSON (.json)
- Original Microsoft Stream format with complete metadata
- Full speaker display names, precise timestamps, entry IDs
- Perfect for developers and advanced processing

📝 VTT Format (.vtt)
- Standard WebVTT subtitle format with timestamps
- Speaker voice tags
- Works with most video players and subtitle editors

🤖 Grouped Text (.txt)
- Consecutive messages from the same speaker collapsed into a block
- Clean, readable format optimized for LLMs and human reading
- Easy to scan and summarise

How it works:
- Click the "Transcript" tab on a recording page
- A purple "Download Transcript" button appears in the transcript panel
- Click it to see live previews of all three formats
- Choose your format, customize the filename, and download

If the meeting was never transcribed, the extension shows a clear "no transcript available" dialog rather than silently failing.


KEY FEATURES

- Live format previews before downloading
- Editable filename with auto-detection from meeting titles
- Last-used format remembered as the default
- Speaker names preserved in all transcript formats (not anonymous GUIDs)
- Floating banner widget as a fallback when SharePoint hides or re-renders the command bar
- Automatic dark mode that follows your system / browser preference
- DRM detection — shows a clear dialog rather than producing an unplayable file
- No-transcript detection — clear feedback when a meeting was never transcribed
- Works on Teams web, SharePoint recordings, OneDrive-shared MP4s, and the Stream-on-SharePoint player


HOW TO USE

1. Install the extension from the Chrome Web Store.
2. Open a meeting recording or shared video in Teams, SharePoint, or the Stream player.
3. For video: click "Download Video" in the command bar (or the floating banner). On the Download tab, pick a format and click Download — the file lands in your Downloads folder. Or switch to the ffmpeg / yt-dlp tab to grab a CLI command.
4. For transcripts: click the Transcript tab, then "Download Transcript", choose a format, and save.


PERFECT FOR

👨‍💼 Professionals — Archive meeting recordings and notes
🎓 Students & Educators — Save lectures and study materials
♿ Accessibility — Create personal copies for review
🤖 AI Enthusiasts — Feed transcripts to LLMs for summaries
📊 Analysts — Process meeting data for insights
🎬 Content Creators — Extract audio or subtitles for editing


PRIVACY & SECURITY

🔒 Local Processing — Video and transcript bytes are processed in your browser. Nothing is sent to any third-party server.
🔒 No Tracking — No analytics, usage data, or personal information collected.
🔒 Open Source — Full source code available on GitHub for review.
🔒 Official APIs Only — Uses the same Microsoft URLs the native player already calls.


TECHNICAL DETAILS

- Manifest V3 compliant
- Works on teams.microsoft.com, teams.cloud.microsoft, and *.sharepoint.com
- Minimal permissions: storage (for your default format) plus host access
- In-browser video download covers MP4 and M4A
- MP3 and WAV download requires ffmpeg or yt-dlp installed locally


SUPPORT & FEEDBACK

Found a bug? Have a feature request? Open an issue on GitHub:
https://github.com/brendangooden/ms-teams-sharepoint-downloader

There's a structured bug report template that asks for the things needed to diagnose problems (page URL pattern, console output, extension version, browser/OS). Please redact tenant names, file titles, and other personal info before posting.


Note: This extension requires you to have viewing access to the recording or transcript. It does not bypass access restrictions.
