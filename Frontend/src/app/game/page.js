"use client"
import { useRef, useState, useEffect, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useJsApiLoader } from "@react-google-maps/api"
import { getRandomPoint } from "./test-scripts/randpoint.js"
import styles from "./page.module.css"
import { useAudio } from '@/components/AudioProvider'
import ScoreScreen from './ScoreScreen.js'
import GuessMap from './GuessMap.js'
import { auth, db} from '@/components/firebase-config.js'
import { doc, updateDoc, increment, getDoc } from 'firebase/firestore'
import { getDailyKey, createDailyPointGenerator, recordDailyResult, buildShareText } from '../dailyChallenge.js'

const CAMPUS_MAP_BOUNDS = {
    north: 40.1161,
    south: 40.0884,
    east: -88.2095,
    west: -88.2423
}

const MAP_CENTER = { lat: 40.108252, lng: -88.22699 }
const MAX_ROUNDS = 3
const MAX_SCORE = 5000
const INITIAL_TIMER_SECONDS = 119
const GOOGLE_MAPS_LIBRARIES = ['places']
const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

const DEFAULT_POSITION = { lat: 0, lng: 0 }

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const MAX_DISTANCE_IN_BOUNDS = calculateDistance(
    CAMPUS_MAP_BOUNDS.south, CAMPUS_MAP_BOUNDS.west,
    CAMPUS_MAP_BOUNDS.north, CAMPUS_MAP_BOUNDS.east
)

function formatTimer(seconds) {
    const minutes = Math.floor(seconds / 60)
    const secs = (seconds % 60).toString().padStart(2, "0")
    return `${minutes}:${secs}`
}

function calculateScore(distance, maxDistance = MAX_DISTANCE_IN_BOUNDS) {
    console.log(maxDistance)
    const normalizedDistance = distance / maxDistance
    console.log(normalizedDistance)
    return Math.max(0, Math.floor(MAX_SCORE * (1 - normalizedDistance)))
}

function getMapZoom(distance) {
    if (distance > 5) return 12
    if (distance > 1) return 14
    return 16
}

function isDefaultPosition(position) {
    return position?.lat === 0 && position?.lng === 0
}
function createPosition(lat, lng) {
    return { lat, lng }
}


function formatDistanceText(distance, hasGuess) {
    const distanceStr = distance.toFixed(2)
    return hasGuess
        ? `Your guess was ${distanceStr}km from the correct location!`
        : `You didn't place a guess - 0pts!`
}

// Normal games use Math.random; the Daily Challenge uses a seeded generator per round
function randomPointGenerator() {
    return () => getRandomPoint()
}

function useStreetViewPanorama(isLoaded, panoramaRef, getPointGenerator) {
    const [goalPoint, setGoalPoint] = useState(null)
    const panoramaInstanceRef = useRef(null)

    const ensurePanoramaInitialized = useCallback(() => {
        if (panoramaInstanceRef.current) return true
        if (!window.google?.maps) return false

        const container = panoramaRef.current || document.querySelector('[data-panorama-container]')
        if (!container) return false

        try {
            panoramaInstanceRef.current = new window.google.maps.StreetViewPanorama(container)
            return true
        } catch (error) {
            console.error("Error initializing panorama:", error)
            return false
        }
    }, [panoramaRef])

    const findValidPanorama = useCallback((initialPoint, nextPoint = getRandomPoint) => {
        if (!window.google?.maps) return

        ensurePanoramaInitialized()
        const service = new window.google.maps.StreetViewService()

        const processPanorama = ({ data }) => {
            const isGoogleStreetView = data.copyright?.indexOf("Google") >= 0

            if (!isGoogleStreetView) {
                const randomPoint = nextPoint()
                const newPoint = createPosition(randomPoint.lat, randomPoint.long)
                setGoalPoint(newPoint)
                service.getPanorama({ location: newPoint, radius: 1000 }).then(processPanorama)
                return
            }

            const panoramaLocation = data.location.latLng
            const finalGoalPoint = createPosition(
                panoramaLocation.lat(),
                panoramaLocation.lng()
            )
            setGoalPoint(finalGoalPoint)

            const panorama = panoramaInstanceRef.current
            if (panorama && typeof panorama.setPano === 'function') {
                try {
                    panorama.setPano(data.location.pano)
                    panorama.setVisible(true)
                    panorama.setOptions({
                        zoomControl: true,
                        linksControl: true,
                        addressControl: false,
                        panControl: false,
                        showRoadLabels: false
                    })
                } catch (error) {
                    console.error("Error setting panorama:", error)
                }
            }
        }

        service.getPanorama({ location: initialPoint, radius: 1000 }).then(processPanorama)
    }, [ensurePanoramaInitialized])

    const adjustPanoramaZoom = useCallback((delta) => {
        const panorama = panoramaInstanceRef.current
        if (panorama && typeof panorama.getZoom === 'function') {
            panorama.setZoom(panorama.getZoom() + delta)
        }
    }, [])

    const zoomIn = useCallback(() => adjustPanoramaZoom(1), [adjustPanoramaZoom])
    const zoomOut = useCallback(() => adjustPanoramaZoom(-1), [adjustPanoramaZoom])

    useEffect(() => {
        if (!isLoaded || !window.google) return

        ensurePanoramaInitialized()
        const nextPoint = getPointGenerator(1)
        const randomPoint = nextPoint()
        const point = createPosition(randomPoint.lat, randomPoint.long)
        setGoalPoint(point)
        findValidPanorama(point, nextPoint)
    }, [isLoaded, ensurePanoramaInitialized, findValidPanorama, getPointGenerator])

    return { goalPoint, findValidPanorama, zoomIn, zoomOut }
}

