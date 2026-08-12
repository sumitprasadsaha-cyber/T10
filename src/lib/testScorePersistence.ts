/**
 * Student Test Score Persistence Service
 * 
 * Handles:
 * - Loading previous test attempts when student logs in
 * - Storing test results in persistent cache
 * - Synchronizing test scores across devices
 * - Managing test completion state
 */

import { TestAttemptRecord } from "../types";
import { 
  getStudentTestAttempts as getStudentTestAttemptsFromFirestore,
  subscribeToTestAttempts,
  getLocalTestAttempts,
  saveLocalTestAttemptsCache
} from "./firestoreService";

const TEST_SCORE_CACHE_KEY = "tuition_student_test_score_cache";

/**
 * Load student's previous test results from persistent storage
 * Called on student login to restore completion state
 */
export async function loadStudentTestScores(studentId: string): Promise<TestAttemptRecord[]> {
  try {
    // First, try to get from Firestore
    const firebaseScores = await getStudentTestAttemptsFromFirestore(studentId);
    if (firebaseScores && firebaseScores.length > 0) {
      cacheStudentTestScores(studentId, firebaseScores);
      // Also save to the local storage cache used by StudentDashboard
      const currentLocal = getLocalTestAttempts();
      const mergedAttempts = [...currentLocal];
      
      // Merge firebaseScores with existing local attempts
      for (const fbScore of firebaseScores) {
        const existingIdx = mergedAttempts.findIndex((a) => a.id === fbScore.id);
        if (existingIdx > -1) {
          mergedAttempts[existingIdx] = fbScore;
        } else {
          mergedAttempts.push(fbScore);
        }
      }
      
      saveLocalTestAttemptsCache(mergedAttempts);
      return firebaseScores;
    }
  } catch (err) {
    console.warn(`[TestScoreService] Error loading test scores from Firestore for student ${studentId}:`, err);
  }

  // Fall back to local cache
  const cachedScores = getStudentTestScoresFromCache(studentId);
  if (cachedScores && cachedScores.length > 0) {
    return cachedScores;
  }

  // If nothing found, return empty array
  return [];
}

/**
 * Get test scores from local cache
 */
function getStudentTestScoresFromCache(studentId: string): TestAttemptRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const cache = localStorage.getItem(TEST_SCORE_CACHE_KEY);
    if (!cache) return [];
    
    const allScores = JSON.parse(cache) as Record<string, TestAttemptRecord[]>;
    return allScores[studentId] || [];
  } catch (err) {
    console.error("[TestScoreService] Error reading test score cache:", err);
    return [];
  }
}

/**
 * Cache student's test scores locally
 */
function cacheStudentTestScores(studentId: string, scores: TestAttemptRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    const cache = localStorage.getItem(TEST_SCORE_CACHE_KEY);
    const allScores = cache ? JSON.parse(cache) : {} as Record<string, TestAttemptRecord[]>;
    
    allScores[studentId] = scores;
    localStorage.setItem(TEST_SCORE_CACHE_KEY, JSON.stringify(allScores));
  } catch (err) {
    console.warn("[TestScoreService] Error caching test scores:", err);
  }
}

/**
 * Clear test score cache (e.g., on logout)
 */
export function clearTestScoreCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(TEST_SCORE_CACHE_KEY);
  } catch (err) {
    console.warn("[TestScoreService] Error clearing test score cache:", err);
  }
}

/**
 * Get a specific test's high score for a student
 * Useful for displaying pass/fail status in student dashboard
 */
export function getStudentTopicHighScore(
  studentId: string,
  subject: string,
  chapterNo: number,
  topicName: string
): number | null {
  const attempts = getStudentTestScoresFromCache(studentId);
  
  const topicAttempts = attempts.filter((a) => {
    if (a.studentId !== studentId) return false;
    if (a.subject?.toLowerCase().trim() !== subject?.toLowerCase().trim()) return false;
    if (Number(a.chapterNo) !== Number(chapterNo)) return false;
    const normTopic = a.topicName?.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normTarget = topicName?.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normTopic === normTarget;
  });

  if (topicAttempts.length === 0) return null;

  let highestScore = 0;
  topicAttempts.forEach((a) => {
    const pct = a.percentage ?? (a.totalQuestions > 0 ? Math.round((a.score / a.totalQuestions) * 100) : 0);
    if (pct > highestScore) highestScore = pct;
  });

  return highestScore;
}

/**
 * Get total number of attempts for a topic
 */
export function getStudentTopicAttemptCount(
  studentId: string,
  subject: string,
  chapterNo: number,
  topicName: string
): number {
  const attempts = getStudentTestScoresFromCache(studentId);
  
  return attempts.filter((a) => {
    if (a.studentId !== studentId) return false;
    if (a.subject?.toLowerCase().trim() !== subject?.toLowerCase().trim()) return false;
    if (Number(a.chapterNo) !== Number(chapterNo)) return false;
    const normTopic = a.topicName?.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normTarget = topicName?.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normTopic === normTarget;
  }).length;
}

/**
 * Get latest test score for a topic
 */
export function getStudentTopicLatestScore(
  studentId: string,
  subject: string,
  chapterNo: number,
  topicName: string
): TestAttemptRecord | null {
  const attempts = getStudentTestScoresFromCache(studentId);
  
  const topicAttempts = attempts.filter((a) => {
    if (a.studentId !== studentId) return false;
    if (a.subject?.toLowerCase().trim() !== subject?.toLowerCase().trim()) return false;
    if (Number(a.chapterNo) !== Number(chapterNo)) return false;
    const normTopic = a.topicName?.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normTarget = topicName?.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normTopic === normTarget;
  });

  if (topicAttempts.length === 0) return null;

  // Sort by timestamp descending to get latest
  topicAttempts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return topicAttempts[0];
}

/**
 * Subscribe to all test attempts for real-time updates
 * Automatically updates the cache when new scores are added
 */
export function subscribeToStudentTestScores(
  studentId: string,
  onUpdate: (scores: TestAttemptRecord[]) => void,
  onError?: (err: any) => void
): () => void {
  // Subscribe to all test attempts and filter for this student
  return subscribeToTestAttempts(
    (allAttempts) => {
      const studentScores = allAttempts.filter((a) => a.studentId === studentId);
      cacheStudentTestScores(studentId, studentScores);
      onUpdate(studentScores);
    },
    onError
  );
}

export default {
  loadStudentTestScores,
  clearTestScoreCache,
  getStudentTopicHighScore,
  getStudentTopicAttemptCount,
  getStudentTopicLatestScore,
  subscribeToStudentTestScores
};
