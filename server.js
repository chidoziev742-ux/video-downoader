const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const express = require("express");
const cors = require("cors");
const { resolveDemSource } = require("./demResolver");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DOWNLOAD_DIR = path.join(
  process.env.USERPROFILE,
  "Downloads",
  "video-downloader",
);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function getPythonBinary() {
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
    return process.env.PYTHON_PATH;
  }
  const localPython = path.join(
    process.env.LOCALAPPDATA || "",
    "Python",
    "bin",
    "python.exe",
  );
  if (fs.existsSync(localPython)) {
    return localPython;
  }
  return "python";
}

const PYTHON_BIN = getPythonBinary();

function parseDemUrl(urlString) {
  const parsed = new URL(urlString);
  if (parsed.hostname.toLowerCase() !== "demmovies.netlify.app") return null;
  if (
    parsed.protocol !== "https:" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    !/^\/watch\/[^/]+\/?$/.test(parsed.pathname)
  ) {
    throw new Error(
      "Invalid DEM/MOVIES URL. Use https://demmovies.netlify.app/watch/<animeId>.",
    );
  }
  const id = decodeURIComponent(parsed.pathname.split("/")[2]);
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new Error(
      "Episode lookup is unavailable for non-numeric DEM/MOVIES IDs; no reliable AniList mapping exists.",
    );
  }
  return Number(id);
}

function validateUrl(url) {
  if (typeof url !== "string" || !url.trim())
    throw new Error("URL is required.");
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error("Invalid URL format.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Invalid URL format.");
  return parseDemUrl(url.trim());
}

function detectPlatform(urlString) {
  try {
    const parsed = new URL(urlString.trim());
    const host = parsed.hostname.toLowerCase();
    if (
      host === "demmovies.netlify.app" &&
      /^\/watch\/[^/]+\/?$/.test(parsed.pathname) &&
      parsed.protocol === "https:" &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password
    )
      return "DEM/MOVIES";
    if (host.includes("youtube.com") || host.includes("youtu.be"))
      return "YouTube";
    if (host.includes("facebook.com") || host.includes("fb.watch"))
      return "Facebook";
    if (host.includes("instagram.com")) return "Instagram";
    if (host.includes("tiktok.com")) return "TikTok";
    if (host === "animeheaven.me" || host === "www.animeheaven.me")
      return "animeheaven";
    if (host.includes("twitter.com") || host.includes("x.com"))
      return "Twitter/X";

    return "Unknown";
  } catch (error) {
    return "Invalid";
  }
}

