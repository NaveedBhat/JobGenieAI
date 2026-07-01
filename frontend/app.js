/* ════════════════════════════════════════════════════
   JobGenieAI — Frontend Application Logic v3.0
   Changes from v2:
     • FIX: analyze-again button no longer writes debug
       error string into download-building innerHTML
     • FIX: sectionsForApi() strips `style` field — AI
       doesn't need it, reduces optimizer token count
     • FIX: triggerJobSearch() only fires if JD is
       meaningful (>100 chars) — avoids wasted Jooble calls
     • FIX: Optimizer payload only sends needed fields;
       n8n Section Validator now handles editable filtering
     • IMPROVEMENT: All section rebuild now uses sectionId
       matching (not index) for correct merge after n8n
       returns only editable sections optimized
════════════════════════════════════════════════════ */

'use strict';

// ── CONFIGURATION ──────────────────────────────────────────────────
const CONFIG = {
  WEBHOOK_URL:  'https://naveedbhat.app.n8n.cloud/webhook/jobgenie/analyze',
  OPTIMIZE_URL: 'https://naveedbhat.app.n8n.cloud/webhook/jobgenie/optimize',
  JOBS_URL:     'https://naveedbhat.app.n8n.cloud/webhook/jobgenie/jobs',
  MAX_FILE_SIZE_MB:  10,
  MIN_TEXT_LENGTH:   50,
  MAX_RESUME_LENGTH: 15000,
  MAX_JD_LENGTH:     10000,
  FETCH_TIMEOUT_MS:  45000,   // abort any request that hangs past 45s
};

// ════════════════════════════════════════════════════
// ERROR HANDLING UTILITIES (additive — wraps existing
// network calls, does not alter any working logic)
// ════════════════════════════════════════════════════

/**
 * fetch() wrapper that adds a timeout (AbortController) and
 * translates low-level network failures into clear messages.
 * Behavior on success is 100% identical to plain fetch().
 */
