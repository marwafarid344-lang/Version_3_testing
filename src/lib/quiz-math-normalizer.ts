/**
 * Safely normalizes LaTeX math notations without dangerous placeholder tokens.
 */
export function normalizeLatexMath(text?: string | null): string {
  if (!text || typeof text !== 'string') return text || '';

  // 1. Normalize \( ... \) to $ ... $ and \[ ... \] to $$ ... $$
  let s = text
    .replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$')
    .replace(/\\\(([\s\S]*?)\\\)/g, '$$1$');

  // 2. Fix unescaped limits e.g. lim_n\to\infty -> \lim_{n \to \infty}
  s = s.replace(/\blim_([a-zA-Z0-9]+)\\to\\infty/g, '\\lim_{$1 \\to \\infty}');
  s = s.replace(/\blim_\{([^}]+)\}\\to\\infty/g, '\\lim_{$1 \\to \\infty}');
  s = s.replace(/\blim_([a-zA-Z0-9]+)/g, '\\lim_{$1}');

  // 3. Auto-wrap unwrapped matrix and superscript expressions like (I-Q)^{-1}R
  s = s.replace(/(?<!\$)\b([A-Za-z0-9_()\[\]]*\([A-Za-z0-9+\-_]+\)\^\{?[a-zA-Z0-9\-+]+\}?[A-Za-z0-9_()\[\]]*)(?!\$)/g, (match) => {
    return `$${match}$`;
  });

  // 4. Heal any accidental placeholder artifacts if present
  s = s.replace(/_{0,}LATEX_TOKEN_\d+_{0,}/gi, '$m$');
  s = s.replace(/_{0,}MATH_TOKEN_\d+_{0,}/gi, '$m$');

  return s;
}

/**
 * Strips unnatural meta-referencing phrases from question text
 * e.g., "mentioned in the document?", "According to the document,", "بحسب ما ورد في المحاضرة", etc.
 */
export function cleanQuestionMetaPhrases(text?: string | null): string {
  if (!text || typeof text !== 'string') return text || '';
  let cleaned = text.trim();

  // 1. Strip parenthetical meta phrases:
  cleaned = cleaned.replace(/\s*\([^)]*(?:mentioned|stated|discussed|described|based on|covered|presented|given|provided|ورد|ذكر)[^)]*(?:document|lecture|text|notes|material|slides|file|مستند|محاضرة|ملف|نص)[^)]*\)/gi, '');

  // 2. Strip meta phrases from suffixes/endings:
  cleaned = cleaned.replace(/\s*(?:(?:as\s+)?(?:mentioned|stated|discussed|described|presented|covered|shown|given|provided)\s+in|(?:according\s+to|based\s+on))\s+(?:the\s+)?(?:provided\s+|given\s+)?(?:document|lecture|text|notes|material|slides|chapter|file|lesson)(?:\s+(?:\d+|[A-Za-z0-9_\-]+))?\s*(\?|\؟)?$/i, '$1');

  // Also strip mid-sentence meta clauses:
  cleaned = cleaned.replace(/[,\s]+(?:as\s+)?(?:mentioned|stated|discussed|described|presented|covered|shown|given|provided)\s+in\s+(?:the\s+)?(?:provided\s+|given\s+)?(?:document|lecture|text|notes|material|slides|chapter|file|lesson)(?:\s+(?:\d+|[A-Za-z0-9_\-]+))?[,\s]*/gi, ' ');

  // 3. Strip meta prefixes from beginning:
  cleaned = cleaned.replace(/^(?:(?:According to|Based on|From|In)\s+(?:the\s+)?(?:provided\s+|given\s+)?(?:document|lecture|text|notes|material|slides|chapter|file|lesson)(?:\s+(?:\d+|[A-Za-z0-9_\-]+))?|(?:As\s+)?(?:mentioned|stated|discussed|described|presented|covered|shown|given|provided)\s+in\s+(?:the\s+)?(?:provided\s+|given\s+)?(?:document|lecture|text|notes|material|slides|chapter|file|lesson)(?:\s+(?:\d+|[A-Za-z0-9_\-]+))?)[،,:\s]*/i, '');

  // 4. Arabic meta phrases:
  // Prefixes
  cleaned = cleaned.replace(/^(?:وفقاً\s*(?:لـ?|لما ورد في |لما جاء في )?|بحسب\s*(?:ما ورد في |ما جاء في )?|بناءً على\s*(?:ما ورد في )?|طبقاً\s*(?:لـ?|لما ورد في )?|كما ورد في |كما ذُ?كر في |حسب |استناداً إلى )(?:المستند|المحاضرة|الملف|النص|السياق|المذكرة|المادة)(?:\s*(?:المرفق|المعطى|المقدم|المذكور))?[،,\s]*/i, '');
  
  // Suffixes
  cleaned = cleaned.replace(/[،,\s]*(?:وفقاً\s*(?:لـ?|لما ورد في )?|بحسب\s*(?:ما ورد في )?|بناءً على |طبقاً لـ?|كما ورد في |كما ذُ?كر في |حسب |المذكور(?:ة)? في |الوارد(?:ة)? في )(?:المستند|المحاضرة|الملف|النص|السياق|المذكرة)(?:\s*(?:المرفق|المعطى|المقدم))?\s*(\؟|\?)?$/i, '$1');

  // Mid-sentence Arabic meta clauses
  cleaned = cleaned.replace(/[،,\s]*(?:المذكور(?:ة)?|الوارد(?:ة)?|المبين(?:ة)?|الموضح(?:ة)?)\s+في\s+(?:المستند|المحاضرة|الملف|النص|المذكرة)[،,\s]*/gi, ' ');

  // 5. Clean up multiple spaces and leading/trailing punctuation artifacts
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/^[،,\-:\s]+/, '');
  cleaned = cleaned.replace(/\s+\?$/, '?');
  cleaned = cleaned.replace(/\s+\؟$/, '؟');

  // Ensure English capitalization
  if (cleaned.length > 0 && /^[a-z]/.test(cleaned)) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned.trim();
}

