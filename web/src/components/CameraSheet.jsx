import { useCallback, useEffect, useRef, useState } from 'react';
import L from '../labels';
import { captureFromVideo } from '../lib/image';
import { Spinner } from './ui';

/**
 * Full-screen in-app camera.
 *
 * Why this exists: handing off to the phone's camera app makes Android write a
 * multi-megabyte temp file before the browser ever sees the photo, and that
 * write fails with a "not enough storage" toast when the phone is near
 * Android's low-storage threshold (a *percentage* of the partition, so it fires
 * while gigabytes still look free). Here the frame goes straight from the live
 * stream to a canvas to a ~150KB JPEG in memory — no file is ever written.
 *
 * Every failure path falls back to the camera app rather than dead-ending: a
 * guard at the gate must always be able to take the photo.
 */
export default function CameraSheet({ onCapture, onClose, onFallback }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  // Guards tap hard and twice; one shutter press must produce one photo.
  const shootingRef = useRef(false);
  const [facing, setFacing] = useState('environment');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  const stop = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // `ideal`, not `exact`: a phone with only one camera should still open
          // it rather than throwing OverconstrainedError.
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 1280 },
            height: { ideal: 960 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        stop(); // release the previous facing-mode stream before swapping in the new one
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        // Permission denied is worth explaining; anything else (no camera, in
        // use by another app, insecure context) just goes to the camera app.
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
          setError(L.gate.cameraBlocked);
        } else {
          onFallback();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [facing, stop, onFallback]);

  // Release the camera on unmount, however the sheet was closed.
  useEffect(() => stop, [stop]);

  const shoot = async () => {
    const video = videoRef.current;
    if (!video || !ready || shootingRef.current) return;
    shootingRef.current = true;
    try {
      const result = await captureFromVideo(video);
      stop();
      onCapture(result);
    } catch (err) {
      shootingRef.current = false;
      setError(err.message || L.somethingWrong);
    }
  };

  const useApp = () => {
    stop();
    onFallback();
  };

  const close = () => {
    stop();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black"
      // Keep the bottom controls clear of the home-indicator / gesture bar.
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      role="dialog"
      aria-modal="true"
      aria-label={L.gate.takePhoto}
    >
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={`h-full w-full object-cover ${facing === 'user' ? 'scale-x-[-1]' : ''}`}
        />

        {!ready && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black text-white">
            <Spinner className="h-8 w-8 text-white" />
            <p className="text-lg">{L.gate.cameraStarting}</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black px-6 text-center text-white">
            <span className="text-5xl" aria-hidden="true">📷</span>
            <p className="text-lg">{error}</p>
          </div>
        )}
      </div>

      {/* Controls sit on black below the preview so nothing important hides
          under a thumb, and the shutter is reachable one-handed. */}
      <div className="flex items-center justify-between gap-4 px-6 pb-8 pt-5">
        <button type="button" onClick={close} className="min-w-[88px] py-3 text-left text-lg font-semibold text-white">
          {L.gate.cameraClose}
        </button>

        <button
          type="button"
          onClick={shoot}
          disabled={!ready}
          aria-label={L.gate.cameraShutter}
          className="h-20 w-20 shrink-0 rounded-full border-4 border-white bg-white/25 active:scale-95 disabled:opacity-40"
        >
          <span className="mx-auto block h-14 w-14 rounded-full bg-white" />
        </button>

        <button
          type="button"
          onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
          aria-label={L.gate.cameraSwitch}
          className="min-w-[88px] py-3 text-right text-3xl text-white"
        >
          🔄
        </button>
      </div>

      {/* The escape hatch. If the in-app preview misbehaves on some device we
          have never seen, the guard is still one tap from logging the visitor. */}
      <button type="button" onClick={useApp} className="pb-6 text-center text-base text-white/70 underline">
        {L.gate.cameraUseApp}
      </button>
    </div>
  );
}
