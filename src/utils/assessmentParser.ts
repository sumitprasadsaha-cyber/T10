import { ParsedAssessmentQuestion, TopicPracticeTest, TestAttemptRecord } from "../types";

export interface ParseResult {
  success: boolean;
  questions: ParsedAssessmentQuestion[];
  errors: string[];
}

const TESTS_STORAGE_KEY = "tuition_topic_practice_tests_bank";
const ATTEMPTS_STORAGE_KEY = "tuition_student_test_attempts";

/**
 * Normalizes test ID for topic practice tests
 */
export function buildTopicTestId(
  classGrade: string = "",
  subject: string = "",
  chapterNo: number = 0,
  topicName: string = ""
): string {
  const normClass = (classGrade || "").toLowerCase().replace(/\s+/g, "_");
  const normSubj = (subject || "").toLowerCase().replace(/\s+/g, "_");
  const normTopic = (topicName || "").toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `${normClass}__${normSubj}__ch${chapterNo}__${normTopic}`;
}

/**
 * Parses raw pasted text into structured MCQ and True/False questions.
 */
export function parseAssessmentText(
  rawText: string,
  context: {
    classGrade: string;
    subject: string;
    chapterNo: number;
    chapterName: string;
    topicName: string;
  }
): ParseResult {
  const errors: string[] = [];
  const questions: ParsedAssessmentQuestion[] = [];

  const text = rawText.trim();
  if (!text) {
    return {
      success: false,
      questions: [],
      errors: ["Please enter or paste questions text into the editor."]
    };
  }

  // Split into raw lines
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      success: false,
      questions: [],
      errors: ["No valid text lines found in input."]
    };
  }

  let currentSection: "mcq" | "true_false" | "unknown" = "unknown";
  const blocks: { section: "mcq" | "true_false" | "unknown"; lines: string[] }[] = [];
  let currentBlock: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    // Ignore horizontal rules / divider lines / decorative symbols
    if (/^[⸻\-\=\_\*]{2,}$/.test(line)) {
      if (currentBlock.length > 0) {
        blocks.push({ section: currentSection, lines: currentBlock });
        currentBlock = [];
      }
      continue;
    }

    // Ignore metadata header lines at document top or between sections
    if (
      (lower.startsWith("chapter:") ||
        lower.startsWith("topic:") ||
        lower.startsWith("class:") ||
        lower.startsWith("subject:") ||
        lower === "sample test" ||
        lower.startsWith("sample test")) &&
      currentBlock.length === 0
    ) {
      continue;
    }

    // Section header check
    if (
      lower.includes("multiple choice") ||
      lower.includes("mcqs") ||
      lower === "mcq" ||
      lower.startsWith("multiple choice questions") ||
      lower.includes("assertion & reasoning") ||
      lower.includes("assertion and reasoning") ||
      lower.includes("mcqs with image") ||
      lower.includes("mcq with image")
    ) {
      currentSection = "mcq";
      if (currentBlock.length > 0) {
        blocks.push({ section: currentSection, lines: currentBlock });
        currentBlock = [];
      }
      continue;
    }

    if (
      lower.includes("true or false") ||
      lower.includes("true/false") ||
      lower === "t/f" ||
      lower.includes("true and false") ||
      lower === "true / false"
    ) {
      currentSection = "true_false";
      if (currentBlock.length > 0) {
        blocks.push({ section: currentSection, lines: currentBlock });
        currentBlock = [];
      }
      continue;
    }

    // Check if line starts a new question (e.g., "1.", "2)", "Q1.", "1. The Earth...")
    const isNumberedQuestion = /^(?:\d+[\.\)]|Q\d+[\.:\)])\s+/i.test(line);

    if (isNumberedQuestion && currentBlock.length > 0) {
      blocks.push({ section: currentSection, lines: currentBlock });
      currentBlock = [line];
    } else {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push({ section: currentSection, lines: currentBlock });
  }

  // Process each block
  blocks.forEach((blockObj, index) => {
    let blockLines = [...blockObj.lines];
    const blockSection = blockObj.section;
    const fullBlockText = blockLines.join("\n");
    const firstLine = blockLines[0];

    // Check if firstLine is just a leftover metadata line
    const firstLower = firstLine.toLowerCase();
    if (
      firstLower.startsWith("chapter:") ||
      firstLower.startsWith("topic:") ||
      firstLower.startsWith("class:") ||
      firstLower.startsWith("subject:") ||
      firstLower === "sample test"
    ) {
      return;
    }

    // 1. Extract explicit "Correct Answer: X" line if present
    let explicitCorrectAnswer = "";
    const remainingLines: string[] = [];
    blockLines.forEach((l) => {
      const caMatch = l.match(/^Correct\s*Answer:\s*([A-D]|True|False)/i);
      if (caMatch) {
        explicitCorrectAnswer = caMatch[1].trim();
      } else {
        remainingLines.push(l);
      }
    });
    blockLines = remainingLines;

    // 2. Extract Image marker [Image Upload: ...] or [Image: ...] if present
    let extractedImageLabel = "";
    const cleanLinesAfterImage: string[] = [];
    blockLines.forEach((l) => {
      const imgMatch = l.match(/\[Image(?:\s+Upload)?:\s*([^\]]+)\]/i);
      if (imgMatch) {
        extractedImageLabel = imgMatch[1].trim();
        const lineWithoutTag = l.replace(/\[Image(?:\s+Upload)?:\s*([^\]]+)\]/gi, "").trim();
        if (lineWithoutTag) cleanLinesAfterImage.push(lineWithoutTag);
      } else {
        cleanLinesAfterImage.push(l);
      }
    });
    blockLines = cleanLinesAfterImage;

    if (blockLines.length === 0) return;

    // Determine if this block is MCQ or True/False
    const hasMCQOptions = blockLines.some((l) => /^[A-D][\.\)]\s+/i.test(l));
    const isTFPattern =
      !hasMCQOptions &&
      (fullBlockText.includes("True") ||
        fullBlockText.includes("False") ||
        fullBlockText.includes("— True") ||
        fullBlockText.includes("— False") ||
        fullBlockText.includes("✅") ||
        fullBlockText.includes("❌") ||
        explicitCorrectAnswer.toLowerCase() === "true" ||
        explicitCorrectAnswer.toLowerCase() === "false");

    let isMCQ = hasMCQOptions;
    let isTF = isTFPattern;

    if (!isMCQ && !isTF) {
      if (blockSection === "mcq") isMCQ = true;
      else if (blockSection === "true_false") isTF = true;
    }

    if (isMCQ) {
      // Find where Option A starts
      const firstOptIdx = blockLines.findIndex((l) => /^[A-D][\.\)]\s+/i.test(l));

      if (firstOptIdx < 0) {
        if (!/^(?:\d+[\.\)]|Q\d+[\.:\)])\s+/i.test(firstLine)) return;

        errors.push(
          `Question #${index + 1}: Could not find MCQ options (A, B, C, D) for line:\n"${firstLine.substring(0, 50)}..."`
        );
        return;
      }

      // Question lines before Option A
      const rawQLines = blockLines.slice(0, firstOptIdx).filter((l) => l.toLowerCase() !== "question:");
      
      let qText = rawQLines
        .map((l, idx) => idx === 0 ? l.replace(/^(?:\d+[\.\)]|Q\d+[\.:\)])\s+/i, "") : l)
        .join("\n")
        .trim();

      if (!qText) {
        qText = `Question ${index + 1}`;
      }

      const optionLines = blockLines.slice(firstOptIdx);
      const options: string[] = [];
      let correctAnswerLetter = "";

      optionLines.forEach((optLine) => {
        const match = optLine.match(/^([A-D])[\.\)]\s+(.*)$/i);
        if (match) {
          const letter = match[1].toUpperCase();
          let optVal = match[2].trim();

          const hasCheck = optVal.includes("✅") || /\(correct\)/i.test(optVal) || /\(answer\)/i.test(optVal);
          
          // Clean up markers and trap tags
          optVal = optVal
            .replace(/[✅❌]/g, "")
            .replace(/\s*\(trap\)/gi, "")
            .replace(/\s*\(correct\)/gi, "")
            .replace(/\s*\(answer\)/gi, "")
            .trim();

          if (hasCheck) {
            correctAnswerLetter = letter;
          }

          options.push(`${letter}. ${optVal}`);
        }
      });

      if (!correctAnswerLetter && explicitCorrectAnswer && /^[A-D]$/i.test(explicitCorrectAnswer)) {
        correctAnswerLetter = explicitCorrectAnswer.toUpperCase();
      }

      if (options.length < 2) {
        errors.push(
          `MCQ Question "${qText.substring(0, 40)}...": Must have at least 2 options (found ${options.length}).`
        );
        return;
      }

      if (!correctAnswerLetter) {
        errors.push(
          `MCQ Question "${qText.substring(0, 40)}...": Missing correct answer marker ✅ or Correct Answer line.`
        );
        return;
      }

      questions.push({
        id: `q_mcq_${index + 1}_${Math.random().toString(36).substring(2, 7)}`,
        classGrade: context.classGrade,
        subject: context.subject,
        chapterNo: context.chapterNo,
        chapterName: context.chapterName,
        topicName: context.topicName,
        type: "mcq",
        question: qText,
        options,
        correctAnswer: correctAnswerLetter,
        imageLabel: extractedImageLabel || undefined,
        rawText: fullBlockText
      });
    } else if (isTF) {
      let rawStatement = blockLines
        .filter((l) => l.toLowerCase() !== "question:")
        .join(" ")
        .replace(/^(?:\d+[\.\)]|Q\d+[\.:\)])\s+/i, "")
        .trim();

      let correctAnswer = "";
      const lowerStmt = rawStatement.toLowerCase();

      if (
        rawStatement.includes("True ✅") ||
        rawStatement.includes("— True") ||
        rawStatement.includes("- True") ||
        (rawStatement.includes("True") && rawStatement.includes("✅"))
      ) {
        correctAnswer = "True";
      } else if (
        rawStatement.includes("False ❌") ||
        rawStatement.includes("— False") ||
        rawStatement.includes("- False") ||
        (rawStatement.includes("False") && (rawStatement.includes("❌") || rawStatement.includes("✅")))
      ) {
        correctAnswer = "False";
      } else if (lowerStmt.endsWith("true")) {
        correctAnswer = "True";
      } else if (lowerStmt.endsWith("false")) {
        correctAnswer = "False";
      } else if (explicitCorrectAnswer && (explicitCorrectAnswer.toLowerCase() === "true" || explicitCorrectAnswer.toLowerCase() === "false")) {
        correctAnswer = explicitCorrectAnswer.toLowerCase() === "true" ? "True" : "False";
      }

      let cleanQuestion = rawStatement
        .replace(/—\s*(True|False)\s*[✅❌]?/gi, "")
        .replace(/-\s*(True|False)\s*[✅❌]?/gi, "")
        .replace(/\b(True|False)\s*[✅❌]?/gi, "")
        .replace(/[✅❌]/g, "")
        .replace(/\s*\(trap\)/gi, "")
        .replace(/\s*\(correct\)/gi, "")
        .replace(/\s*\(answer\)/gi, "")
        .trim();

      if (!cleanQuestion) {
        cleanQuestion = rawStatement.replace(/[✅❌]/g, "").trim();
      }

      if (!correctAnswer) {
        if (!/^(?:\d+[\.\)]|Q\d+[\.:\)])\s+/i.test(firstLine)) return;

        errors.push(
          `True/False Question "${rawStatement.substring(0, 40)}...": Could not detect correct answer (True ✅ or False ❌ or Correct Answer: True/False).`
        );
        return;
      }

      questions.push({
        id: `q_tf_${index + 1}_${Math.random().toString(36).substring(2, 7)}`,
        classGrade: context.classGrade,
        subject: context.subject,
        chapterNo: context.chapterNo,
        chapterName: context.chapterName,
        topicName: context.topicName,
        type: "true_false",
        question: cleanQuestion,
        options: ["True", "False"],
        correctAnswer,
        imageLabel: extractedImageLabel || undefined,
        rawText: fullBlockText
      });
    } else {
      if (!/^(?:\d+[\.\)]|Q\d+[\.:\)])\s+/i.test(firstLine)) return;

      errors.push(
        `Question Block #${index + 1}: Unrecognized format for line:\n"${firstLine.substring(0, 50)}..."`
      );
    }
  });

  return {
    success: errors.length === 0,
    questions,
    errors
  };
}

