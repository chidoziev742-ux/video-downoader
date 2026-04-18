# Local Video Downloader

A simple web application for downloading videos from multiple platforms locally using yt-dlp.

## Features

- Download videos from YouTube, Facebook, Instagram, TikTok, Twitter/X
- Choose video or audio formats
- Download subtitles (manual or auto-generated)
- Embed subtitles into videos
- Queue multiple downloads

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/chidoziev742-ux/video-downoader.git
   cd video-downoader
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Install yt-dlp:
   ```bash
   pip install yt-dlp
   ```

4. Install ffmpeg (for video merging):
   - Download from https://ffmpeg.org/ or use winget:
     ```bash
     winget install ffmpeg
     ```

5. Start the server:
   ```bash
   npm start
   ```

6. Open http://localhost:3000 in your browser.

## Usage

- Enter video URLs (one per line)
- Click "Analyze" to fetch formats
- Select format, mode, and subtitle options
- Click "Download" to start

Downloads are saved to `C:\Users\<username>\Downloads\video-downloader`

## Disclaimer

This tool is for personal use only. Respect copyright laws and platform terms of service.