/**
 * Extracts any embedded Markdown/LaTeX table from the question prompt so it can be viewed in a separate reference modal.
 */
export function extractTableFromQuestion(question?: string | null, existingTable?: string | null): { question: string; table: string | null } {
  if (existingTable && typeof existingTable === 'string' && existingTable.trim().length > 0) {
    return { question: (question || '').trim(), table: existingTable.trim() };
  }

  let q = question || '';
  let extractedTable: string | null = null;

  // 1. Check for Markdown GFM table inside question
  const mdTableRegex = /(\|[^\n]+\|\r?\n\|[-:\s|]+\|\r?\n(?:\|[^\n]+\|\r?\n?)+)/m;
  const mdMatch = q.match(mdTableRegex);
  if (mdMatch) {
    extractedTable = mdMatch[1].trim();
    q = q.replace(mdMatch[1], '').trim();
  }

  // 2. Check for LaTeX array or tabular inside question
  const latexTableRegex = /(\\begin\{(?:array|tabular|matrix|pmatrix|bmatrix)\}[\s\S]*?\\end\{(?:array|tabular|matrix|pmatrix|bmatrix)\})/m;
  const latexMatch = q.match(latexTableRegex);
  if (latexMatch && !extractedTable) {
    extractedTable = latexMatch[1].trim();
    q = q.replace(latexMatch[1], '').trim();
  }

  return {
    question: q.trim(),
    table: extractedTable
  };
}

/**
 * Normalizes all fields of a quiz question item (question, options, answer, explanation, table).
 * Enforces strictly 4 options (A, B, C, D), clean letter prefixes, exact answer matching, stripped meta-phrases, and isolated reference tables.
 */