// ----------------------------------------------------
// LOCAL STORAGE & PERSISTENCE HELPERS
// ----------------------------------------------------

import { 
  getLocalTestBank as getAllPracticeTests,
  getTopicPracticeTestSync as getTopicPracticeTest,
  getTopicPracticeTestSync,
  getTopicPracticeTest as getTopicPracticeTestAsync,
  saveTopicPracticeTest as saveServiceTopicTest,
  deleteTopicPracticeTest as deleteServiceTopicTest,
  getFullChapterQuestionsSync as getFullChapterQuestions,
  fetchAllPracticeTestsFromSupabase
} from "../lib/practiceTestService";

export { 
  getAllPracticeTests, 
  getTopicPracticeTest, 
  getTopicPracticeTestSync,
  getTopicPracticeTestAsync,
  getFullChapterQuestions, 
  fetchAllPracticeTestsFromSupabase 
};

export function saveTopicPracticeTest(test: TopicPracticeTest): void {
  saveServiceTopicTest(
    {
      classGrade: test.classGrade,
      subject: test.subject,
      chapterNo: test.chapterNo,
      chapterName: test.chapterName,
      topicName: test.topicName,
      rawText: test.rawText
    },
    test.questions
  );
}

export function deleteTopicPracticeTest(testIdOrTopic: string): void {
  // If testId is passed in format class__subj__ch1__topic
  const parts = testIdOrTopic.split("__");
  if (parts.length >= 4) {
    const classGrade = parts[0].replace(/_/g, " ");
    const subject = parts[1].replace(/_/g, " ");
    const chapterNo = parseInt(parts[2].replace("ch", ""), 10) || 1;
    const topicName = parts.slice(3).join("__");
    deleteServiceTopicTest(classGrade, subject, chapterNo, topicName);
  } else {
    // Fallback in-memory cache deletion
    const all = getAllPracticeTests();
    delete all[testIdOrTopic];
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("practice-tests-updated"));
    }
  }
}