function useTimer(initialSeconds, onTimeout) {
    const [seconds, setSeconds] = useState(initialSeconds)
    const onTimeoutRef = useRef(onTimeout)

    useEffect(() => {
        onTimeoutRef.current = onTimeout
    }, [onTimeout])

    useEffect(() => {
        if (seconds <= 0) {
            onTimeoutRef.current()
            return
        }

        const interval = setInterval(() => {
            setSeconds(prev => prev <= 1 ? 0 : prev - 1)
        }, 1000)

        return () => clearInterval(interval)
    }, [seconds])

    const reset = useCallback((newSeconds = initialSeconds) => {
        setSeconds(newSeconds)
    }, [initialSeconds])

    return { seconds, reset, formatted: formatTimer(seconds) }
}

function useGameLogic(goalPoint) {
    const [userGuess, setUserGuess] = useState(DEFAULT_POSITION)
    const [submittedGuess, setSubmittedGuess] = useState(null)
    const [submittedGoal, setSubmittedGoal] = useState(null)
    const [score, setScore] = useState(null)
    const [guessInfo, setGuessInfo] = useState(null)

    const submitGuess = useCallback(() => {
        if (!goalPoint) {
            console.error("Goal point not set")
            return
        }

        const hasGuess = !isDefaultPosition(userGuess)
        const guessPosition = hasGuess ? userGuess : null
        const distance = guessPosition
            ? calculateDistance(
                guessPosition.lat, guessPosition.lng,
                goalPoint.lat, goalPoint.lng
            )
            : MAX_DISTANCE_IN_BOUNDS

        const calculatedScore = calculateScore(distance)
        const updateInfo = async () => {
            if (auth.currentUser != null) {
                const user = auth.currentUser 
                const docRef = doc(db, "users", user.uid)
                const docSnap = await getDoc(docRef);
                try {
                    if (calculatedScore != undefined) {
                        await updateDoc(docRef, {
                        totalPoints: increment(calculatedScore)
                        }); 
                        if (calculatedScore > docSnap.get("highScore")) {
                            await updateDoc(docRef, {highScore: calculatedScore})
                        }
                    }
                } catch (error) {
                    console.error("Error updating scores", error);
                }
            }
        };
        updateInfo()
        
        setScore(`${calculatedScore}pts`)
        setGuessInfo(formatDistanceText(distance, hasGuess))
        setSubmittedGoal(goalPoint)
        setSubmittedGuess(guessPosition || DEFAULT_POSITION)
        return calculatedScore
    }, [goalPoint, userGuess])

    const resetGuess = useCallback(() => {
        setUserGuess(DEFAULT_POSITION)
        setSubmittedGuess(null)
        setSubmittedGoal(null)
        setScore(null)
        setGuessInfo(null)
    }, [])
    

    return {
        userGuess,
        submittedGuess,
        submittedGoal,
        score,
        guessInfo,
        setUserGuess,
        submitGuess,
        resetGuess
    }
}

function UIOverlay({ timerText, currentRound, isDaily }) {
    return (
        <div id={styles["overlay"]}>
            <Link href="/lobby">
                <img src="./logo.png" style={{ maxHeight: "60px" }} alt="Logo" />
            </Link>
            <div id={styles["timer"]}>{timerText}</div>
            <div id={styles["roundCounter"]}>{isDaily ? "Daily · " : ""}Round {Math.min(currentRound, MAX_ROUNDS)}</div>
        </div>
    )
}

function ControlOverlay({ onZoomIn, onZoomOut }) {
    return (
        <div id={styles.controlsOverlay}>
            <button id={styles["zoomIn"]} onClick={onZoomIn}>+</button>
            <button id={styles["zoomOut"]} onClick={onZoomOut}>-</button>
        </div>
    )
}




// useSearchParams needs a Suspense boundary for the production build
export default function GamePage() {
    return (
        <Suspense fallback={null}>
            <Gameplay />
        </Suspense>
    )
}

