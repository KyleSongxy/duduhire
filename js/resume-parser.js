const PDF_MODULE_URL = new URL('./vendor/pdf.min.mjs', import.meta.url).href;
const PDF_WORKER_URL = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
const MAMMOTH_SCRIPT_URL = new URL('./vendor/mammoth.browser.min.js', import.meta.url).href;

const MIME_FORMATS = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/rtf', 'rtf'],
  ['text/rtf', 'rtf'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
]);

const SUPPORTED_FORMATS = new Set(['pdf', 'docx', 'rtf', 'txt', 'md']);
const RTF_IGNORED_DESTINATIONS = new Set([
  'author',
  'colortbl',
  'comment',
  'datastore',
  'filetbl',
  'fonttbl',
  'footer',
  'footerf',
  'footerl',
  'footerr',
  'header',
  'headerf',
  'headerl',
  'headerr',
  'info',
  'listoverridetable',
  'listtable',
  'nonshppict',
  'object',
  'pict',
  'revtbl',
  'shp',
  'stylesheet',
  'themedata',
  'xmlopen',
]);

let mammothPromise;

export const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024;

export class ResumeImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResumeImportError';
    this.code = code;
    this.userMessage = message;
  }
}

function normalizeExtractedText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getExtension(filename = '') {
  const match = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

export function getResumeFormat(file) {
  const extension = getExtension(file?.name);
  if (extension === 'doc') {
    throw new ResumeImportError(
      'LEGACY_WORD',
      '暂不支持旧版 Word（.doc）。请用 Word“另存为”DOCX，或直接粘贴关键经历。',
    );
  }
  if (SUPPORTED_FORMATS.has(extension)) return extension;
  const mimeFormat = MIME_FORMATS.get(String(file?.type || '').toLowerCase());
  if (mimeFormat) return mimeFormat;
  throw new ResumeImportError(
    'UNSUPPORTED_FORMAT',
    '无法读取该格式。请选择 PDF、Word（DOCX）、RTF、TXT 或 Markdown 文件。',
  );
}

function decodeRtfBytes(bytes, codePage) {
  const encoding = codePage === 936
    ? 'gbk'
    : codePage === 950
      ? 'big5'
      : 'windows-1252';
  try {
    return new TextDecoder(encoding).decode(Uint8Array.from(bytes));
  } catch {
    return new TextDecoder('windows-1252').decode(Uint8Array.from(bytes));
  }
}

export function extractTextFromRtf(source) {
  const input = String(source || '');
  const codePage = Number(input.match(/\\ansicpg(\d+)/i)?.[1] || 1252);
  const states = [{ skip: false, unicodeFallback: 1 }];
  let output = '';
  let index = 0;

  while (index < input.length) {
    const character = input[index];
    const state = states[states.length - 1];

    if (character === '{') {
      states.push({ ...state });
      index += 1;
      continue;
    }
    if (character === '}') {
      if (states.length > 1) states.pop();
      index += 1;
      continue;
    }
    if (character !== '\\') {
      if (!state.skip && character !== '\n' && character !== '\r') output += character;
      index += 1;
      continue;
    }

    if (input[index + 1] === '*' && input[index + 2] === '\\') {
      state.skip = true;
      index += 2;
      continue;
    }
    if (input[index + 1] === "'" && /^[0-9a-f]{2}$/i.test(input.slice(index + 2, index + 4))) {
      const bytes = [];
      while (
        input[index] === '\\'
        && input[index + 1] === "'"
        && /^[0-9a-f]{2}$/i.test(input.slice(index + 2, index + 4))
      ) {
        bytes.push(Number.parseInt(input.slice(index + 2, index + 4), 16));
        index += 4;
      }
      if (!state.skip) output += decodeRtfBytes(bytes, codePage);
      continue;
    }

    const symbol = input[index + 1];
    if (symbol === '\\' || symbol === '{' || symbol === '}') {
      if (!state.skip) output += symbol;
      index += 2;
      continue;
    }
    if (symbol === '~') {
      if (!state.skip) output += ' ';
      index += 2;
      continue;
    }
    if (symbol === '-') {
      if (!state.skip) output += '\u00ad';
      index += 2;
      continue;
    }
    if (symbol === '_') {
      if (!state.skip) output += '\u2011';
      index += 2;
      continue;
    }
    if (symbol === '\n' || symbol === '\r') {
      if (!state.skip) output += '\n';
      index += symbol === '\r' && input[index + 2] === '\n' ? 3 : 2;
      continue;
    }

    const control = input.slice(index + 1).match(/^([a-z]+)(-?\d+)? ?/i);
    if (!control) {
      index += 2;
      continue;
    }
    const word = control[1].toLowerCase();
    const parameter = control[2] === undefined ? null : Number(control[2]);
    index += 1 + control[0].length;

    if (RTF_IGNORED_DESTINATIONS.has(word)) {
      state.skip = true;
      continue;
    }
    if (word === 'uc' && Number.isFinite(parameter)) {
      state.unicodeFallback = Math.max(0, parameter);
      continue;
    }
    if (state.skip) continue;
    if (word === 'par' || word === 'line') {
      output += '\n';
      continue;
    }
    if (word === 'tab') {
      output += '\t';
      continue;
    }
    if (word === 'emdash') {
      output += '—';
      continue;
    }
    if (word === 'endash') {
      output += '–';
      continue;
    }
    if (word === 'bullet') {
      output += '•';
      continue;
    }
    if (word === 'u' && Number.isFinite(parameter)) {
      output += String.fromCodePoint(parameter < 0 ? parameter + 65536 : parameter);
      index += state.unicodeFallback;
    }
  }

  return normalizeExtractedText(output);
}

function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (mammothPromise) return mammothPromise;
  mammothPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MAMMOTH_SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', () => {
      if (window.mammoth) resolve(window.mammoth);
      else reject(new Error('Mammoth did not initialize.'));
    }, { once: true });
    script.addEventListener('error', () => reject(new Error('Mammoth failed to load.')), { once: true });
    document.head.appendChild(script);
  });
  return mammothPromise;
}

