const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;
const DOWNLOAD_DIR = path.join(process.env.USERPROFILE, 'Downloads', 'video-downloader');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function detectPlatform(urlString) {
  try {
    const parsed = new URL(urlString.trim());
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) return 'YouTube';
    if (host.includes('facebook.com') || host.includes('fb.watch')) return 'Facebook';
    if (host.includes('instagram.com')) return 'Instagram';
    if (host.includes('tiktok.com')) return 'TikTok';
    if (host.includes('twitter.com') || host.includes('x.com')) return 'Twitter/X';
    return 'Unknown';
  } catch (error) {
    return 'Invalid';
  }
}

function parseFormats(formatText) {
  const lines = formatText.split('\n');
  const formats = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('format code') || trimmed.startsWith('format')) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const formatId = parts[0];
    const extension = parts[1];
    const resolution = parts[2];
    const note = parts.slice(3).join(' ');
    const hasAudio = /audio|audio only/i.test(note) || !/video only/i.test(note);
    const hasVideo = /video|video only/i.test(note) || !/audio only/i.test(note);
    formats.push({
      formatId,
      extension,
      quality: `${resolution} ${note}`.trim(),
      hasAudio,
      hasVideo
    });
  }
  return formats;
}

function parseSubtitleList(text) {
  const subtitles = [];
  const lines = text.split('\n');
  let mode = 'manual';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toLowerCase().includes('available automatic subtitles')) {
      mode = 'auto';
      continue;
    }
    if (line.toLowerCase().includes('available subtitles')) {
      mode = 'manual';
      continue;
    }
    if (line.startsWith('-')) {
      const code = line.slice(1).trim().split(' ')[0];
      if (code) {
        subtitles.push({ language: code, automatic: mode === 'auto' });
      }
    }
  }
  return subtitles;
}

app.post('/analyze', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  const platform = detectPlatform(url);
  if (platform === 'Invalid') {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  try {
    const metadataPromise = new Promise((resolve, reject) => {
      exec(`python -m yt_dlp -J --no-warnings ${JSON.stringify(url)}`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr || error.message));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error('Failed to parse metadata output.'));
        }
      });
    });

    const formatPromise = new Promise((resolve, reject) => {
      exec(`python -m yt_dlp -F --no-warnings ${JSON.stringify(url)}`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error && !stdout) {
          return reject(new Error(stderr || error.message));
        }
        resolve(stdout);
      });
    });

    const subtitlePromise = new Promise((resolve) => {
      exec(`python -m yt_dlp --list-subs --no-warnings ${JSON.stringify(url)}`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout) => {
        if (error && !stdout) {
          return resolve([]);
        }
        resolve(parseSubtitleList(stdout));
      });
    });

    const [metadata, formatText, subtitleList] = await Promise.all([metadataPromise, formatPromise, subtitlePromise]);

    const duration = metadata.duration || 0;
    res.json({
      metadata: {
        title: metadata.title || 'Unknown title',
        thumbnail: metadata.thumbnail || '',
        duration,
        platform
      },
      formats: parseFormats(formatText),
      subtitles: subtitleList
    });
  } catch (error) {
    console.error('[ANALYZE ERROR]', error.message || error);
    res.status(500).json({ error: 'Failed to analyze the video. ' + (error.message || 'Unknown error.') });
  }
});

app.post('/download', (req, res) => {
  const {
    url,
    formatId,
    mode,
    includeSubtitles,
    subtitleLanguage,
    embedSubtitles
  } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required for download.' });
  }

  const platform = detectPlatform(url);
  if (platform === 'Invalid') {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const outputTemplate = path.join(DOWNLOAD_DIR, '%(title).200s_%(id)s.%(ext)s');
  const args = ['-m', 'yt_dlp', '--no-warnings', '--newline', '--restrict-filenames', '--ffmpeg-location', 'C:\\Users\\chido\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe', '--no-mtime', '-o', outputTemplate];

  const formatHasAudio = !!req.body.formatHasAudio;
  const formatHasVideo = !!req.body.formatHasVideo;

  console.log('[DOWNLOAD DEBUG] formatId:', formatId, 'hasAudio:', formatHasAudio, 'hasVideo:', formatHasVideo);

  console.log('[DOWNLOAD DEBUG] formatId:', formatId, 'hasAudio:', formatHasAudio, 'hasVideo:', formatHasVideo);

  if (mode === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    if (!formatId) {
      args.push('-f', 'bestaudio/best');
    } else {
      args.push('-f', formatId);
    }
  } else {
    args.push('--merge-output-format', 'mp4');
    if (!formatId) {
      args.push('-f', 'bestvideo+bestaudio/best');
    } else if (formatHasVideo && !formatHasAudio) {
      args.push('-f', `${formatId}+bestaudio/best`);
    } else if (formatHasAudio && !formatHasVideo) {
      args.push('-f', `bestvideo/best+${formatId}`);
    } else {
      args.push('-f', formatId);
    }
  }

  if (includeSubtitles) {
    if (subtitleLanguage && subtitleLanguage.toLowerCase() === 'auto') {
      args.push('--write-auto-subs');
    } else {
      args.push('--write-subs');
    }
    if (subtitleLanguage && subtitleLanguage.toLowerCase() !== 'auto') {
      args.push('--sub-lang', subtitleLanguage);
    }
    if (embedSubtitles && mode !== 'audio') {
      args.push('--embed-subs');
    }
  }

  args.push(url);

  console.log('[DOWNLOAD START]', 'python', args.join(' '));

  execFile('python', args, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
    if (error) {
      console.error('[DOWNLOAD ERROR]', stderr || error.message);
      const message = stderr || error.message || 'Download failed.';
      return res.status(500).json({ error: 'Download error. ' + message });
    }

    console.log('[DOWNLOAD COMPLETE]', stdout);
    res.json({ message: 'Download completed successfully.' });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Ensure yt-dlp is installed and available in PATH.');
});
