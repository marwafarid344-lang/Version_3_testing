import { NextRequest, NextResponse } from 'next/server';
import { getServerStudentSession } from '@/lib/auth-server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, RateLimitTier } from '@/lib/rate-limit';
import { google } from 'googleapis';
import pdf from 'pdf-parse';
import { getCachedAIResult, setCachedAIResult } from '@/lib/persistent-ai-cache';
import { normalizeQuizQuestionItem, safeJsonParseWithRepair } from '@/lib/quiz-math-normalizer';

const pdfParse = pdf;

import { GROQ_MODELS, OPENROUTER_MODELS } from "@/lib/drive-ai-orchestrator";
import { getProviderSecrets, getProviderLayerInfo } from "@/lib/marline/providers/config";
import { marlineRouter } from "@/lib/marline/router";
import { estimateTokens } from "@/lib/token-budget-manager";
import { incrementUserConsumedTokens } from "@/lib/capi-reqs";

export async function GET(req: NextRequest) {
  try {
    const session = await getServerStudentSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const supabaseAdmin = createAdminClient() as any;
    const { data: userRecord } = await supabaseAdmin
      .from('chameleons')
      .select('ai_credits')
      .eq('auth_id', session.auth_id)
      .single();

    return NextResponse.json({
      credits: userRecord?.ai_credits ?? 20,
      maxCredits: 20
    });
  } catch (err: any) {
    return NextResponse.json({ credits: 20, maxCredits: 20 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const secrets = getProviderSecrets();
    const hasConfiguredProvider = Object.values(secrets).some((s: any) => s.isConfigured);

    if (!hasConfiguredProvider) {
      console.error("[Marline Drive AI] Missing AI provider keys");
      return NextResponse.json({ error: 'Server configuration error: Missing AI API keys' }, { status: 500 });
    }

    const session = await getServerStudentSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized: Please log in' }, { status: 401 });
    }

    const rateLimit = checkRateLimit(session.auth_id, RateLimitTier.AI);
    if (!rateLimit.success) {
      return NextResponse.json({
        error: 'Daily limit reached. You can perform 20 AI actions per day.',
        reset: rateLimit.reset
      }, { status: 429 });
    }

    const {
      fileId,
      task,
      language = 'English',
      messages = [],
      questionCount = 8,
      questionType = 'all'
    } = await req.json();

    if (!fileId) {
      return NextResponse.json({ error: 'Missing fileId' }, { status: 400 });
    }

    // Clamp question count to a sane range so the model isn't abused into huge outputs (supports up to 50 questions)
    const safeQuestionCount = Math.min(Math.max(parseInt(String(questionCount), 10) || 8, 1), 50);

    const drive = google.drive({
      version: 'v3',
      auth: process.env.GOOGLE_DRIVE_API_KEY
    });

    const metadataResponse = await drive.files.get({
      fileId: fileId,
      fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink, thumbnailLink, parents'
    });
    const metadata = metadataResponse.data;

    const MAX_FILE_SIZE = 15 * 1024 * 1024;
    if (metadata.size && parseInt(metadata.size) > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File is too large. Maximum size is 15MB.' }, { status: 413 });
    }

    let fileContent = '';

    try {
      if (metadata.mimeType === 'application/vnd.google-apps.document') {
        const exportResponse = await drive.files.export(
          { fileId, mimeType: 'text/plain' },
          { responseType: 'text' }
        );
        fileContent = exportResponse.data as string;
      } else if (metadata.mimeType === 'application/pdf') {
        const dlResponse = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const buffer = Buffer.from(dlResponse.data as ArrayBuffer);
        const data = await pdfParse(buffer);
        fileContent = data.text || '';

        // Scanned PDF Exam OCR Fallback using Gemini Vision if text is empty/very short
        if (fileContent.trim().length < 60) {
          const geminiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
          if (geminiKey) {
            try {
              console.log("[Marline OCR] Scanned PDF detected, activating Vision OCR via Gemini 2.5 Flash...");
              const base64Data = buffer.toString('base64');
              const ocrRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'application/pdf',
                          data: base64Data
                        }
                      },
                      {
                        text: "Extract and transcribe all exam questions, choices, formulas, and text from this scanned exam PDF completely with utmost fidelity. Output verbatim text and LaTeX math formulas."
                      }
                    ]
                  }],
                  generationConfig: {
                    maxOutputTokens: 8192,
                    temperature: 0.1
                  }
                })
              });
              if (ocrRes.ok) {
                const ocrJson = await ocrRes.json();
                const transcribed = ocrJson?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (transcribed && transcribed.trim().length > fileContent.trim().length) {
                  fileContent = transcribed;
                  console.log(`[Marline OCR] Successfully transcribed ${fileContent.length} chars from scanned PDF!`);
                }
              }
            } catch (ocrErr) {
              console.warn("[Marline OCR] Scanned PDF OCR fallback failed:", ocrErr);
            }
          }
        }
      } else if (metadata.mimeType?.startsWith('image/')) {
        // Image files (JPG, PNG, WEBP) OCR extraction
        const dlResponse = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const buffer = Buffer.from(dlResponse.data as ArrayBuffer);
        const geminiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
        if (geminiKey) {
          try {
            console.log("[Marline OCR] Exam Image detected, transcribing via Gemini Vision...");
            const base64Data = buffer.toString('base64');
            const ocrRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{
                  parts: [
                    {
                      inlineData: {
                        mimeType: metadata.mimeType || 'image/png',
                        data: base64Data
                      }
                    },
                    {
                      text: "Transcribe all exam questions, choices, equations, and diagrams from this image exam clearly and verbatim."
                    }
                  ]
                }],
                generationConfig: {
                  maxOutputTokens: 8192,
                  temperature: 0.1
                }
              })
            });
            if (ocrRes.ok) {
              const ocrJson = await ocrRes.json();
              fileContent = ocrJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            }
          } catch (imgErr) {
            console.warn("[Marline OCR] Image OCR failed:", imgErr);
          }
        }
      } else if (metadata.mimeType?.startsWith('text/') || metadata.mimeType === 'application/json') {
        const dlResponse = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const buffer = Buffer.from(dlResponse.data as ArrayBuffer);
        fileContent = buffer.toString('utf-8');
      }
    } catch (extractError) {
      console.error("[Marline Drive AI] Error extracting file content:", extractError);
      fileContent = `Document Name: ${metadata.name || 'Academic File'}`;
    }

    // Clean excessive blank lines and whitespace to maximize information density per character
    const cleanedFileContent = fileContent.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // Support large lectures for Semantic Chunking / Map-Reduce (up to 140,000 chars)
    const MAX_CONTEXT_CHARS = (task === 'summarize' || task === 'solve-exam') ? 140000 : 35000;
    const sanitizedContext = cleanedFileContent.length > MAX_CONTEXT_CHARS
      ? cleanedFileContent.slice(0, MAX_CONTEXT_CHARS) + "\n\n[... Remaining content truncated for performance ...]"
      : cleanedFileContent;

    // Dynamic token cost calculation:
    // Scale smoothly from 1 to 10 tokens max based on extracted document size:
    const baseLength = Math.max(sanitizedContext.length, 1000);
    const dynamicTokenCost = Math.min(10, Math.max(1, Math.ceil(baseLength / 3500)));

    const supabaseAdmin = createAdminClient() as any;
    let currentCredits = 20;

    try {
      const { data: userRecord } = await supabaseAdmin
        .from('chameleons')
        .select('ai_credits')
        .eq('auth_id', session.auth_id)
        .single();
      if (userRecord && typeof userRecord.ai_credits === 'number') {
        currentCredits = userRecord.ai_credits;
      }
    } catch (err) {
      console.warn("[Marline AI] Could not query ai_credits:", err);
    }

    if (currentCredits < dynamicTokenCost) {
      return NextResponse.json({
        error: `رصيد الـ AI غير كافٍ. يتطلب هذا الملف ${dynamicTokenCost} نقطة، ورصيدك الحالي ${currentCredits} نقطة من 20. يتم تجديد الرصيد يومياً!`,
        remainingCredits: currentCredits,
        requiredCredits: dynamicTokenCost
      }, { status: 429 });
    }

    // Helper to deduct credits in database
    const deductCredits = async () => {
      const newCredits = Math.max(0, currentCredits - dynamicTokenCost);
      try {
        await supabaseAdmin
          .from('chameleons')
          .update({ ai_credits: newCredits })
          .eq('auth_id', session.auth_id);
      } catch (err) {
        console.warn("[Marline AI] Failed to update ai_credits in DB:", err);
      }
    };

    // 1. PERSISTENT CACHE LOOKUP
    const isCoreTask = task === 'summarize' || task === 'quiz' || task === 'translate' || task === 'solve-exam';
    const shouldCache = isCoreTask && messages.length === 0 && sanitizedContext.length > 0;
    const cacheTaskKey = task === 'quiz' ? `quiz:${safeQuestionCount}:${questionType}` : task;

    if (shouldCache) {
      const cachedResult = await getCachedAIResult(sanitizedContext, cacheTaskKey, language);
      if (cachedResult) {
        console.log(`[Marline Cache Hit] Instantly returning cached result for ${cacheTaskKey} in ${language}.`);
        await deductCredits();
        if (task === 'quiz' || task === 'solve-exam') {
          return NextResponse.json({ result: cachedResult }, {
            headers: {
              'X-AI-Credits-Remaining': Math.max(0, currentCredits - dynamicTokenCost).toString(),
              'X-AI-Credits-Cost': dynamicTokenCost.toString()
            }
          });
        } else {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              const chunk = `data: ${JSON.stringify({
                choices: [{ delta: { content: cachedResult } }]
              })}\n\n`;
              controller.enqueue(encoder.encode(chunk));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });
          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'X-AI-Credits-Remaining': Math.max(0, currentCredits - dynamicTokenCost).toString(),
              'X-AI-Credits-Cost': dynamicTokenCost.toString()
            },
          });
        }
      }
    }

    // 2. QUIZ GENERATION TASK (High-Yield Academic Assessment with MCQ & True/False Support)
    if (task === 'quiz') {
      const typeRule = questionType === 'true_false'
        ? `QUESTION TYPE REQUIREMENT: Generate 100% "True/False" questions. Every question must have type "True/False" and EXACTLY 2 options: ["A) True", "B) False"] (or Arabic equivalent if language is Arabic).`
        : questionType === 'mcq'
        ? `QUESTION TYPE REQUIREMENT: Generate 100% "Multiple Choice" questions. Every question must have type "Multiple Choice" and EXACTLY 4 options (A, B, C, D).`
        : `QUESTION TYPE REQUIREMENT: Generate a high-yield mix of questions: approximately 70% "Multiple Choice" (with 4 options A, B, C, D) and approximately 30% "True/False" (with type "True/False" and 2 options: ["A) True", "B) False"]).`;

      const quizSystemPrompt = `You are Marline AI, an elite academic exam creator and assessment specialist.
Language: ${language}.

Your mission: Generate a JSON object containing EXACTLY ${safeQuestionCount} questions grounded STRICTLY and EXCLUSIVELY in the provided document text.

${typeRule}

JSON SCHEMA:
{
  "questions": [
    {
      "numb": 1,
      "type": "Multiple Choice" or "True/False",
      "question": "Direct academic question in ${language} with LaTeX math like $p_{ij}$",
      "table": "Optional GFM table or LaTeX array with reference dataset/matrix needed for this question, or null if not needed",
      "options": [
        "A) Option 1",
        "B) Option 2"
      ],
      "answer": "A) Exact string matching one of the options above",
      "explanation": "Concise 1-2 sentence explanation of why this answer is correct based strictly on the document"
    }
  ]
}

CRITICAL ANTI-HALLUCINATION & STRICT GROUNDING RULES:
1. ZERO EXTERNAL INFORMATION: Every single question, option, answer, and explanation MUST be derived 100% directly from the provided text content. Do NOT use outside knowledge, external facts, or unmentioned topics.
2. NO FABRICATION OR SPECULATION: Do NOT invent formulas, dates, names, terms, or statistics that are not present in the document.
3. EXACT COUNT GUARANTEE: You MUST generate EXACTLY ${safeQuestionCount} questions. Never fewer, never more.
4. OPTION FORMATTING: For Multiple Choice questions, provide EXACTLY 4 options (A, B, C, D). For True/False questions, provide EXACTLY 2 options (A) True, B) False).
5. OPTION CONCISENESS (NO ESSAYS): Options MUST be short, crisp choices (maximum 15-20 words, 1-2 lines). NEVER write long multi-sentence paragraphs as options.
6. EXACT ANSWER MATCH: The "answer" field MUST be an exact character-for-character copy of one of the options strings.
7. MATHEMATICAL FORMULAS (LaTeX): Enclose all mathematical notations, symbols ($P$, $\\pi$, $p_{ij}$), matrices, and formulas strictly inside single dollar signs $...$.
8. HIGH-YIELD RIGOR: Test conceptual understanding, definitions, derivations, and distinctions explicitly discussed in the source document.
9. NO META-REFERENCES IN QUESTIONS: NEVER use phrases like "According to the document", "As mentioned in the lecture", "Based on the text", "In the provided notes", "وفقاً للمستند", "بحسب المحاضرة", "المذكور في الملف", etc. Formulate every question directly, naturally, and academically.
10. AUTHENTIC RAW REFERENCE TABLES FOR CALCULATIONS:
   - When creating questions that require calculation or data analysis, place the COMPLETE RAW DATASET / TABLE in the "table" field (or null if not needed).
   - In the "explanation" field, provide the complete formula and step-by-step calculation.`;

      // Sample representative document content if oversized to ensure questions span the entire lecture
      let quizContext = sanitizedContext || metadata.name || 'Academic File';
      if (quizContext.length > 28000) {
        const head = quizContext.slice(0, 10000);
        const mid = quizContext.slice(Math.floor(quizContext.length / 2) - 5000, Math.floor(quizContext.length / 2) + 5000);
        const tail = quizContext.slice(-8000);
        quizContext = `${head}\n\n[... Section Break ...]\n\n${mid}\n\n[... Section Break ...]\n\n${tail}`;
      }

      const quizMessages = [
        { role: "system", content: quizSystemPrompt },
        { role: "user", content: `Source Document: "${metadata.name || 'Lecture Notes'}"\n\nContent:\n${quizContext}\n\nGenerate EXACTLY ${safeQuestionCount} questions in ${language} matching the requested type distribution. Ground all questions, options, and answers 100% in this content only without adding any external topics. Output valid JSON.` }
      ];

      let lastError = "";

      try {
        const quizGenResponse = await marlineRouter.executeGenerateWithFallback(
          {
            messages: quizMessages as any,
            responseFormat: { type: 'json_object' },
            maxTokens: Math.min(480 * safeQuestionCount, 7500),
            temperature: 0.05,
          },
          {
            task: 'quiz',
            inputTokens: estimateTokens(JSON.stringify(quizMessages)),
            desiredOutputTokens: Math.min(480 * safeQuestionCount, 7500),
            requiresJsonMode: true,
          }
        );

        const rawContent = quizGenResponse.content || "";
        const parsed = safeJsonParseWithRepair<any>(rawContent, { questions: [] });
        let finalQuestions: any[] = Array.isArray(parsed) ? parsed : (parsed?.questions || []);

        if (finalQuestions.length > 0) {
          // Strictly enforce EXACT question count requested by user
          if (finalQuestions.length > safeQuestionCount) {
            finalQuestions = finalQuestions.slice(0, safeQuestionCount);
          }

          // Ensure proper numbering and LaTeX math normalization
          finalQuestions.forEach((q: any, idx: number) => { q.numb = idx + 1; });
          const normalizedQuestions = finalQuestions.map(normalizeQuizQuestionItem);
          await deductCredits();

          // Increment CAPI_REQS with real consumed tokens (prompt + completion)
          const consumedTokens = quizGenResponse.usage?.totalTokens
            || (estimateTokens(JSON.stringify(quizMessages)) + estimateTokens(rawContent));
          await incrementUserConsumedTokens(session.auth_id, consumedTokens);

          if (shouldCache) {
            await setCachedAIResult(sanitizedContext, cacheTaskKey, language, normalizedQuestions);
          }
          const { tier, tierLabel } = getProviderLayerInfo(quizGenResponse.provider);

          return NextResponse.json({ result: normalizedQuestions }, {
            headers: {
              'X-AI-Credits-Remaining': Math.max(0, currentCredits - dynamicTokenCost).toString(),
              'X-AI-Credits-Cost': dynamicTokenCost.toString(),
              'X-AI-Tier': tier,
              'X-AI-Tier-Label': tierLabel,
              'X-AI-Provider': quizGenResponse.provider,
              'X-AI-Model': quizGenResponse.model
            }
          });
        }
      } catch (err: any) {
        lastError = err.message || String(err);
      }

      return NextResponse.json({ error: `Failed to generate quiz: ${lastError}` }, { status: 502 });
    }

    // 2.5 EXAM SOLVER TASK (Solves Past Exam Files with Step-by-Step Solutions & Quiz Conversion)
    if (task === 'solve-exam') {
      const examSolverSystemPrompt = `You are Marline AI, an elite university professor, examiner, and master exam problem solver.
Language: ${language}.

Your mission:
1. Thoroughly parse the provided previous exam / quiz document.
2. Identify every question in the paper (whether it was previously solved or unsolved).
3. If an answer was already marked in the document, rigorously verify whether it is scientifically and mathematically correct.
4. If it is unsolved, compute and provide the 100% verified correct answer.
5. Provide a step-by-step rigorous explanation for every solution with complete LaTeX formulas ($...$).
6. Format all questions into clean interactive multiple-choice or true/false items so students can solve them live in our Quiz Interface or download the complete solved paper as a PDF.

JSON SCHEMA:
{
  "examTitle": "Title of the Exam / Course Name",
  "questions": [
    {
      "numb": 1,
      "type": "Multiple Choice",
      "question": "Exact question text from the exam with LaTeX math like $G(s) = \\frac{s+1}{s^2+2s+2}$",
      "table": null,
      "options": [
        "A) Option 1",
        "B) Option 2",
        "C) Option 3",
        "D) Option 4"
      ],
      "answer": "A) Exact string matching the verified correct answer",
      "explanation": "Detailed step-by-step mathematical derivation and conceptual solution explaining why this answer is correct."
    }
  ]
}

CRITICAL RULES:
- Extract and solve EVERY SINGLE QUESTION found in the provided exam chunk without skipping or stopping early.
- Keep the explanation for each question concise, direct, and rigorous (2-3 sentences max) to ensure ALL questions fit in the response.
- Ground every solution strictly in authentic academic curriculum facts and derivations.
- Ensure all mathematical equations and formulas use proper LaTeX enclosed in single dollar signs $...$.
- Output valid JSON only. Do not add keys outside the schema.`;

      // Helper function to split large exam text into question segments if text is long (> 6,000 chars)
      const splitExamIntoQuestionChunks = (text: string): string[] => {
        if (text.length <= 7000) return [text];

        // Split by question number headers (e.g. "Question 1", "Q1", "1.", "1 -", etc.)
        const questionSplitPattern = /(?:\n|^)(?=(?:Question|Q\.?|Problem|\d+[\.\-\)]\s+))/i;
        const rawSegments = text.split(questionSplitPattern).filter(s => s.trim().length > 0);

        if (rawSegments.length <= 1) {
          // Fallback to chunking by characters if no explicit numbered questions found
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += 6000) {
            chunks.push(text.slice(i, i + 6000));
          }
          return chunks;
        }

        // Bundle ~12-15 questions per batch
        const batches: string[] = [];
        let currentBatch = '';
        for (const seg of rawSegments) {
          if (currentBatch.length + seg.length > 6000 && currentBatch.length > 0) {
            batches.push(currentBatch.trim());
            currentBatch = seg;
          } else {
            currentBatch += '\n\n' + seg;
          }
        }
        if (currentBatch.trim()) {
          batches.push(currentBatch.trim());
        }
        return batches;
      };

      try {
        const examChunks = splitExamIntoQuestionChunks(sanitizedContext);
        console.log(`[Exam Solver] Processing exam in ${examChunks.length} chunk(s) to solve 100% of questions...`);

        const allSolvedQuestions: any[] = [];
        let detectedExamTitle = metadata.name || 'Solved Exam';
        let totalSolverTokens = 0;
        let lastProvider = 'google';
        let lastModel = 'gemini-2.5-flash';

        for (let i = 0; i < examChunks.length; i++) {
          const chunkText = examChunks[i];
          const chunkMessages = [
            { role: "system", content: examSolverSystemPrompt },
            {
              role: "user",
              content: `Exam: "${metadata.name || 'Exam Paper'}" (Part ${i + 1} of ${examChunks.length})\n\nContent:\n${chunkText}\n\nIMPORTANT: Parse and solve EVERY question in this segment in ${language}. Keep explanations mathematically sound but concise so all questions are included. Output valid JSON.`
            }
          ];

          const solverResponse = await marlineRouter.executeGenerateWithFallback(
            {
              messages: chunkMessages as any,
              responseFormat: { type: 'json_object' },
              maxTokens: 6000,
              temperature: 0.1,
            },
            {
              task: 'quiz',
              inputTokens: estimateTokens(JSON.stringify(chunkMessages)),
              desiredOutputTokens: 6000,
              requiresJsonMode: true,
              preferredProvider: 'google', // Google Gemini has 1M context + 8k output tokens
            }
          );

          lastProvider = solverResponse.provider;
          lastModel = solverResponse.model;
          totalSolverTokens += solverResponse.usage?.totalTokens
            || (estimateTokens(JSON.stringify(chunkMessages)) + estimateTokens(solverResponse.content || ''));

          const rawContent = solverResponse.content || "";
          const parsed = safeJsonParseWithRepair<any>(rawContent, { examTitle: detectedExamTitle, questions: [] });
          if (parsed.examTitle && parsed.examTitle !== 'Solved Exam') {
            detectedExamTitle = parsed.examTitle;
          }

          const chunkQuestions = Array.isArray(parsed) ? parsed : (parsed.questions || []);
          allSolvedQuestions.push(...chunkQuestions);
        }

        allSolvedQuestions.forEach((q: any, idx: number) => { q.numb = idx + 1; });
        const normalizedQuestions = allSolvedQuestions.map(normalizeQuizQuestionItem);

        if (normalizedQuestions.length === 0) {
          throw new Error("Could not extract distinct questions from this exam document. Please ensure the file contains readable exam text or questions.");
        }

        await deductCredits();
        await incrementUserConsumedTokens(session.auth_id, totalSolverTokens);

        // Dynamically synthesize high-density formattedSolutionText markdown for print/PDF export
        const title = detectedExamTitle || metadata.name || 'Solved Exam';
        const solutionSections = normalizedQuestions.map((q: any) => {
          const tableBlock = q.table ? `\n\n${q.table}\n` : '';
          const optionsBlock = q.options && q.options.length > 0 ? `\n\n**Options:**\n${q.options.map((o: string) => `• ${o}`).join('\n')}` : '';
          return `## Question ${q.numb}\n**Question:** ${q.question}${tableBlock}${optionsBlock}\n\n**Correct Answer:** ${q.answer}\n\n**Solution & Derivation:**\n${q.explanation || 'Directly verified from curriculum fundamentals.'}`;
        });

        const formattedSolutionText = `# Solved Exam: ${title}\n\n${solutionSections.join('\n\n---\n\n')}`;

        const solvedResult = {
          examTitle: title,
          questions: normalizedQuestions,
          formattedSolutionText
        };

        if (shouldCache) {
          await setCachedAIResult(sanitizedContext, cacheTaskKey, language, solvedResult);
        }

        const { tier, tierLabel } = getProviderLayerInfo(lastProvider);

        return NextResponse.json({ result: solvedResult }, {
          headers: {
            'X-AI-Credits-Remaining': Math.max(0, currentCredits - dynamicTokenCost).toString(),
            'X-AI-Credits-Cost': dynamicTokenCost.toString(),
            'X-AI-Tier': tier,
            'X-AI-Tier-Label': tierLabel,
            'X-AI-Provider': lastProvider,
            'X-AI-Model': lastModel
          }
        });
      } catch (err: any) {
        console.error('[Exam Solver] Error solving exam:', err);
        return NextResponse.json({ error: `Failed to solve exam: ${err.message || String(err)}` }, { status: 502 });
      }
    }

    // 3. SUMMARIZE, TRANSLATE & CHAT STREAMING TASKS (Orchestrated Architecture)
    const systemPrompt = `You are Marline AI, an elite university professor and academic study guide author.
    Language: ${language}.

    CRITICAL ANTI-HALLUCINATION & STRICT GROUNDING POLICY:
    - 100% GROUNDED IN SOURCE: Every definition, concept, explanation, formula, code block, and table in this study guide MUST be derived directly and exclusively from the provided document content.
    - ZERO EXTERNAL INVENTIONS: Do NOT fabricate, assume, or introduce external topics, unmentioned libraries, outside case studies, or extraneous tangents not found in the source material.
    - FACTUAL FIDELITY: Maintain strict precision to the exact methods, notations, equations, and topics presented in the text.

    CRITICAL FORMATTING & SYNTAX STANDARDS:
    1. GFM Tables (Keep Compact & Never Overly Wide):
       - Maximum 2 to 4 columns. NEVER create wide tables with massive paragraphs in cells.
       - Table cells must contain short, crisp summaries or keywords. For detailed multi-line explanations, use bullet lists outside the table instead.
       - Every table MUST have a standard header row, delimiter row (| --- | --- |), and data rows.
       - Each table row MUST be on its own independent line starting with | and ending with |.
       - NEVER output multiple rows on a single line or use inline ||.
       - Inside table cells, use plain text or simple inline math $...$. Never place unescaped vertical pipes inside cells (use \\mid or \\Vert instead).
    2. Mathematical Formulas (LaTeX):
       - Inline math: Wrap strictly in $...$ (e.g., $P(X_{n+1} = j \\mid X_n = i) = p_{ij}$).
       - NEVER place $ inside brackets or functions (e.g. write $P(A \\mid B)$, NEVER P(\\mid$B$)).
       - Block / Display equations & Matrices: ALWAYS enclose on separate lines wrapped in $$...$$ (e.g. $$\\begin{bmatrix} Q & R \\\\ 0 & I \\end{bmatrix}$$).
       - Never place display matrices inline within text sentences.
    3. Code & SQL: Always enclose in fenced code blocks (\`\`\`sql, \`\`\`python, etc.).
    4. Section Dividers: Use a single \`---\` before major section headings.

    FIXED ACADEMIC STUDY GUIDE STRUCTURE:
    - 📌 **Executive Overview**: High-level synthesis of learning goals and core concepts found in the text.
    - 🧠 **Core Concepts & Definitions**: Key terminology and foundational definitions from the text.
    - 🔍 **Detailed Thematic Analysis**: In-depth explanations of every topic/methodology in the text with bullet points, code, and LaTeX where relevant.
    - ⚖️ **Comparison & Evaluation Table**: A clean, compact 2-4 column GFM table comparing methods/approaches found in the document.
    - ⚠️ **Key Pitfalls & Exam Traps**: Common misconceptions and edge cases specifically related to the material.
    - 💡 **Real-World Case Examples**: Practical implementation scenarios illustrating the document's concepts.
    - 🎯 **High-Yield Exam Review Questions**: 3 to 5 conceptual review questions with model answers based on the material.

    COMPLETENESS GUARANTEE:
    - You must write out every single section completely and thoroughly without stopping midway or omitting any lecture/chapter from the source document.
    - Do not truncate or abbreviate with "etc.". Output the complete study guide to the very end.
    - Output ONLY the clean, final academic study guide without any meta-commentary or thinking scratchpad.`;

    const { orchestrateDriveAI } = await import('@/lib/drive-ai-orchestrator');

    const { stream, tier, tierLabel, model, provider } = await orchestrateDriveAI({
      task: (task || 'summarize') as any,
      language,
      systemPrompt,
      sanitizedContext,
      metadataName: metadata.name || 'Academic File',
      messages,
      groqKey: secrets.groq.apiKey,
      openRouterKey: secrets.openrouter.apiKey,
      onDeductCredits: deductCredits,
      currentCredits,
      dynamicTokenCost,
      onConsumedTokens: async (tokens) => {
        await incrementUserConsumedTokens(session.auth_id, tokens);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-AI-Credits-Remaining": Math.max(0, currentCredits - dynamicTokenCost).toString(),
        "X-AI-Credits-Cost": dynamicTokenCost.toString(),
        "X-AI-Tier": tier,
        "X-AI-Tier-Label": tierLabel,
        "X-AI-Model": model,
        ...(provider ? { "X-AI-Provider": provider } : {})
      },
    });

  } catch (error) {
    console.error('[Marline Drive AI] Global error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Internal error: ${errorMessage}` }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';
