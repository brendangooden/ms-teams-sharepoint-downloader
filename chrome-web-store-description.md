MS Teams Video & Transcript Downloader is a Chrome extension that solves a common frustration: downloading Microsoft Teams meeting recordings and transcripts when downloads are disabled or unavailable due to organizational permissions.

Whether you need to save a recording for offline viewing, extract audio for a podcast, or grab a transcript for notes — this extension gives you full access.


THE PROBLEM WE SOLVE

Microsoft Teams and SharePoint often restrict downloads based on organizational permissions or meeting settings. Even when you can view a recording or transcript, the download button may be disabled, missing, or limited.

This leaves users unable to:
- Save meeting recordings for offline viewing
- Extract audio from meetings
- Download transcripts for reference
- Process transcripts with AI tools
- Create subtitles or captions


VIDEO & AUDIO DOWNLOAD

SharePoint blocks direct video downloads, but the stream data is right there in your browser. This extension detects the video manifest URL and generates ready-to-use terminal commands to download it.

Two download tools:
- ffmpeg — Simple, widely available, downloads sequentially
- yt-dlp — Downloads segments in parallel (-N 16), significantly faster for large recordings

Five format options:
🎬 Video + Audio (.mp4) — Best quality, original streams copied
🎵 Audio Only (.m4a) — Original audio, no re-encoding
🎵 Audio Only (.mp3) — Universal compatibility
🎵 Audio Only (.wav) — Uncompressed audio
🎬 Video Only (.mp4) — No audio track

How it works:
- A red "Download Video" button appears in the top command bar
- Click it to open the format selection modal
- Pick your tool (ffmpeg or yt-dlp) and format
- Edit the filename if needed (auto-detected from page title)
- Click "Copy Command" and paste into your terminal
- The video downloads directly to your machine

Note: The URL contains a temporary auth token that will expire, so generate and use the command promptly.


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
- Consecutive messages grouped by speaker
- Clean, readable format optimized for LLMs
- Easy to scan and analyze

How it works:
- Click the "Transcript" tab on a recording page
- A purple "Download Transcript" button appears in the transcript panel
- Click it to see live previews of all three formats
- Choose your format, customize the filename, and download


KEY FEATURES

- Live format previews before downloading
- Custom filenames with auto-detection from meeting titles
- Format preferences saved across sessions
- Speaker names preserved in all formats (not anonymous GUIDs)
- Works on both teams.microsoft.com and SharePoint-hosted recordings
- iframe compatible for embedded recordings
- Parallel video downloads with yt-dlp for maximum speed


HOW TO USE

1. Install the extension from the Chrome Web Store
2. Open a Teams meeting recording
3. For video: Click "Download Video" in the top command bar, pick a format and tool, copy the command, and run it in your terminal
4. For transcripts: Click the Transcript tab, then click "Download Transcript", choose your format, and download


PERFECT FOR

👨‍💼 Professionals — Archive meeting recordings and notes
🎓 Students & Educators — Save lectures and study materials
♿ Accessibility — Create personal copies for review
🤖 AI Enthusiasts — Feed transcripts to LLMs for summaries
📊 Analysts — Process meeting data for insights
🎬 Content Creators — Extract audio or subtitles for editing


PRIVACY & SECURITY

🔒 100% Local Processing — All conversions happen in your browser. No data is sent to external servers.
🔒 No Tracking — No analytics, usage data, or personal information collected.
🔒 Open Source — Full source code available on GitHub for review.
🔒 Official APIs Only — Uses the same API endpoints the Teams interface uses.


TECHNICAL DETAILS

- Manifest V3 compliant
- Works on teams.microsoft.com and *.sharepoint.com
- Supports both web Teams and embedded SharePoint recordings
- iframe-aware for complex page structures
- Minimal permissions required (storage + host access only)
- Video download requires ffmpeg or yt-dlp installed locally


SUPPORT & FEEDBACK

Found a bug? Have a feature request? Visit our GitHub repository.
https://github.com/brendangooden/ms-teams-sharepoint-downloader

Note: This extension requires you to have viewing access to the recording or transcript. It does not bypass access restrictions.