function Gameplay() {
    const isDaily = useSearchParams().get("mode") === "daily"
    // Fixed when the game starts, so a game played across midnight keeps the same locations
    const [dailyKey] = useState(() => getDailyKey())
    const [showScoreScreen, setShowScoreScreen] = useState(false)
    const [currentRound, setCurrentRound] = useState(1)
    const [isMapExpanded, setIsMapExpanded] = useState(false)
    const [roundScores, setRoundScores] = useState([])
    const [dailyStreak, setDailyStreak] = useState(null)
    const panoramaRef = useRef(null)

    const getPointGenerator = useCallback(
        (round) => isDaily ? createDailyPointGenerator(dailyKey, round) : randomPointGenerator(),
        [isDaily, dailyKey]
    )


    const { isLoaded } = useJsApiLoader({
        id: 'google-map-script',
        googleMapsApiKey: GOOGLE_MAPS_API_KEY,
        libraries: GOOGLE_MAPS_LIBRARIES
    })

    const { playEffect, startScoreAdd, stopScoreAdd } = useAudio()

    const { goalPoint, findValidPanorama, zoomIn, zoomOut } = useStreetViewPanorama(isLoaded, panoramaRef, getPointGenerator)
    const gameLogic = useGameLogic(goalPoint)
    const { seconds: timerSeconds, reset: resetTimer, formatted: timerText } = useTimer(
        INITIAL_TIMER_SECONDS,
        () => handleSubmitGuess()
    )

    // No audio stop helper needed; no score-fill audio

    const handleSubmitGuess = useCallback(() => {
        // The timer keeps running on the score screen; don't submit the same round twice
        if (showScoreScreen || currentRound > MAX_ROUNDS) return

        const roundScore = gameLogic.submitGuess()
        if (roundScore === undefined) return

        const newRoundScores = [...roundScores, roundScore]
        setRoundScores(newRoundScores)
        if (isDaily && newRoundScores.length === MAX_ROUNDS && auth.currentUser) {
            recordDailyResult(db, auth.currentUser.uid, dailyKey, newRoundScores)
                .then(setDailyStreak)
                .catch(error => console.error("Error saving daily challenge", error))
        }

        setCurrentRound(prev => prev + 1)
        setShowScoreScreen(true)
        // Restart and slightly delay score-fill sound to avoid race with UI updates
        try { stopScoreAdd() } catch { }
        setTimeout(() => { try { startScoreAdd() } catch { } }, 60)
    }, [gameLogic, startScoreAdd, stopScoreAdd, showScoreScreen, currentRound, roundScores, isDaily, dailyKey])

    const handleMapClick = useCallback((position) => {
        playEffect()
        gameLogic.setUserGuess(position)
    }, [gameLogic, playEffect])

    const handleScoreBarComplete = useCallback(() => {
        // Stop score-fill audio when the bar completes
        try { stopScoreAdd() } catch { }
    }, [stopScoreAdd])

    const startRound = useCallback(() => {
        if (currentRound > MAX_ROUNDS) return

        playEffect()
        const nextPoint = getPointGenerator(currentRound)
        const randomPoint = nextPoint()
        const newGoalPoint = createPosition(randomPoint.lat, randomPoint.long)

        gameLogic.resetGuess()
        setShowScoreScreen(false)
        resetTimer(INITIAL_TIMER_SECONDS)
        findValidPanorama(newGoalPoint, nextPoint)
    }, [currentRound, gameLogic, resetTimer, findValidPanorama, playEffect, getPointGenerator])

    const shareText = isDaily && roundScores.length === MAX_ROUNDS
        ? buildShareText(dailyKey, roundScores, dailyStreak)
        : null


    return (
        <div className={styles.umbrella} style={styles}>
            <div
                data-panorama-container
                ref={panoramaRef}
                style={{ width: "100vw", height: "100vh" }}
            />
            <UIOverlay timerText={timerText} currentRound={currentRound} isDaily={isDaily} />
            <ControlOverlay onZoomIn={zoomIn} onZoomOut={zoomOut} />
            {!showScoreScreen && (
                <GuessMap
                    isLoaded={isLoaded}
                    userGuess={gameLogic.userGuess}
                    onMapClick={handleMapClick}
                    isExpanded={isMapExpanded}
                    onToggleExpand={() => setIsMapExpanded(prev => !prev)}
                    onSubmitGuess={handleSubmitGuess}
                    options={{ disableDefaultUI: true }}
                />
            )}
            <ScoreScreen
                show={showScoreScreen}
                score={gameLogic.score}
                guessInfo={gameLogic.guessInfo}
                goalPoint={gameLogic.submittedGoal}
                guessPoint={gameLogic.submittedGuess}
                isLoaded={isLoaded}
                onNextRound={startRound}
                onScoreBarComplete={handleScoreBarComplete}
                currentRound={currentRound}
                isDaily={isDaily}
                totalScore={roundScores.reduce((sum, score) => sum + score, 0)}
                shareText={shareText}
                dailyStreak={dailyStreak}
            />
        </div>
    )
}