// ----------------------------------------------------
// TEST ATTEMPTS HELPERS
// ----------------------------------------------------

import { 
  getLocalTestAttempts, 
  saveTestAttemptDoc, 
  subscribeToTestAttempts,
  saveLocalTestAttemptsCache
} from "../lib/firestoreService";
import { 
  syncTestAttemptsToSupabaseStorage, 
  fetchTestAttemptsFromSupabaseStorage 
} from "../lib/practiceTestService";

export { subscribeToTestAttempts };

if (typeof window !== "undefined") {
  (async () => {
    try {
      const remote = await fetchTestAttemptsFromSupabaseStorage();
      if (remote && remote.length > 0) {
        const local = getLocalTestAttempts();
        const mergedMap = new Map<string, TestAttemptRecord>();
        for (const item of remote) {
          if (item && item.id) mergedMap.set(item.id, item);
        }
        for (const item of local) {
          if (item && item.id) mergedMap.set(item.id, item);
        }
        const mergedList = Array.from(mergedMap.values());
        mergedList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        saveLocalTestAttemptsCache(mergedList);
      }
    } catch (e) {
      console.warn("[AssessmentParser] Bootstrapping attempts from Supabase storage warning:", e);
    }
  })();
}

export function getAllTestAttempts(): TestAttemptRecord[] {
  return getLocalTestAttempts();
}