async function lookupAnime(id) {
  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME) {
      idMal episodes
      title { english romaji native }
      coverImage { large medium }
    }
  }`;
  let response;
  try {
    response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: { id } }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw Object.assign(
      new Error("AniList API is unavailable or timed out. Try again later."),
      { status: 502 },
    );
  }
  if (response.status === 404) {
    throw Object.assign(new Error("Unknown AniList anime ID."), {
      status: 404,
    });
  }
  if (!response.ok) {
    throw Object.assign(new Error("AniList API failure. Try again later."), {
      status: 502,
    });
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw Object.assign(
      new Error("AniList API returned an invalid response."),
      { status: 502 },
    );
  }
  if (!result.data?.Media) {
    throw Object.assign(
      new Error(
        !result.errors?.length ||
          result.errors.some((e) => /not found/i.test(e.message))
          ? "Unknown AniList anime ID."
          : "AniList API failure. Try again later.",
      ),
      {
        status:
          !result.errors?.length ||
          result.errors.some((e) => /not found/i.test(e.message))
            ? 404
            : 502,
      },
    );
  }
  return result.data.Media;
}

function validateEpisodeAndLanguage(body, anime) {
  const { episode, language } = body;
  if (
    !Number.isSafeInteger(episode) ||
    episode < 1 ||
    episode > (anime.episodes || 100000)
  ) {
    throw Object.assign(
      new Error(
        anime.episodes
          ? `Invalid episode. Choose an episode from 1 to ${anime.episodes}.`
          : "Invalid episode. Enter a positive episode number.",
      ),
      { status: 400 },
    );
  }
  if (language !== "sub" && language !== "dub") {
    throw Object.assign(new Error("Unsupported language. Choose sub or dub."), {
      status: 400,
    });
  }
}

function demError(res, error) {
  return res.status(error.status || 400).json({ error: error.message });
}

// AniList supplies metadata, not authorized episode media URLs. Do not resolve provider iframes.
async function analyzeDem(req, res, id) {
  try {
    const anime = await lookupAnime(id);
    if (anime.episodes === 0) {
      throw Object.assign(
        new Error("This anime has no known episodes on AniList."),
        { status: 422 },
      );
    }
    if (req.body.episode !== undefined || req.body.language !== undefined) {
      validateEpisodeAndLanguage(req.body, anime);
      const sourceResult = await resolveDemSource({
        anilistId: id,
        malId: anime.idMal,
        episode: req.body.episode,
        language: req.body.language,
      });
      if (!sourceResult || !sourceResult.available) {
        return res.status(404).json({
          error:
            sourceResult?.reason ||
            "No downloadable source is currently available for this episode.",
        });
      }
      return res.json({
        metadata: {
          title: `${anime.title.english || anime.title.romaji || anime.title.native || "Unknown title"} - Episode ${req.body.episode} (${String(req.body.language).toUpperCase()})`,
          thumbnail: anime.coverImage?.large || anime.coverImage?.medium || "",
          duration: sourceResult.duration || 0,
          platform: "DEM/MOVIES",
          idMal: anime.idMal,
        },
        episodeCount: Number.isSafeInteger(anime.episodes)
          ? anime.episodes
          : null,
        formats: sourceResult.formats || [],
        subtitles: sourceResult.subtitles || [],
      });
    }
    return res.json({
      metadata: {
        title:
          anime.title.english ||
          anime.title.romaji ||
          anime.title.native ||
          "Unknown title",
        thumbnail: anime.coverImage?.large || anime.coverImage?.medium || "",
        duration: 0,
        platform: "DEM/MOVIES",
        idMal: anime.idMal,
      },
      episodeCount: Number.isSafeInteger(anime.episodes)
        ? anime.episodes
        : null,
      formats: [],
      subtitles: [],
    });
  } catch (error) {
    return demError(res, error);
  }
}

function parseFormats(formatText) {
  const lines = formatText.split("\n");
  const formats = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("format code") ||
      trimmed.startsWith("format")
    ) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const formatId = parts[0];
    const extension = parts[1];
    const resolution = parts[2];
    const note = parts.slice(3).join(" ");
    const hasAudio =
      /audio|audio only/i.test(note) || !/video only/i.test(note);
    const hasVideo =
      /video|video only/i.test(note) || !/audio only/i.test(note);
    formats.push({
      formatId,
      extension,
      quality: `${resolution} ${note}`.trim(),
      hasAudio,
      hasVideo,
    });
  }
  return formats;
}

function parseSubtitleList(text) {
  const subtitles = [];
  const lines = text.split("\n");
  let mode = "manual";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toLowerCase().includes("available automatic subtitles")) {
      mode = "auto";
      continue;
    }
    if (line.toLowerCase().includes("available subtitles")) {
      mode = "manual";
      continue;
    }
    if (line.startsWith("-")) {
      const code = line.slice(1).trim().split(" ")[0];
      if (code) {
        subtitles.push({ language: code, automatic: mode === "auto" });
      }
    }
  }
  return subtitles;
}

app.post("/analyze", async (req, res) => {
  let demId;
  try {
    demId = validateUrl(req.body?.url);
  } catch (error) {
    return demError(res, error);
  }
  if (demId !== null) return analyzeDem(req, res, demId);
  const url = req.body.url.trim();
  const platform = detectPlatform(url);

  try {
    const metadataPromise = new Promise((resolve, reject) => {
      execFile(
        PYTHON_BIN,
        ["-m", "yt_dlp", "-J", "--no-warnings", "--", url],
        { maxBuffer: 1024 * 1024 * 5 },
        (error, stdout, stderr) => {
          if (error) {
            return reject(new Error(stderr || error.message));
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (parseError) {
            reject(new Error("Failed to parse metadata output."));
          }
        },
      );
    });

    const formatPromise = new Promise((resolve, reject) => {
      execFile(
        PYTHON_BIN,
        ["-m", "yt_dlp", "-F", "--no-warnings", "--", url],
        { maxBuffer: 1024 * 1024 * 5 },
        (error, stdout, stderr) => {
          if (error && !stdout) {
            return reject(new Error(stderr || error.message));
          }
          resolve(stdout);
        },
      );
    });

    const subtitlePromise = new Promise((resolve) => {
      execFile(
        PYTHON_BIN,
        ["-m", "yt_dlp", "--list-subs", "--no-warnings", "--", url],
        { maxBuffer: 1024 * 1024 * 5 },
        (error, stdout) => {
          if (error && !stdout) {
            return resolve([]);
          }
          resolve(parseSubtitleList(stdout));
        },
      );
    });

    const [metadata, formatText, subtitleList] = await Promise.all([
      metadataPromise,
      formatPromise,
      subtitlePromise,
    ]);

    const duration = metadata.duration || 0;
    res.json({
      metadata: {
        title: metadata.title || "Unknown title",
        thumbnail: metadata.thumbnail || "",
        duration,
        platform,
      },
      formats: parseFormats(formatText),
      subtitles: subtitleList,
    });
  } catch (error) {
    console.error("[ANALYZE ERROR]", error.message || error);
    res.status(500).json({
      error:
        "Failed to analyze the video. " + (error.message || "Unknown error."),
    });
  }
});

function executeYtDlpDownload(targetUrl, req, res) {
  const {
    formatId,
    mode,
    includeSubtitles,
    subtitleLanguage,
    embedSubtitles,
  } = req.body;

  if (
    formatId &&
    (typeof formatId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(formatId))
  ) {
    return res.status(400).json({ error: "Invalid format ID." });
  }
  if (
    subtitleLanguage &&
    (typeof subtitleLanguage !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(subtitleLanguage))
  ) {
    return res.status(400).json({ error: "Invalid subtitle language." });
  }

  const outputTemplate = path.join(
    DOWNLOAD_DIR,
    "%(title).200s_%(id)s.%(ext)s",
  );
  const args = [
    "-m",
    "yt_dlp",
    "--no-warnings",
    "--newline",
    "--restrict-filenames",
    "--ffmpeg-location",
    "C:\\Users\\chido\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe",
    "--no-mtime",
    "-o",
    outputTemplate,
  ];

  const formatHasAudio = !!req.body.formatHasAudio;
  const formatHasVideo = !!req.body.formatHasVideo;

  console.log(
    "[DOWNLOAD DEBUG] formatId:",
    formatId,
    "hasAudio:",
    formatHasAudio,
    "hasVideo:",
    formatHasVideo,
  );

  if (mode === "audio") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    if (!formatId) {
      args.push("-f", "bestaudio/best");
    } else {
      args.push("-f", formatId);
    }
  } else {
    args.push("--merge-output-format", "mp4");
    if (!formatId) {
      args.push("-f", "bestvideo+bestaudio/best");
    } else if (formatHasVideo && !formatHasAudio) {
      args.push("-f", `${formatId}+bestaudio/best`);
    } else if (formatHasAudio && !formatHasVideo) {
      args.push("-f", `bestvideo/best+${formatId}`);
    } else {
      args.push("-f", formatId);
    }
  }

  if (includeSubtitles) {
    if (subtitleLanguage && subtitleLanguage.toLowerCase() === "auto") {
      args.push("--write-auto-subs");
    } else {
      args.push("--write-subs");
    }
    if (subtitleLanguage && subtitleLanguage.toLowerCase() !== "auto") {
      args.push("--sub-lang", subtitleLanguage);
    }
    if (embedSubtitles && mode !== "audio") {
      args.push("--embed-subs");
    }
  }

  args.push("--", targetUrl);

  console.log("[DOWNLOAD START]", PYTHON_BIN, args.join(" "));

  execFile(
    PYTHON_BIN,
    args,
    { maxBuffer: 1024 * 1024 * 20 },
    (error, stdout, stderr) => {
      if (error) {
        console.error("[DOWNLOAD ERROR]", stderr || error.message);
        const message = stderr || error.message || "Download failed.";
        return res.status(500).json({ error: "Download error. " + message });
      }

      console.log("[DOWNLOAD COMPLETE]", stdout);
      res.json({ message: "Download completed successfully." });
    },
  );
}

app.post("/download", (req, res) => {
  const { url } = req.body;

  let demId;
  try {
    demId = validateUrl(url);
  } catch (error) {
    return demError(res, error);
  }
  if (demId !== null) {
    return lookupAnime(demId)
      .then(async (anime) => {
        if (anime.episodes === 0) {
          throw Object.assign(
            new Error("This anime has no known episodes on AniList."),
            { status: 422 },
          );
        }
        validateEpisodeAndLanguage(req.body, anime);
        const sourceResult = await resolveDemSource({
          anilistId: demId,
          malId: anime.idMal,
          episode: req.body.episode,
          language: req.body.language,
        });
        if (!sourceResult || !sourceResult.available) {
          return res.status(404).json({
            error:
              sourceResult?.reason ||
              "No downloadable source is currently available for this episode.",
          });
        }
        return executeYtDlpDownload(sourceResult.sourceUrl, req, res);
      })
      .catch((error) => demError(res, error));
  }

  return executeYtDlpDownload(url, req, res);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Ensure yt-dlp is installed and available in PATH.");
  });
}

module.exports = app;
