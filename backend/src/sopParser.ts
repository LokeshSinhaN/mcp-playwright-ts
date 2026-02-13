export type SopStepKind =
  | 'navigate'
  | 'click'
  | 'select'
  | 'type'
  | 'scrape'
  | 'save_excel'
  | 'upload_gdrive'
  | 'other';

export interface SopStep {
  index: number;
  raw: string;
  kind: SopStepKind;
  url?: string;
  fields?: string[];
}

export interface ParsedSop {
  steps: SopStep[];
  targetUrl?: string;
  scrapeFields?: string[];
  wantsExcel: boolean;
  wantsGDriveUpload: boolean;
}

function extractUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s,;"')]+/i);
  return m?.[0];
}

function normalizeLine(line: string): string {
  return line.replace(/^\s+|\s+$/g, '');
}

function splitCsvish(s: string): string[] {
  return s
    .split(/,|\n|\r\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => x.replace(/^[-–•]\s*/, ''));
}

function inferKind(raw: string): { kind: SopStepKind; url?: string; fields?: string[] } {
  const line = raw.trim();
  const lower = line.toLowerCase();

  const url = extractUrl(line);
  if (url || /\b(go to|navigate to|open)\b/.test(lower)) {
    return { kind: 'navigate', url };
  }

  // Scrape step like: "Scrape the following information, A, B, C"
  if (/\bscrape\b/.test(lower) || /\bextract\b/.test(lower)) {
    // attempt to grab field list after a colon/comma/keyword
    const after = line
      .replace(/^[^:]*:\s*/i, '')
      .replace(/^.*?\b(?:scrape|extract)\b\s*/i, '')
      .replace(/^the following information\s*,?\s*/i, '');
    const fields = splitCsvish(after);
    return { kind: 'scrape', fields: fields.length ? fields : undefined };
  }

  if (/\bexcel\b|\.xlsx\b/.test(lower) || /\bsave\b.*\bfile\b/.test(lower)) {
    return { kind: 'save_excel' };
  }

  if (/\bgoogle\s*drive\b|\bgdrive\b/.test(lower) || /\bupload\b.*\bdrive\b/.test(lower)) {
    return { kind: 'upload_gdrive' };
  }

  if (/\bselect\b|\bchoose\b/.test(lower)) return { kind: 'select' };
  if (/\btype\b|\benter\b|\bfill\b/.test(lower)) return { kind: 'type' };
  if (/\bclick\b|\bpress\b/.test(lower)) return { kind: 'click' };

  return { kind: 'other' };
}

export function parseSopText(rawText: string): ParsedSop {
  const text = String(rawText || '');
  const lines = text
    .split(/\r\n|\n/)
    .map(normalizeLine)
    .filter(Boolean)
    .filter(l => !/^--\s*\d+\s*of\s*\d+\s*--$/i.test(l))
    .filter(l => !/^content from\s+/i.test(l));

  const stepLines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*[\.)-]\s*(.+)$/);
    if (m?.[2]) {
      stepLines.push(m[2].trim());
      continue;
    }

    // fallback: bullet list
    const b = line.match(/^\s*[-–•]\s*(.+)$/);
    if (b?.[1]) {
      stepLines.push(b[1].trim());
      continue;
    }
  }

  // If nothing matched as steps, treat the entire input as a single step.
  if (stepLines.length === 0 && lines.length > 0) stepLines.push(lines.join(' '));

  const steps: SopStep[] = stepLines.map((raw, i) => {
    const inf = inferKind(raw);
    return {
      index: i,
      raw,
      kind: inf.kind,
      url: inf.url,
      fields: inf.fields
    };
  });

  const targetUrl = steps.map(s => s.url).find(Boolean) || extractUrl(text);
  const scrapeFields = steps.find(s => s.kind === 'scrape')?.fields;
  const wantsExcel = steps.some(s => s.kind === 'save_excel') || /\bexcel\b|\.xlsx\b/i.test(text);
  const wantsGDriveUpload = steps.some(s => s.kind === 'upload_gdrive') || /\bgoogle\s*drive\b|\bgdrive\b/i.test(text);

  return {
    steps,
    targetUrl,
    scrapeFields,
    wantsExcel,
    wantsGDriveUpload
  };
}