export function saveTestAttempt(attempt: TestAttemptRecord): void {
  saveTestAttemptDoc(attempt).then(() => {
    const all = getLocalTestAttempts();
    syncTestAttemptsToSupabaseStorage(all);
  }).catch((err) => {
    console.warn("[AssessmentParser] saveTestAttempt error:", err);
  });
}

export function getStudentTestAttempts(
  studentIdentifier: string = "",
  classGrade?: string,
  subject?: string,
  chapterNo?: number,
  topicName?: string,
  testType?: "topic" | "full_chapter"
): TestAttemptRecord[] {
  const all = getAllTestAttempts();
  const normIdent = (studentIdentifier || "").toLowerCase().trim();
  const normClass = (classGrade || "").toLowerCase().trim();
  const normSubj = (subject || "").toLowerCase().trim();
  const normTopic = (topicName || "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");

  return all.filter((a) => {
    if (studentIdentifier) {
      const matchId = (a.studentId || "").toLowerCase().trim() === normIdent;
      const matchName = (a.studentName || "").toLowerCase().trim() === normIdent;
      if (!matchId && !matchName) return false;
    }
    if (testType && a.testType !== testType) return false;
    if (classGrade) {
      const aClass = (a.classGrade || "").toLowerCase().trim();
      if (aClass && normClass && aClass !== normClass && !aClass.includes(normClass) && !normClass.includes(aClass)) return false;
    }
    if (subject) {
      const aSubj = (a.subject || "").toLowerCase().trim();
      if (aSubj && normSubj && aSubj !== normSubj && !aSubj.includes(normSubj) && !normSubj.includes(aSubj)) return false;
    }
    if (chapterNo !== undefined && Number(a.chapterNo) !== Number(chapterNo)) return false;
    if (topicName && testType === "topic") {
      const aTopic = (a.topicName || "").toLowerCase().trim().replace(/[^a-z0-9]/g, "");
      return aTopic === normTopic || aTopic.includes(normTopic) || normTopic.includes(aTopic);
    }
    return true;
  });
}

export function getStudentNextAttemptNumber(
  studentId: string,
  classGrade: string,
  subject: string,
  chapterNo: number,
  topicName: string,
  testType: "topic" | "full_chapter"
): number {
  const existing = getStudentTestAttempts(
    studentId,
    classGrade,
    subject,
    chapterNo,
    topicName,
    testType
  );
  return existing.length + 1;
}