async function readPdf(file, onProgress) {
  onProgress?.({ phase: 'library', message: '正在准备 PDF 解析组件…' });
  const pdfjs = await import(PDF_MODULE_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const documentProxy = await loadingTask.promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
    onProgress?.({
      phase: 'page',
      current: pageNumber,
      total: documentProxy.numPages,
      message: `正在读取 PDF 第 ${pageNumber} / ${documentProxy.numPages} 页…`,
    });
    const page = await documentProxy.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || '').join(' ');
    pages.push(text);
    page.cleanup();
  }
  await documentProxy.destroy();
  return normalizeExtractedText(pages.join('\n\n'));
}

async function readDocx(file, onProgress) {
  onProgress?.({ phase: 'library', message: '正在准备 Word 解析组件…' });
  const mammoth = await loadMammoth();
  onProgress?.({ phase: 'content', message: '正在提取 Word 文档中的文字…' });
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return normalizeExtractedText(result.value);
}

function friendlyReadError(error, format) {
  if (error instanceof ResumeImportError) return error;
  if (format === 'pdf' && (error?.name === 'PasswordException' || /password/i.test(error?.message || ''))) {
    return new ResumeImportError(
      'PDF_PASSWORD',
      '这个 PDF 设有打开密码。请先移除密码，或复制其中的关键经历后再试。',
    );
  }
  if (format === 'pdf') {
    return new ResumeImportError(
      'PDF_READ_FAILED',
      'PDF 读取失败，文件可能已损坏或格式异常。请重新导出 PDF，或直接粘贴经历。',
    );
  }
  if (format === 'docx') {
    return new ResumeImportError(
      'DOCX_READ_FAILED',
      'Word 文档读取失败。请确认文件是有效的 DOCX，或重新另存后再试。',
    );
  }
  return new ResumeImportError(
    'FILE_READ_FAILED',
    '文件读取失败。请重新选择文件，或直接粘贴关键经历。',
  );
}

export async function readResumeFile(file, onProgress) {
  if (!file) {
    throw new ResumeImportError('FILE_REQUIRED', '请先选择一份简历文件。');
  }
  if (file.size === 0) {
    throw new ResumeImportError('EMPTY_FILE', '这个文件是空的，请选择包含简历内容的文件。');
  }
  if (file.size > MAX_RESUME_FILE_BYTES) {
    throw new ResumeImportError(
      'FILE_TOO_LARGE',
      '文件超过 10MB。请压缩文件、另存为更小的 PDF / DOCX，或直接粘贴关键经历。',
    );
  }

  const format = getResumeFormat(file);
  try {
    onProgress?.({ phase: 'reading', message: `正在读取 ${file.name}…` });
    let text = '';
    if (format === 'txt' || format === 'md') text = await file.text();
    if (format === 'rtf') text = extractTextFromRtf(await file.text());
    if (format === 'pdf') text = await readPdf(file, onProgress);
    if (format === 'docx') text = await readDocx(file, onProgress);
    text = normalizeExtractedText(text);
    if (!text) {
      const message = format === 'pdf'
        ? '没有从 PDF 中识别到文字；它可能是扫描件。请先进行 OCR，或直接粘贴关键经历。'
        : '没有从文件中读取到文字。请检查文件内容，或直接粘贴关键经历。';
      throw new ResumeImportError('NO_TEXT', message);
    }
    return { format, text };
  } catch (error) {
    throw friendlyReadError(error, format);
  }
}