export function normalizeQuizQuestionItem(q: any): any {
  if (!q || typeof q !== 'object') return q;

  // Extract separate reference table if present or embedded, supporting all LLM key aliases
  const rawQ = q.question || q.prompt || q.text || q.questionText || q.title || '';
  const { question: extractedQ, table: rawTable } = extractTableFromQuestion(rawQ, q.table);
  const normalizedQuestion = cleanQuestionMetaPhrases(normalizeLatexMath(extractedQ));
  const normalizedTable = rawTable ? normalizeLatexMath(rawTable) : null;
  const rawExplanation = q.explanation || q.rationale || q.solution || q.reason || '';
  const normalizedExplanation = rawExplanation ? normalizeLatexMath(rawExplanation) : rawExplanation;
  
  let rawOptions: string[] = Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : []);

  const isTrueFalse = q.type === 'True/False' || (rawOptions.length === 2 && rawOptions.some(o => /true|false|صح|خطأ/i.test(o)));
  const finalType = isTrueFalse ? 'True/False' : (q.type || 'Multiple Choice');

  // Clamp strictly to 2 options for True/False or 4 options (A, B, C, D) for MCQ
  if (isTrueFalse) {
    rawOptions = rawOptions.slice(0, 2);
  } else if (rawOptions.length > 4) {
    const ansCandidate = q.answer || q.correct_answer || q.correctAnswer || '';
    const ansClean = String(ansCandidate).replace(/^[A-Z]\s*[\).\-]\s*/i, '').trim();
    const ansIdx = rawOptions.findIndex(opt => opt.replace(/^[A-Z]\s*[\).\-]\s*/i, '').trim() === ansClean);
    if (ansIdx >= 4) {
      rawOptions = [rawOptions[0], rawOptions[1], rawOptions[2], rawOptions[ansIdx]];
    } else {
      rawOptions = rawOptions.slice(0, 4);
    }
  }

  // Ensure standard prefixes (A), B), C), D))
  const letters = ['A', 'B', 'C', 'D'];
  const formattedOptions = rawOptions.map((opt, idx) => {
    const letter = letters[idx] || 'A';
    const cleanedText = typeof opt === 'string' ? opt.replace(/^[A-Z]\s*[\).\-]\s*/i, '').trim() : String(opt);
    return `${letter}) ${normalizeLatexMath(cleanedText)}`;
  });

  // Ensure answer matches one of the formatted options (supporting letter-only e.g. "B" or full text)
  let rawAns = q.answer || q.correct_answer || q.correctAnswer || q.correct || '';
  let normalizedAnswer = rawAns;
  if (typeof rawAns === 'string' && formattedOptions.length > 0) {
    const origAnswerClean = rawAns.replace(/^[A-Z]\s*[\).\-]\s*/i, '').trim();
    const match = formattedOptions.find(opt => {
      const optClean = opt.replace(/^[A-Z]\s*[\).\-]\s*/i, '').trim();
      const letterMatch = opt.match(/^([A-Z])[\).\-]/i);
      const letter = letterMatch ? letterMatch[1].toUpperCase() : '';
      return (
        (origAnswerClean && optClean.toLowerCase() === origAnswerClean.toLowerCase()) ||
        opt.trim().toLowerCase() === rawAns.trim().toLowerCase() ||
        (rawAns.trim().length === 1 && letter === rawAns.trim().toUpperCase())
      );
    });
    normalizedAnswer = match || formattedOptions[0];
  }

  return {
    ...q,
    type: finalType,
    question: normalizedQuestion,
    table: normalizedTable,
    options: formattedOptions,
    answer: normalizedAnswer,
    explanation: normalizedExplanation
  };
}

/**
 * Robust JSON parser with automatic error repair for unescaped newlines,
 * unescaped LaTeX backslashes, trailing commas, and unterminated strings.
 */
export function safeJsonParseWithRepair<T = any>(rawText: string, fallback: T): T {
  if (!rawText || typeof rawText !== 'string') return fallback;

  // 1. Strip markdown code fences if present
  let cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  // 2. Fix unescaped control characters in JSON strings (newlines, tabs)
  try {
    // Replace unescaped raw newlines inside string literals
    let inString = false;
    let isEscaped = false;
    let sanitized = '';

    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (char === '"' && !isEscaped) {
        inString = !inString;
      }
      if (inString && char === '\n') {
        sanitized += '\\n';
      } else if (inString && char === '\r') {
        // drop raw carriage return
      } else if (inString && char === '\t') {
        sanitized += '\\t';
      } else {
        sanitized += char;
      }
      isEscaped = char === '\\' && !isEscaped;
    }

    // Try parse sanitized
    try {
      return JSON.parse(sanitized);
    } catch (_) {
      cleaned = sanitized;
    }
  } catch (_) {}

  // 3. Attempt repairing unterminated string or object truncation
  try {
    let repaired = cleaned;
    // Remove trailing trailing comma
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    // Balance brackets if truncated
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;

    // If inside an open quote, close it
    const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      repaired += '"';
    }

    for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
    for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';

    return JSON.parse(repaired);
  } catch (_) {}

  // 4. Fallback: extract questions array using regex if whole object failed
  try {
    const qMatches = cleaned.match(/\{[^{}]*"question"[^{}]*\}/g);
    if (qMatches && qMatches.length > 0) {
      const questions: any[] = [];
      for (const qStr of qMatches) {
        try {
          questions.push(JSON.parse(qStr));
        } catch (_) {}
      }
      if (questions.length > 0) {
        return { questions } as unknown as T;
      }
    }
  } catch (_) {}

  return fallback;
}