async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The server took too long to respond. Please try again in a moment.');
    }
    if (err instanceof TypeError) {
      // Typical browser network-down / CORS / DNS failure signature
      throw new Error('Could not reach the server. Check your internet connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Safely parses a fetch Response as JSON, with a clear error
 * if the server returned non-JSON (HTML error page, empty body, etc).
 */
async function safeParseJson(response) {
  const text = await response.text();
  if (!text || !text.trim()) {
    throw new Error(`Server returned an empty response (HTTP ${response.status}).`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server returned an invalid response (HTTP ${response.status}). Check the n8n webhook is active.`);
  }
}

/**
 * Converts raw technical/API error messages into clear, user-friendly text.
 * Handles: empty response, rate limits, timeouts, validation errors, generic API errors.
 */
function humanizeError(msg) {
  if (!msg) return 'Something went wrong. Please try again.';
  if (/empty response|HTTP 200/i.test(msg))
    return '⚡ The AI service is temporarily overloaded. Please wait 30 seconds and try again.';
  if (/rate.?limit|too many requests|quota|429|spacing.?your.?requests|batching.?settings|tokens.?per.?minute|requests.?per.?minute|rate_limit/i.test(msg))
    return '⏳ Rate limit reached — the AI is handling too many requests. Please wait 30 seconds and try again.';
  if (/timeout|timed.?out|ECONNRESET|ETIMEDOUT/i.test(msg))
    return '⏱ The AI took too long to respond. Please try again in a moment.';
  if (/VALIDATION_ERROR/i.test(msg))
    return msg.replace(/VALIDATION_ERROR:\s*/i, '');
  if (/Could not reach the server/i.test(msg))
    return '🔌 Could not reach the server. Check your internet connection and that n8n is running.';
  return msg;
}

/** Global safety net — catches anything that slips past local try/catch blocks */
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});
window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error || event.message);
});

// ── STATE ───────────────────────────────────────────────────────────
const state = {
  resumeText:      '',
  resumeFileName:  '',
  jobDescription:  '',
  pasteMode:       false,
  isAnalyzing:     false,
  lastResult:      null,
  // DOCX structure (for template-preserved rebuild)
  isDocx:          false,
  docxZip:         null,   // PizZip instance of original file
  docxXml:         null,   // raw word/document.xml string
  docxSections:    null,   // extracted sections array (full, with _indices)
  allParagraphs:   null,   // all parsed paragraphs with start/end offsets
  // Optimizer output
  optimizedBlob:     null,
  optimizedFileName: '',
};

// ── DOM REFS ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  fileInput:        $('resume-file'),
  browseBtn:        $('browse-btn'),
  uploadZone:       $('upload-zone'),
  uploadIdle:       $('upload-idle'),
  uploadSuccess:    $('upload-success'),
  fileNameDisplay:  $('file-name-display'),
  fileMetaDisplay:  $('file-meta-display'),
  removeFile:       $('remove-file'),
  togglePaste:      $('toggle-paste'),
  togglePasteText:  $('toggle-paste-text'),
  toggleArrow:      $('toggle-arrow'),
  pasteArea:        $('paste-area'),
  resumePaste:      $('resume-paste'),
  jobDesc:          $('job-description'),
  jdCounter:        $('jd-counter'),
  analyzeBtn:       $('analyze-btn'),
  btnText:          $('btn-text'),
  btnIcon:          $('btn-icon'),
  analyzeNote:      $('analyze-note'),
  resultsEmpty:     $('results-empty'),
  resultsLoading:   $('results-loading'),
  resultsContent:   $('results-content'),
  resultsError:     $('results-error'),
  errorMessage:     $('error-message'),
  retryBtn:         $('retry-btn'),
  copyJsonBtn:      $('copy-json'),
  analyzeAgain:     $('analyze-again'),
  downloadSection:  $('download-section'),
  downloadBuilding: $('download-building'),
  downloadReady:    $('download-ready'),
  downloadError:    $('download-error'),
  downloadErrorText:$('download-error-text'),
  downloadBtn:      $('download-btn'),
  downloadFilename: $('download-filename'),
  downloadSublabel: $('download-sublabel'),
};

// ════════════════════════════════════════════════════
// DOCX STRUCTURE EXTRACTION (PizZip-based)
// ════════════════════════════════════════════════════

/**
 * Extracts all <w:p> paragraphs from document.xml with their
 * character positions in the XML string (for later rebuild).
 */
function parseDocxParagraphs(xmlStr) {
  const paragraphs = [];
  const paraRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let m, idx = 0;
  while ((m = paraRe.exec(xmlStr)) !== null) {
    const paraXml = m[0];
    const styleM = paraXml.match(/w:pStyle\s+w:val="([^"]+)"/);
    const style = styleM ? styleM[1] : 'Normal';
    const isBullet = paraXml.includes('<w:numPr>');
    const texts = [];
    const tRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let t;
    while ((t = tRe.exec(paraXml)) !== null) texts.push(t[1]);
    const text = texts.join('').trim();
    paragraphs.push({ index: idx++, start: m.index, end: m.index + m[0].length, xml: paraXml, style, text, isBullet });
  }
  return paragraphs;
}

/** Groups flat paragraph list into resume sections by heading style */
function groupIntoSections(paragraphs) {
  const isHeading = (para) => {
    const s = para.style || '';
    const t = para.text  || '';
    if (/^Heading\d?$/.test(s) || s.toLowerCase().includes('heading') || s === 'Title' || s === 'Subtitle') return true;
    if (!para.isBullet && t.length >= 3 && t.length <= 60) {
      const letters = t.replace(/[^a-zA-Z]/g, '');
      if (letters.length >= 3 && letters === letters.toUpperCase()) return true;
    }
    return false;
  };

  const sections = [];
  let cur = null;

  for (const para of paragraphs) {
    if (isHeading(para)) {
      if (cur) sections.push(cur);
      cur = {
        sectionId: `s${sections.length}`,
        heading: para.text,
        style: para.style,
        type: 'text',
        content: '',
        contentParaIndices: [],
        bulletParaIndices: [],
      };
    } else {
      if (!cur && para.text && para.text.trim().length > 0) {
        cur = {
          sectionId: `s${sections.length}`,
          heading: 'Contact Header',
          style: 'Normal',
          type: 'text',
          content: '',
          contentParaIndices: [],
          bulletParaIndices: [],
        };
      }
      if (cur) {
        if (para.isBullet) {
          cur.bulletParaIndices.push(para.index);
          cur.type = 'bullets';
        } else if (para.text) {
          cur.contentParaIndices.push(para.index);
          cur.content = cur.content ? cur.content + '\n' + para.text : para.text;
        }
      }
    }
  }
  if (cur) sections.push(cur);

  return sections
    .filter(s => s.heading || s.content || s.bulletParaIndices.length)
    .map((s, i) => ({
      sectionId: `s${i}`,
      heading: s.heading,
      style: s.style,
      type: s.type,
      content: s.type === 'bullets'
        ? s.bulletParaIndices.map(idx => paragraphs[idx]?.text).filter(Boolean)
        : s.content,
      _contentParaIndices: s.contentParaIndices,
      _bulletParaIndices:  s.bulletParaIndices,
    }));
}

/** Returns true if this section heading is safe to rewrite */
function isSectionEditable(heading) {
  if (!heading) return false;
  const h = heading.toLowerCase().trim();
  const EDITABLE_PATTERNS = [
    /summary/, /professional summary/, /introduction/, /objective/, /profile/,
    /about me/, /career objective/, /overview/,
    /technical skills?/, /\bskills?\b/, /core competencies/, /competencies/,
    /key skills?/, /expertise/, /technologies/,
  ];
  return EDITABLE_PATTERNS.some(p => p.test(h));
}

/**
 * Extracts clean sections array for the API.
 * FIX v3: `style` field is stripped — AI never needs it.
 * The n8n Section Validator will further filter to editable-only
 * before sending to Groq/Gemini, saving 60-70% optimizer tokens.
 */
function sectionsForApi(sections) {
  return sections.map(s => ({
    sectionId: s.sectionId,
    heading:   s.heading,
    type:      s.type,
    content:   s.content,
    editable:  isSectionEditable(s.heading),
    // style is intentionally omitted — AI doesn't need it
  }));
}

/** Replace the <w:t> text inside a single <w:r> run, keeping its <w:rPr> formatting intact */
function setRunText(runXml, text) {
  let first = true;
  return runXml.replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g, () => {
    if (first) {
      first = false;
      return text ? `<w:t xml:space="preserve">${escapeXml(text)}</w:t>` : '<w:t></w:t>';
    }
    return '<w:t></w:t>';
  });
}

/**
 * Replace text in a paragraph XML while preserving ALL run formatting.
 * Works for bold labels, italic labels, coloured labels, any custom formatting.
 */
function replaceParaText(paraXml, newText) {
  const runMatches = [...paraXml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)];
  if (runMatches.length === 0) return paraXml;

  const runs = runMatches.map(m => {
    const rPrM = m[0].match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
    const tM   = m[0].match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/);
    return { xml: m[0], idx: m.index, len: m[0].length, rPr: rPrM ? rPrM[1] : '', text: tM ? tM[1] : '' };
  });

  const firstRPr = runs[0].rPr;
  const splitAt  = runs.findIndex((r, i) => i > 0 && r.rPr !== firstRPr);

  let labelText = newText;
  let valueText = '';

  if (splitAt !== -1) {
    const sepM = /[:–—\-|]/.exec(newText);
    if (sepM) {
      labelText = newText.substring(0, sepM.index + 1).trim();
      valueText = newText.substring(sepM.index + 1).trim();
    }
  }

  let newXml = paraXml;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    let t;
    if (splitAt === -1) {
      t = (i === 0) ? newText : '';
    } else if (i < splitAt) {
      t = (i === 0) ? labelText : '';
    } else if (i === splitAt) {
      t = valueText;
    } else {
      t = '';
    }
    const newRunXml = setRunText(run.xml, t);
    newXml = newXml.substring(0, run.idx) + newRunXml + newXml.substring(run.idx + run.len);
  }
  return newXml;
}

function cloneParaWithText(paraXml, newText) {
  return replaceParaText(paraXml, newText);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rebuild DOCX with optimized sections, preserving the original template formatting.
 *
 * v3 FIX: Uses sectionId-based matching instead of array index.
 * This is required because n8n now returns ALL sections (editable +
 * non-editable merged), and the _preserved flag tells us what to skip.
 */
function buildOptimizedDocx(optimizedSections) {
  if (!state.docxZip || !state.docxXml || !state.docxSections) return null;

  // Build a map of optimized sections by sectionId for O(1) lookup
  const optMap = new Map(optimizedSections.map(s => [s.sectionId, s]));

  const replacements = [];
  const paras = state.allParagraphs;

  state.docxSections.forEach(origSec => {
    // HARD GUARD: Never touch non-editable sections, regardless of AI output
    if (!isSectionEditable(origSec.heading)) return;

    const optSec = optMap.get(origSec.sectionId);
    if (!optSec || optSec._preserved) return;  // no AI output for this section

    if (origSec.type === 'bullets' && Array.isArray(optSec.content)) {
      origSec._bulletParaIndices.forEach((paraIdx, bi) => {
        const newText = optSec.content[bi];
        const para = paras[paraIdx];
        if (!newText || !para) return;
        replacements.push({ start: para.start, end: para.end, newXml: replaceParaText(para.xml, newText) });
      });

    } else if (origSec.type === 'text') {
      const rawContent = typeof optSec.content === 'string' ? optSec.content
        : Array.isArray(optSec.content) ? optSec.content.join('\n') : '';

      const newLines = rawContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      if (!newLines.length) return;

      const contentIndices = origSec._contentParaIndices || [];
      if (!contentIndices.length) return;

      const templatePara = paras[contentIndices[0]];
      if (!templatePara) return;

      const clonedXmls = newLines.map(line => cloneParaWithText(templatePara.xml, line));
      const lastContentIdx = contentIndices[contentIndices.length - 1];
      const lastPara = paras[lastContentIdx];
      const spanEnd = lastPara ? lastPara.end : templatePara.end;

      replacements.push({ start: templatePara.start, end: spanEnd, newXml: clonedXmls.join('') });
    }
  });

  // Apply replacements from end → start to keep char offsets valid
  replacements.sort((a, b) => b.start - a.start);
  let newXml = state.docxXml;
  for (const rep of replacements) {
    newXml = newXml.substring(0, rep.start) + rep.newXml + newXml.substring(rep.end);
  }

  try {
    const newZip = new PizZip(state.docxZip.generate({ type: 'arraybuffer' }));
    newZip.file('word/document.xml', newXml);
    return newZip.generate({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  } catch (e) {
    console.error('DOCX rebuild error:', e);
    return null;
  }
}

// ════════════════════════════════════════════════════
// FILE READING
// ════════════════════════════════════════════════════

function extractTextFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const ext = file.name.split('.').pop().toLowerCase();

    reader.onload = async (e) => {
      const buffer = e.target.result;

      if (ext === 'pdf') {
        // Basic PDF binary-to-text extraction
        const bytes = new Uint8Array(buffer);
        let text = '';
        for (let i = 0; i < bytes.length; i++) {
          const c = bytes[i];
          if ((c >= 32 && c <= 126) || c === 10 || c === 13 || c === 9) text += String.fromCharCode(c);
          else text += ' ';
        }
        const lines = text.split(/\n|\r/).map(l => l.trim())
          .filter(l => l.length > 3 && /[a-zA-Z]/.test(l) && !/^[^a-zA-Z]*$/.test(l))
          .join('\n');

        state.isDocx = false;
        if (lines.length < 100) {
          resolve({ text: '', warning: 'PDF text extraction limited. Consider pasting your resume text directly.' });
        } else {
          resolve({ text: lines.substring(0, CONFIG.MAX_RESUME_LENGTH) });
        }

      } else if (ext === 'docx' || ext === 'doc') {
        state.isDocx = true;

        if (typeof PizZip !== 'undefined') {
          try {
            const zip = new PizZip(buffer);
            const xmlStr = zip.files['word/document.xml']?.asText();
            if (!xmlStr) throw new Error('No document.xml found in DOCX');

            state.docxZip = zip;
            state.docxXml = xmlStr;

            const paras = parseDocxParagraphs(xmlStr);
            state.allParagraphs = paras;

            const sections = groupIntoSections(paras);
            state.docxSections = sections;

            const plainText = sections.map(s => {
              let t = s.heading ? s.heading + '\n' : '';
              if (Array.isArray(s.content)) t += s.content.join('\n');
              else if (s.content) t += s.content;
              return t;
            }).join('\n\n');

            if (plainText.trim().length < CONFIG.MIN_TEXT_LENGTH) {
              throw new Error('Could not extract enough text from DOCX structure.');
            }

            resolve({ text: plainText.substring(0, CONFIG.MAX_RESUME_LENGTH), docxParsed: true });
            return;
          } catch (zipErr) {
            console.warn('PizZip DOCX parse failed, falling back:', zipErr.message);
            state.docxZip = null; state.docxXml = null; state.docxSections = null;
          }
        }

        // Fallback: raw ASCII extraction
        const bytes = new Uint8Array(buffer);
        let raw = '';
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] >= 32 && bytes[i] < 127) raw += String.fromCharCode(bytes[i]);
        }
        const cleaned = raw.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .split(/\s+/).filter(w => w.length > 1 && /[a-zA-Z]/.test(w)).join(' ').replace(/\s{3,}/g, '\n');

        if (cleaned.length < 80) {
          resolve({ text: '', warning: 'DOCX extraction was limited. Please paste your resume text directly.' });
        } else {
          resolve({ text: cleaned.substring(0, CONFIG.MAX_RESUME_LENGTH) });
        }

      } else {
        reject(new Error('Unsupported file type. Use PDF or DOCX.'));
      }
    };

    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}

// ── FILE UPLOAD HANDLING ────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'doc', 'docx'].includes(ext)) {
    showNote('❌ Only PDF and DOCX files are supported.', 'error'); return;
  }
  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > CONFIG.MAX_FILE_SIZE_MB) {
    showNote(`❌ File is too large (${sizeMB.toFixed(1)} MB). Max ${CONFIG.MAX_FILE_SIZE_MB} MB.`, 'error'); return;
  }
  if (file.size === 0) {
    showNote('❌ This file appears to be empty (0 bytes). Please choose a valid file.', 'error'); return;
  }

  showNote('⏳ Reading file…');

  extractTextFromFile(file).then(({ text, warning, docxParsed }) => {
    if (text && text.length >= CONFIG.MIN_TEXT_LENGTH) {
      state.resumeText = text;
      state.resumeFileName = file.name;

      el.fileNameDisplay.textContent = file.name;
      const hint = docxParsed
        ? '✓ DOCX parsed — template-preserved download enabled'
        : `${sizeMB.toFixed(2)} MB · ${text.length.toLocaleString()} chars extracted`;
      el.fileMetaDisplay.textContent = hint;
      el.fileMetaDisplay.style.color = docxParsed ? 'var(--jade)' : '';
      el.uploadIdle.classList.add('hidden');
      el.uploadSuccess.classList.remove('hidden');
      showNote(
        warning ? `⚠ ${warning}` :
        docxParsed ? '✅ DOCX loaded with structure. Ready to analyze!' :
        '✅ Resume loaded. Add a job description to continue.',
        warning ? 'warn' : ''
      );
    } else {
      state.resumeText = ''; state.resumeFileName = file.name;
      el.fileNameDisplay.textContent = file.name;
      el.fileMetaDisplay.textContent = 'Extracted · Please verify text below';
      el.fileMetaDisplay.style.color = '';
      el.uploadIdle.classList.add('hidden');
      el.uploadSuccess.classList.remove('hidden');
      openPasteMode();
      showNote(`⚠ Auto-extraction had limited results for this ${ext.toUpperCase()}. Please paste your resume text in the box below.`, 'warn');
    }
    updateSubmitState();
  }).catch(err => {
    showNote(`❌ ${err.message}`, 'error');
    updateSubmitState();
  });
}

function openPasteMode() {
  state.pasteMode = true;
  el.pasteArea.classList.remove('hidden');
  el.togglePasteText.textContent = 'Hide text input';
  el.toggleArrow.classList.add('open');
}

el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); el.fileInput.click(); });
el.uploadZone.addEventListener('click', () => { if (!state.resumeText || state.pasteMode) el.fileInput.click(); });
el.fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });

el.uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); el.uploadZone.classList.add('drag-over'); });
el.uploadZone.addEventListener('dragleave', () => { el.uploadZone.classList.remove('drag-over'); });
el.uploadZone.addEventListener('drop', (e) => {
  e.preventDefault(); el.uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

el.removeFile.addEventListener('click', (e) => {
  e.stopPropagation();
  state.resumeText = ''; state.resumeFileName = '';
  state.isDocx = false; state.docxZip = null; state.docxXml = null;
  state.docxSections = null; state.allParagraphs = null;
  el.fileInput.value = '';
  el.uploadIdle.classList.remove('hidden');
  el.uploadSuccess.classList.add('hidden');
  el.resumePaste.value = '';
  updateSubmitState();
  showNote('Upload a resume and paste a job description to get started.');
});

el.togglePaste.addEventListener('click', () => {
  state.pasteMode = !state.pasteMode;
  el.pasteArea.classList.toggle('hidden', !state.pasteMode);
  el.togglePasteText.textContent = state.pasteMode ? 'Hide text input' : 'Or paste resume text instead';
  el.toggleArrow.classList.toggle('open', state.pasteMode);
});

el.resumePaste.addEventListener('input', () => {
  state.resumeText = el.resumePaste.value; updateSubmitState();
});

// ── JOB DESCRIPTION ────────────────────────────────────────────────
el.jobDesc.addEventListener('input', () => {
  state.jobDescription = el.jobDesc.value;
  const len = state.jobDescription.length;
  el.jdCounter.textContent = `${len.toLocaleString()} / ${CONFIG.MAX_JD_LENGTH.toLocaleString()} characters`;
  el.jdCounter.className = 'char-counter' + (len > CONFIG.MAX_JD_LENGTH ? ' over' : len > CONFIG.MAX_JD_LENGTH * 0.85 ? ' warn' : '');
  updateSubmitState();
});

// ── FORM VALIDATION ─────────────────────────────────────────────────
function updateSubmitState() {
  const hasResume  = state.resumeText.length >= CONFIG.MIN_TEXT_LENGTH;
  const hasJD      = state.jobDescription.length >= CONFIG.MIN_TEXT_LENGTH;
  const jdValid    = state.jobDescription.length <= CONFIG.MAX_JD_LENGTH;
  const resumeValid= state.resumeText.length <= CONFIG.MAX_RESUME_LENGTH;
  el.analyzeBtn.disabled = !(hasResume && hasJD && jdValid && resumeValid);
  if (!hasResume && !hasJD) showNote('Upload a resume and paste a job description to get started.');
  else if (!hasResume) showNote('⬆ Upload your resume or paste the text.');
  else if (!hasJD) showNote('📋 Now paste the job description.');
  else if (!jdValid) showNote(`❌ Job description too long (max ${CONFIG.MAX_JD_LENGTH.toLocaleString()} characters).`);
  else if (!resumeValid) showNote(`❌ Resume text too long (max ${CONFIG.MAX_RESUME_LENGTH.toLocaleString()} characters).`);
  else showNote('✅ Ready — click Analyze Resume to start.');
}

function showNote(msg, type) {
  el.analyzeNote.textContent = msg;
  el.analyzeNote.style.color = type === 'error' ? '#f43f5e' : type === 'warn' ? '#f59e0b' : '';
}

// ── LOADING STEPS ───────────────────────────────────────────────────
const LOAD_STEPS = ['ls-1', 'ls-2', 'ls-3', 'ls-4', 'ls-5'];
const LOAD_LABELS = [
  '✅ Extracting skills & keywords',
  '✅ Calculating match score',
  '✅ Running ATS compatibility check',
  '✅ Generating optimized resume',
  '✅ Compiling analysis report',
];
let loadingInterval;

function startLoadingAnimation() {
  let step = 0;
  LOAD_STEPS.forEach(id => { const e = $(id); e.textContent = e.textContent.replace('✅', '⬜'); e.classList.remove('done', 'active'); });
  $(LOAD_STEPS[0]).classList.add('active');
  loadingInterval = setInterval(() => {
    if (step < LOAD_STEPS.length) {
      $(LOAD_STEPS[step]).textContent = LOAD_LABELS[step];
      $(LOAD_STEPS[step]).classList.remove('active'); $(LOAD_STEPS[step]).classList.add('done');
      step++; if (step < LOAD_STEPS.length) $(LOAD_STEPS[step]).classList.add('active');
    } else { clearInterval(loadingInterval); }
  }, 3000);
}
function stopLoadingAnimation() { clearInterval(loadingInterval); }

// ── PANEL STATES ────────────────────────────────────────────────────
function showPanel(panel) {
  el.resultsEmpty.classList.add('hidden');
  el.resultsLoading.classList.add('hidden');
  el.resultsContent.classList.add('hidden');
  el.resultsError.classList.add('hidden');
  if (panel === 'empty')   el.resultsEmpty.classList.remove('hidden');
  if (panel === 'loading') el.resultsLoading.classList.remove('hidden');
  if (panel === 'results') el.resultsContent.classList.remove('hidden');
  if (panel === 'error')   el.resultsError.classList.remove('hidden');
}

// ════════════════════════════════════════════════════
// MAIN ANALYSIS
// ════════════════════════════════════════════════════
el.analyzeBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (state.isAnalyzing) return;
  state.isAnalyzing = true;
  state.optimizedBlob = null;
  hideDownloadSection();

  el.analyzeBtn.disabled = true;
  el.btnText.textContent = 'Analyzing…';
  el.btnIcon.textContent = '⏳';
  showPanel('loading');
  startLoadingAnimation();

  // Reset jobs tab
  resetJobsTab();

  // FIX v3: Only fire job search if JD is substantial (>100 chars)
  // Avoids wasting Jooble API calls on vague/empty descriptions
  if (state.jobDescription.length >= 100) {
    triggerJobSearch();
  }

  const payload = {
    resumeText:     state.resumeText,
    jobDescription: state.jobDescription,
    resumeFileName: state.resumeFileName || 'resume',
  };

  try {
    const response = await safeFetch(CONFIG.WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data = await safeParseJson(response);

    if (!response.ok || !data.success) {
      throw new Error(data.error || `Server error (HTTP ${response.status}). Please try again.`);
    }

    state.lastResult = data;
    stopLoadingAnimation();
    renderResults(data.data);
    showPanel('results');

    // Trigger optimizer after analysis succeeds
    triggerOptimize(data.data);

  } catch (err) {
    stopLoadingAnimation();
    el.errorMessage.textContent = humanizeError(err.message);
    showPanel('error');
  } finally {
    state.isAnalyzing = false;
    el.analyzeBtn.disabled = false;
    el.btnText.textContent = 'Analyze Resume';
    el.btnIcon.textContent = '→';
  }
}

// ════════════════════════════════════════════════════
// RESUME OPTIMIZER
// ════════════════════════════════════════════════════

async function triggerOptimize(analysisData) {
  if (!state.docxSections || state.docxSections.length === 0 || !state.docxZip) {
    // No DOCX structure — build a plain DOCX from AI's optimized content
    if (state.resumeFileName) {
      showDownloadBuilding();
      setTimeout(() => buildPlainDocxFromAI(analysisData), 500);
    }
    return;
  }

  showDownloadBuilding();

  const analysisHints = {
    keywordsToAdd: analysisData?.optimizedResume?.keywordsToAdd || [],
    missingSkills: analysisData?.skillAnalysis?.missingSkills   || [],
    quickWins:     analysisData?.analysisReport?.quickWins      || [],
  };

  try {
    const res = await safeFetch(CONFIG.OPTIMIZE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resumeSections: sectionsForApi(state.docxSections),  // style field stripped in v3
        jobDescription: state.jobDescription,
        analysisHints,
      }),
    });

    const data = await safeParseJson(res);

    if (!res.ok) {
      showDownloadError(data?.error || `Optimizer server error (HTTP ${res.status}).`);
      return;
    }

    if (data && data.success && data.optimizedSections) {
      let blob = null;
      try {
        blob = buildOptimizedDocx(data.optimizedSections);
      } catch (rebuildErr) {
        console.error('DOCX rebuild threw:', rebuildErr);
        blob = null;
      }
      if (blob) {
        const baseName = state.resumeFileName.replace(/\.[^.]+$/, '');
        state.optimizedBlob     = blob;
        state.optimizedFileName = `${baseName}_optimized.docx`;
        showDownloadReady(state.optimizedFileName, 'Rewritten to match this job description · Same template preserved');
      } else {
        showDownloadError('Could not rebuild the DOCX template. Your original resume formatting may be unusual — try the plain text paste option instead.');
      }
    } else {
      showDownloadError(humanizeError(data?.error || data?.warning || 'The optimizer did not return usable content. Please try again.'));
    }
  } catch (err) {
    console.warn('Optimizer failed:', err.message);
    showDownloadError(humanizeError(err.message || 'Could not generate the optimized resume.'));
  }
}

/** For PDF uploads: build a plain DOCX from AI suggestions (no template) */
function buildPlainDocxFromAI(analysisData) {
  try {
    const opt = analysisData?.optimizedResume || {};
    const summary = opt.summary || '';
    const improvements = (opt.improvements || []).map(imp => {
      if (typeof imp === 'object') return imp.improved || imp.original || JSON.stringify(imp);
      return imp;
    }).join('\n• ');

    const content = [
      summary,
      improvements ? `\nSuggested Improvements:\n• ${improvements}` : '',
    ].filter(Boolean).join('\n\n');

    if (!content.trim()) { hideDownloadSection(); return; }

    const xmlContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:aink="http://schemas.microsoft.com/office/drawing/2016/ink"
  xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:oel="http://schemas.microsoft.com/office/2019/extlst"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
  xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"
  xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"
  xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml"
  xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash"
  xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh wp14">
  <w:body>
    ${content.split('\n').map(line =>
      `<w:p><w:r><w:t xml:space="preserve">${line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</w:t></w:r></w:p>`
    ).join('\n    ')}
    <w:sectPr/>
  </w:body>
</w:document>`;

    if (typeof PizZip === 'undefined') {
      console.warn('PizZip not loaded, falling back to .txt download');
      const txtBlob = new Blob([content], { type: 'text/plain' });
      const baseName = (state.resumeFileName || 'resume').replace(/\.[^.]+$/, '');
      state.optimizedBlob     = txtBlob;
      state.optimizedFileName = `${baseName}_optimized.txt`;
      showDownloadReady(state.optimizedFileName, 'AI-optimized content (Plain Text format)');
      return;
    }

    const zip = new PizZip();
    zip.file('word/document.xml', xmlContent);
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

    const blob = zip.generate({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const baseName = (state.resumeFileName || 'resume').replace(/\.[^.]+$/, '');
    state.optimizedBlob     = blob;
    state.optimizedFileName = `${baseName}_optimized.docx`;
    showDownloadReady(state.optimizedFileName, 'AI-optimized content (Clean text template)');
  } catch (e) {
    console.warn('Plain DOCX build failed:', e.message);
    showDownloadError('Could not generate a downloadable file from the AI suggestions. You can still copy the optimized summary from the Optimized tab.');
  }
}

// ── Download section helpers ─────────────────────────────────────────
function showDownloadBuilding() {
  el.downloadSection.classList.remove('hidden');
  el.downloadBuilding.classList.remove('hidden');
  el.downloadReady.classList.add('hidden');
  el.downloadError.classList.add('hidden');
}
function showDownloadReady(filename, sublabel) {
  el.downloadSection.classList.remove('hidden');
  el.downloadBuilding.classList.add('hidden');
  el.downloadReady.classList.remove('hidden');
  el.downloadError.classList.add('hidden');
  el.downloadFilename.textContent = filename;
  el.downloadSublabel.textContent = sublabel || '';
}
function showDownloadError(msg) {
  el.downloadSection.classList.remove('hidden');
  el.downloadBuilding.classList.add('hidden');
  el.downloadReady.classList.add('hidden');
  el.downloadError.classList.remove('hidden');
  el.downloadErrorText.textContent = msg;
}
function hideDownloadSection() {
  el.downloadSection.classList.add('hidden');
  el.downloadBuilding.classList.add('hidden');
  el.downloadReady.classList.add('hidden');
  el.downloadError.classList.add('hidden');
}

el.downloadBtn.addEventListener('click', () => {
  if (!state.optimizedBlob) {
    showDownloadError('The optimized file is not ready yet. Please wait for it to finish building.');
    return;
  }
  try {
    const url = URL.createObjectURL(state.optimizedBlob);
    const a = document.createElement('a');
    a.href = url; a.download = state.optimizedFileName;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    console.error('Download failed:', err);
    showDownloadError('The download could not be started. Please try again.');
  }
});

// ════════════════════════════════════════════════════
// JOB FINDER
// ════════════════════════════════════════════════════

function resetJobsTab() {
  $('jobs-loading').classList.remove('hidden');
  $('jobs-content').classList.add('hidden');
  $('jobs-empty').classList.add('hidden');
  $('job-cards').innerHTML = '';
}

async function triggerJobSearch() {
  // Guard already checked in runAnalysis (>=100 chars), this is a safety net
  if (!state.jobDescription || state.jobDescription.length < 100) return;

  try {
    const res = await safeFetch(CONFIG.JOBS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jobDescription: state.jobDescription }),
    });
    const data = await safeParseJson(res);
    renderJobsTab(data);
  } catch (err) {
    console.warn('Job search failed:', err.message);
    renderJobsTab({ success: false, jobs: [], searchLinks: {}, _fetchError: err.message });
  }
}

const SOURCE_COLORS = {
  'LinkedIn':    { bg: 'rgba(10,102,194,.15)',  color: '#0a66c2', border: 'rgba(10,102,194,.25)' },
  'Naukri':      { bg: 'rgba(255,102,0,.12)',   color: '#ff6600', border: 'rgba(255,102,0,.25)' },
  'Indeed':      { bg: 'rgba(37,87,167,.12)',   color: '#2557a7', border: 'rgba(37,87,167,.25)' },
  'Glassdoor':   { bg: 'rgba(15,157,88,.12)',   color: '#0f9d58', border: 'rgba(15,157,88,.25)' },
  'Monster':     { bg: 'rgba(103,58,183,.12)',  color: '#6734b2', border: 'rgba(103,58,183,.25)' },
  'Shine':       { bg: 'rgba(255,165,0,.12)',   color: '#e69500', border: 'rgba(255,165,0,.25)' },
  'TimesJobs':   { bg: 'rgba(220,50,47,.12)',   color: '#dc322f', border: 'rgba(220,50,47,.25)' },
  'Foundit':     { bg: 'rgba(0,150,136,.12)',   color: '#009688', border: 'rgba(0,150,136,.25)' },
  'Internshala': { bg: 'rgba(38,198,218,.12)',  color: '#26c6da', border: 'rgba(38,198,218,.25)' },
  'Jooble':      { bg: 'rgba(99,102,241,.12)',  color: '#818cf8', border: 'rgba(99,102,241,.25)' },
};

function renderJobsTab(data) {
  $('jobs-loading').classList.add('hidden');

  const links = data.searchLinks || {};
  if (links.linkedin)  { const a = $('link-linkedin');  if (a) { a.href = links.linkedin;  a.removeAttribute('onClick'); } }
  if (links.naukri)    { const a = $('link-naukri');    if (a) { a.href = links.naukri;    a.removeAttribute('onClick'); } }
  if (links.indeed)    { const a = $('link-indeed');    if (a) { a.href = links.indeed;    a.removeAttribute('onClick'); } }
  if (links.google)    { const a = $('link-google');    if (a) { a.href = links.google;    a.removeAttribute('onClick'); } }
  if (links.glassdoor) { const a = $('link-glassdoor'); if (a) { a.href = links.glassdoor; a.removeAttribute('onClick'); } }

  const qLabel = $('jobs-query-label');
  if (qLabel && data.query) {
    const total = data.totalFound ? ` · ${data.totalFound.toLocaleString()} found` : '';
    qLabel.textContent = `Results for "${data.query.jobTitle}" in ${data.query.location}${total}`;
  }

  $('jobs-content').classList.remove('hidden');

  const jobs = data.jobs || [];
  const cardsDiv = $('job-cards');
  cardsDiv.innerHTML = '';

  if (!jobs.length) {
    $('jobs-empty').classList.remove('hidden');
    const emptyMsg = $('jobs-empty').querySelector('p');
    if (emptyMsg) {
      emptyMsg.textContent = data._fetchError
        ? `Couldn't load job listings: ${data._fetchError}. Use the platform links above to search directly.`
        : 'No listings returned. Use the platform links above to search directly.';
    }
    return;
  }

  jobs.forEach(job => {
    const sc = SOURCE_COLORS[job.source] || SOURCE_COLORS['Jooble'];
    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-card-top">
        <div class="job-card-main">
          <div class="job-title">${escHtml(job.title)}</div>
          <div class="job-company">${escHtml(job.company)}</div>
          <div class="job-meta">
            <span class="job-location">📍 ${escHtml(job.location)}</span>
            ${job.salary ? `<span class="job-salary">💰 ${escHtml(job.salary)}</span>` : ''}
            <span class="job-date">🕐 ${escHtml(job.postedDate)}</span>
          </div>
        </div>
        <span class="job-source-badge" style="background:${sc.bg};color:${sc.color};border:1px solid ${sc.border}">${escHtml(job.source)}</span>
      </div>
      ${job.snippet ? `<p class="job-snippet">${escHtml(job.snippet)}</p>` : ''}
      <div class="job-card-actions">
        <a class="job-apply-btn" href="${escHtml(job.url)}" target="_blank" rel="noopener">View Job →</a>
        ${state.optimizedBlob ? `<button class="job-download-btn" data-filename="${escHtml(state.optimizedFileName)}">⬇ Use Optimized Resume</button>` : ''}
      </div>
    `;
    cardsDiv.appendChild(card);
  });

  // Wire "Use Optimized Resume" buttons
  cardsDiv.querySelectorAll('.job-download-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.optimizedBlob) return;
      try {
        const url = URL.createObjectURL(state.optimizedBlob);
        const a = document.createElement('a');
        a.href = url; a.download = state.optimizedFileName;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) {
        console.error('Job card download failed:', err);
      }
    });
  });
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════════════════════════════════════════════════
// RESULTS RENDERER
// ════════════════════════════════════════════════════
function renderResults(d) {
  if (!d || typeof d !== 'object') {
    el.errorMessage.textContent = 'The analysis came back in an unexpected format. Please try again.';
    showPanel('error');
    return;
  }
  try {
    renderScoreHero(d);
    renderSkillsTab(d);
    renderATSTab(d);
    renderOptimizedTab(d);
    renderReportTab(d);
    activateTab('skills');
  } catch (err) {
    console.error('Error rendering results:', err);
    el.errorMessage.textContent = 'Something went wrong while displaying your results. Please try analyzing again.';
    showPanel('error');
  }
}

function renderScoreHero(d) {
  const score = d.matchScore || 0;
  const color = score >= 75 ? '#10b981' : score >= 50 ? '#f59e0b' : '#f43f5e';
  animateNumber($('score-number'), 0, score, 1200);
  const circumference = 326.7;
  const ring = $('ring-fill');
  ring.style.stroke = color;
  setTimeout(() => { ring.style.strokeDashoffset = circumference - (score / 100) * circumference; }, 100);
  $('score-verdict').textContent = d.matchVerdict || '—';
  $('score-verdict').style.color = color;
  $('score-rationale').textContent = d.matchRationale || '';
  const provider = d.metadata?.provider || d.uiHelpers?.aiProvider || 'AI';
  $('score-provider').textContent = `Powered by ${provider}`;
  const prob = d.analysisReport?.shortlistProbability;
  const shortlistEl = $('score-shortlist');
  shortlistEl.textContent = prob ? `${prob} Shortlist Chance` : '';
  shortlistEl.style.cssText = prob
    ? `background:${prob==='High'?'rgba(16,185,129,.15)':prob==='Medium'?'rgba(245,158,11,.15)':'rgba(244,63,94,.15)'};color:${prob==='High'?'#34d399':prob==='Medium'?'#fbbf24':'#fb7185'};border:1px solid ${prob==='High'?'rgba(16,185,129,.25)':prob==='Medium'?'rgba(245,158,11,.25)':'rgba(244,63,94,.25)'};padding:3px 10px;border-radius:99px;font-size:.68rem;font-weight:600`
    : '';
}

function renderSkillsTab(d) {
  const sa = d.skillAnalysis || {};
  renderTags('matching-skills', sa.matchingSkills, 'green');
  renderTags('missing-skills',  sa.missingSkills,  'red');
  renderTags('critical-skills', sa.criticalMissing,'yellow');
  renderTags('bonus-skills',    sa.bonusSkills,    'blue');
  const ka = d.keywordAnalysis || {};
  const kScore = ka.keywordDensityScore || 0;
  $('keyword-bar').style.width = kScore + '%';
  $('keyword-score-val').textContent = kScore + '%';
  $('keyword-suggestion').textContent = ka.suggestion || '';
  renderTags('matched-keywords', ka.matchedKeywords, 'default');
  renderTags('missing-keywords', ka.missingKeywords, 'missing');
  const ea = d.experienceAnalysis || {};
  $('exp-required').textContent  = ea.requiredYears  ? `${ea.requiredYears} yrs`  : '—';
  $('exp-candidate').textContent = ea.candidateYears ? `${ea.candidateYears} yrs` : '—';
  $('exp-level').textContent     = ea.levelMatch     || '—';
  $('exp-alignment').textContent = ea.roleAlignment  ? `${ea.roleAlignment}%`    : '—';
  $('exp-notes').textContent     = ea.notes          || '';
}

function renderATSTab(d) {
  const ats = d.atsScore || {};
  const overall = ats.overall || 0;
  animateNumber($('ats-score-num'), 0, overall, 1000);
  const passEl = $('ats-pass');
  passEl.textContent = ats.passesATS ? '✅ Passes ATS' : '❌ Fails ATS Check';
  passEl.className = 'ats-pass ' + (ats.passesATS ? 'pass' : 'fail');
  const b = ats.breakdown || {};
  setBar('ats-fmt',  'ats-fmt-val',  b.formatting, 25);
  setBar('ats-kw',   'ats-kw-val',   b.keywords,   25);
  setBar('ats-sec',  'ats-sec-val',  b.sections,   25);
  setBar('ats-read', 'ats-read-val', b.readability,25);
  renderList('ats-issues', ats.issues);
  renderList('ats-fixes',  ats.fixes);
}

function renderOptimizedTab(d) {
  const opt = d.optimizedResume || {};
  $('opt-summary').textContent = opt.summary || 'No optimized summary generated.';
  const impList = $('improvements-list');
  impList.innerHTML = '';
  (opt.improvements || []).forEach(imp => {
    const div = document.createElement('div');
    div.className = 'improvement-item';
    div.textContent = typeof imp === 'object' ? (imp.improved || imp.original || JSON.stringify(imp)) : imp;
    impList.appendChild(div);
  });
  renderTags('keywords-to-add', opt.keywordsToAdd, 'green');
  const secWrap = $('sections-to-add-wrap');
  if (opt.sectionsToAdd && opt.sectionsToAdd.length) {
    renderTags('sections-to-add', opt.sectionsToAdd, 'blue');
    secWrap.classList.remove('hidden');
  } else {
    secWrap.classList.add('hidden');
  }
}

function renderReportTab(d) {
  const r = d.analysisReport || {};
  renderList('report-strengths',  r.strengths);
  renderList('report-weaknesses', r.weaknesses);
  renderList('report-missing',    r.missingRequirements);
  renderOrderedList('report-quick', r.quickWins);
  renderOrderedList('report-recs',  r.recommendations);
  const prob = r.shortlistProbability || '—';
  const badge = $('verdict-badge');
  badge.textContent = prob;
  badge.style.cssText = `background:${prob==='High'?'rgba(16,185,129,.15)':prob==='Medium'?'rgba(245,158,11,.15)':'rgba(244,63,94,.15)'};color:${prob==='High'?'#34d399':prob==='Medium'?'#fbbf24':'#fb7185'};border:1px solid ${prob==='High'?'rgba(16,185,129,.25)':prob==='Medium'?'rgba(245,158,11,.25)':'rgba(244,63,94,.25)'}`;
  $('verdict-rationale').textContent = r.shortlistRationale || '';
}

// ── HELPERS ──────────────────────────────────────────────────────────
function renderTags(containerId, items, colorClass) {
  const container = $(containerId);
  container.innerHTML = '';
  if (!items || !items.length) {
    container.innerHTML = '<span style="font-size:.78rem;color:var(--muted)">None identified</span>';
    return;
  }
  items.forEach(item => {
    const span = document.createElement('span');
    span.className = 'tag';
    span.textContent = item;
    if (colorClass === 'missing') {
      span.style.cssText = 'background:rgba(244,63,94,.1);color:#fb7185;border:1px solid rgba(244,63,94,.2);padding:4px 10px;border-radius:99px;font-size:.72rem;font-weight:500';
    }
    container.appendChild(span);
  });
}
function renderList(id, items) {
  const c = $(id); c.innerHTML = '';
  if (!items || !items.length) { c.innerHTML = '<li style="color:var(--muted)">None identified</li>'; return; }
  items.forEach(item => { const li = document.createElement('li'); li.textContent = item; c.appendChild(li); });
}
function renderOrderedList(id, items) {
  const c = $(id); c.innerHTML = '';
  if (!items || !items.length) { c.innerHTML = '<li style="color:var(--muted)">None identified</li>'; return; }
  items.forEach(item => { const li = document.createElement('li'); li.textContent = item; c.appendChild(li); });
}
function setBar(barId, valId, val, max) {
  const v = Math.min(val || 0, max);
  setTimeout(() => { $(barId).style.width = ((v / max) * 100) + '%'; }, 200);
  $(valId).textContent = `${v}/${max}`;
}
function animateNumber(el, from, to, duration) {
  const start = performance.now();
  const update = (time) => {
    const t    = Math.min((time - start) / duration, 1);
    const ease = t < .5 ? 2*t*t : -1+(4-2*t)*t;
    el.textContent = Math.round(from + (to - from) * ease);
    if (t < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

// ── TAB NAVIGATION ───────────────────────────────────────────────────
function activateTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.toggle('active', tc.id === `tab-${tabName}`));
}
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

// ── ACTION BUTTONS ───────────────────────────────────────────────────
$('copy-json').addEventListener('click', () => {
  if (!state.lastResult) return;
  const jsonText = JSON.stringify(state.lastResult, null, 2);
  const btn = $('copy-json');

  const onSuccess = () => {
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.textContent = 'Copy Full JSON Report'; }, 2000);
  };
  const onFailure = () => {
    btn.textContent = '❌ Copy failed — try manually';
    setTimeout(() => { btn.textContent = 'Copy Full JSON Report'; }, 2500);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(jsonText).then(onSuccess).catch(onFailure);
  } else {
    // Fallback for non-secure contexts / older browsers
    try {
      const textarea = document.createElement('textarea');
      textarea.value = jsonText;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      ok ? onSuccess() : onFailure();
    } catch {
      onFailure();
    }
  }
});

// FIX v3: Removed the leftover debug string that was writing
// error info into download-building innerHTML on every click.
$('analyze-again').addEventListener('click', () => {
  state.lastResult = null;
  hideDownloadSection();
  showPanel('empty');
  window.scrollTo({ top: $('analyzer').offsetTop - 80, behavior: 'smooth' });
});

$('retry-btn').addEventListener('click', () => { showPanel('empty'); });

// ── INIT ─────────────────────────────────────────────────────────────
showPanel('empty');
updateSubmitState();

document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const target = document.querySelector(a.getAttribute('href'));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
