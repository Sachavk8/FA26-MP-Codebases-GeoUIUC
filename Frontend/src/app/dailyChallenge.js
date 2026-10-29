// Daily Challenge helpers: every player gets the same 3 locations each day.
// The day is based on campus time (America/Chicago) so it rolls over at local midnight.
import { doc, getDoc, updateDoc } from "firebase/firestore"
import { getRandomPoint } from "./game/test-scripts/randpoint.js"

const DAILY_TIME_ZONE = "America/Chicago"
const MAX_ROUND_SCORE = 5000

// "YYYY-MM-DD" for the given moment in campus time
export function getDailyKey(date = new Date()) {
    // en-CA formats dates as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: DAILY_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date)
}

// The day before a "YYYY-MM-DD" key
function getPreviousDailyKey(dailyKey) {
    const [year, month, day] = dailyKey.split("-").map(Number)
    const previous = new Date(Date.UTC(year, month - 1, day - 1))
    return previous.toISOString().slice(0, 10)
}

// Turns a string into a 32-bit seed (FNV-1a hash)
function hashString(str) {
    let hash = 2166136261
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

// Small seeded random number generator (mulberry32); same seed -> same sequence
function createSeededRandom(seed) {
    let state = seed
    return function () {
        state = (state + 0x6D2B79F5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// Returns a function that produces the random points for one round of the daily challenge.
// Each round gets its own seed, so retries (when a point has no Street View) are also the same for everyone.
export function createDailyPointGenerator(dailyKey, round) {
    const rng = createSeededRandom(hashString(`geouiuc-daily-${dailyKey}-round-${round}`))
    return () => getRandomPoint(rng)
}

// Streak to show in the lobby: it is only still alive if the last daily was today or yesterday
export function getDisplayedStreak(userData, today = getDailyKey()) {
    const streak = userData?.dailyStreak || 0
    const lastDate = userData?.lastDailyDate
    if (lastDate === today || lastDate === getPreviousDailyKey(today)) return streak
    return 0
}

export function hasPlayedToday(userData, today = getDailyKey()) {
    return userData?.lastDailyDate === today
}

function getNextStreak(userData, today) {
    const streak = userData?.dailyStreak || 0
    const lastDate = userData?.lastDailyDate
    if (lastDate === today) return streak
    if (lastDate === getPreviousDailyKey(today)) return streak + 1
    return 1
}

// Saves the daily result and updates the streak. Only the first finish of the day counts.
// Returns the player's streak after this game.
export async function recordDailyResult(db, uid, dailyKey, roundScores) {
    const docRef = doc(db, "users", uid)
    const docSnap = await getDoc(docRef)
    const userData = docSnap.exists() ? docSnap.data() : {}

    if (hasPlayedToday(userData, dailyKey)) return userData.dailyStreak || 0

    const newStreak = getNextStreak(userData, dailyKey)
    await updateDoc(docRef, {
        dailyStreak: newStreak,
        lastDailyDate: dailyKey,
        lastDailyScores: roundScores
    })
    return newStreak
}

function scoreToSquare(score) {
    if (score >= 4000) return "🟩"
    if (score >= 2500) return "🟨"
    return "🟥"
}

// Text copied by the Share button
export function buildShareText(dailyKey, roundScores, streak) {
    const total = roundScores.reduce((sum, score) => sum + score, 0)
    const lines = [
        `GeoUIUC Daily Challenge ${dailyKey}`,
        roundScores.map(scoreToSquare).join(""),
        ...roundScores.map((score, i) => `Round ${i + 1}: ${score} pts`),
        `Total: ${total} / ${MAX_ROUND_SCORE * roundScores.length}`
    ]
    if (streak) lines.push(`🔥 Streak: ${streak} day${streak === 1 ? "" : "s"}`)
    return lines.join("\n")
}
