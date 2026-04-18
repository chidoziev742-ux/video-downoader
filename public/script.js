const urlInput = document.getElementById('urlInput');
const analyzeButton = document.getElementById('analyzeButton');
const downloadButton = document.getElementById('downloadButton');
const platformLabel = document.getElementById('platformLabel');
const titleLabel = document.getElementById('titleLabel');
const durationLabel = document.getElementById('durationLabel');
const thumbnailPreview = document.getElementById('thumbnailPreview');
const formatSelect = document.getElementById('formatSelect');
const includeSubs = document.getElementById('includeSubs');
const subtitleSelect = document.getElementById('subtitleSelect');
const embedSubs = document.getElementById('embedSubs');
const statusText = document.getElementById('statusText');
const messageBox = document.getElementById('messageBox');
const progressFill = document.getElementById('progressFill');

let currentFormats = [];
let currentSubtitles = [];
let analyzedUrl = '';

function setStatus(message, progress = 0) {
  statusText.textContent = message;
  progressFill.style.width = `${progress}%`;
}

function resetUI() {
  platformLabel.textContent = '-';
  titleLabel.textContent = '-';
  durationLabel.textContent = '-';
  thumbnailPreview.src = '';
  formatSelect.innerHTML = '';
  subtitleSelect.innerHTML = '';
  subtitleSelect.disabled = true;
  embedSubs.disabled = true;
  downloadButton.disabled = true;
  currentFormats = [];
  currentSubtitles = [];
  analyzedUrl = '';
}

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getValidUrls() {
  return urlInput.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

function setButtonsDisabled(disabled) {
  analyzeButton.disabled = disabled;
  downloadButton.disabled = disabled || currentFormats.length === 0;
}

function populateFormatOptions(formats) {
  formatSelect.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Choose a format or use default best';
  formatSelect.appendChild(defaultOption);

  formats.forEach(format => {
    const option = document.createElement('option');
    option.value = format.formatId;
    option.textContent = `${format.formatId} — ${format.extension} — ${format.quality}`;
    formatSelect.appendChild(option);
  });
}

function populateSubtitleOptions(subtitles) {
  subtitleSelect.innerHTML = '';
  if (subtitles.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No subtitles available';
    subtitleSelect.appendChild(option);
    subtitleSelect.disabled = true;
    embedSubs.disabled = true;
    return;
  }

  subtitleSelect.disabled = false;
  embedSubs.disabled = false;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select subtitle language';
  subtitleSelect.appendChild(placeholder);

  const seen = new Set();
  subtitles.forEach(entry => {
    const code = entry.language;
    if (seen.has(code)) return;
    seen.add(code);
    const option = document.createElement('option');
    option.value = code;
    option.textContent = `${code}${entry.automatic ? ' (auto)' : ''}`;
    subtitleSelect.appendChild(option);
  });
}

function createMessage(text, isError = false) {
  messageBox.textContent = text;
  messageBox.style.color = isError ? '#f45531' : '#9ec9ff';
}

async function analyzeUrl(url) {
  try {
    setStatus('Analyzing...', 20);
    setButtonsDisabled(true);
    createMessage('Analyzing the first URL in the list...');

    const response = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Analysis failed.');
    }

    const data = await response.json();
    const { metadata, formats, subtitles } = data;
    platformLabel.textContent = metadata.platform || '-';
    titleLabel.textContent = metadata.title || '-';
    durationLabel.textContent = formatDuration(metadata.duration);
    thumbnailPreview.src = metadata.thumbnail || '';
    currentFormats = formats;
    currentSubtitles = subtitles;
    populateFormatOptions(formats);
    populateSubtitleOptions(subtitles);
    analyzedUrl = url;
    setStatus('Ready to download', 100);
    createMessage(`Analyzed ${url}. ${formats.length} formats available.`);
    downloadButton.disabled = false;
  } catch (error) {
    console.error(error);
    resetUI();
    setStatus('Error', 0);
    createMessage(error.message || 'Unable to analyze URL.', true);
  } finally {
    setButtonsDisabled(false);
  }
}

async function processDownload(url, index, total, options) {
  setStatus(`Downloading ${index} of ${total}`, (index / total) * 100);
  createMessage(`Downloading ${url} (${index}/${total})...`);

  const response = await fetch('/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, ...options })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Download failed.');
  }

  const result = await response.json();
  return result.message || 'Download completed.';
}

downloadButton.addEventListener('click', async () => {
  const urls = getValidUrls();
  if (urls.length === 0) {
    createMessage('Enter at least one valid URL before downloading.', true);
    return;
  }

  if (!analyzedUrl) {
    createMessage('Analyze at least one URL before downloading.', true);
    return;
  }

  const mode = document.querySelector('input[name="mode"]:checked').value;
  const includeSub = includeSubs.checked;
  const subtitleLang = subtitleSelect.value;
  const embedSub = embedSubs.checked;
  const formatId = formatSelect.value;
  const selectedFormat = currentFormats.find((format) => format.formatId === formatId) || {};

  const options = {
    formatId,
    mode,
    includeSubtitles: includeSub,
    subtitleLanguage: subtitleLang,
    embedSubtitles: embedSub,
    formatHasAudio: !!selectedFormat.hasAudio,
    formatHasVideo: !!selectedFormat.hasVideo
  };

  setButtonsDisabled(true);

  let completed = 0;
  let errors = 0;
  const statusLines = [];

  for (let i = 0; i < urls.length; i++) {
    const currentIndex = i + 1;
    try {
      const message = await processDownload(urls[i], currentIndex, urls.length, options);
      completed += 1;
      statusLines.push(`✔ ${urls[i]}: ${message}`);
    } catch (error) {
      errors += 1;
      console.error(error);
      statusLines.push(`✖ ${urls[i]}: ${error.message}`);
    }
  }

  setButtonsDisabled(false);
  const finalText = errors === 0 ? 'All downloads completed.' : `${completed} succeeded, ${errors} failed.`;
  setStatus(finalText, 100);
  createMessage(statusLines.join('\n'));
});

analyzeButton.addEventListener('click', async () => {
  const urls = getValidUrls();
  if (urls.length === 0) {
    createMessage('Enter at least one URL and try again.', true);
    return;
  }

  resetUI();
  await analyzeUrl(urls[0]);
});

includeSubs.addEventListener('change', () => {
  if (includeSubs.checked && currentSubtitles.length > 0) {
    subtitleSelect.disabled = false;
    embedSubs.disabled = false;
  } else {
    subtitleSelect.disabled = true;
    embedSubs.disabled = true;
  }
});
