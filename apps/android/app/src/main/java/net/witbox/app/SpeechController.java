package net.witbox.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.text.TextUtils;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Speech-to-text (SpeechRecognizer) and text-to-speech (TextToSpeech). Main thread only. */
final class SpeechController {
    interface Emitter {
        void emit(String event, JSONObject data);
    }

    private static final String TAG = "CBSpeech";

    private final Context ctx;
    private final Emitter emitter;
    private final Handler main = new Handler(Looper.getMainLooper());

    // ---- recognition ----
    private SpeechRecognizer recognizer;
    private boolean listening;
    private int listenSession;

    // ---- TTS ----
    private TextToSpeech tts;
    private boolean ttsReady;
    private boolean ttsFailed;
    private String pendingText;
    private String pendingLang;
    private int speakSession;
    private String lastUtteranceId;

    SpeechController(Context ctx, Emitter emitter) {
        this.ctx = ctx.getApplicationContext();
        this.emitter = emitter;
    }

    private static JSONObject obj(String key, String value) {
        JSONObject o = new JSONObject();
        try {
            if (key != null) o.put(key, value == null ? "" : value);
        } catch (Throwable ignored) {
        }
        return o;
    }

    // =====================================================================================
    // Speech recognition
    // =====================================================================================

    /** Returns null on success or an error message. RECORD_AUDIO must already be granted. */
    String startListening(String lang) {
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
            return "speech recognition is not available on this device";
        }
        try {
            if (recognizer != null) {
                // Restart cleanly; the old session must not emit events any more.
                listenSession++;
                try {
                    recognizer.cancel();
                } catch (Throwable ignored) {
                }
                try {
                    recognizer.destroy();
                } catch (Throwable ignored) {
                }
                recognizer = null;
            }
            final int session = ++listenSession;
            recognizer = SpeechRecognizer.createSpeechRecognizer(ctx);
            recognizer.setRecognitionListener(new Listener(session));

            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.getPackageName());
            if (!TextUtils.isEmpty(lang)) {
                String tag = lang.replace('_', '-');
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, tag);
            }
            recognizer.startListening(i);
            listening = true;
            return null;
        } catch (Throwable t) {
            Log.w(TAG, "startListening failed", t);
            listening = false;
            return "could not start speech recognition: " + t.getMessage();
        }
    }

    void stopListening() {
        if (recognizer == null || !listening) return;
        try {
            recognizer.stopListening(); // final results (if any) still arrive through the listener
        } catch (Throwable ignored) {
        }
        // Some engines never call back after stopListening() when nothing was said.
        final int session = listenSession;
        main.postDelayed(() -> {
            if (session == listenSession && listening) {
                listening = false;
                listenSession++;
                try {
                    if (recognizer != null) recognizer.cancel();
                } catch (Throwable ignored) {
                }
                emitter.emit("speechEnd", new JSONObject());
            }
        }, 4000);
    }

    private final class Listener implements RecognitionListener {
        private final int session;
        private boolean ended;

        Listener(int session) {
            this.session = session;
        }

        private boolean stale() {
            return session != listenSession;
        }

        private static String first(Bundle b) {
            if (b == null) return "";
            ArrayList<String> l = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            return (l == null || l.isEmpty() || l.get(0) == null) ? "" : l.get(0);
        }

        private void end() {
            if (ended) return;
            ended = true;
            listening = false;
            emitter.emit("speechEnd", new JSONObject());
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            if (stale() || ended) return;
            String t = first(partialResults);
            if (!t.isEmpty()) emitter.emit("speechPartial", obj("text", t));
        }

        @Override
        public void onResults(Bundle results) {
            if (stale() || ended) return;
            emitter.emit("speechFinal", obj("text", first(results)));
            end();
        }

        @Override
        public void onError(int error) {
            if (stale() || ended) return;
            // "Nothing heard" is a normal end of a session, not an error for the page.
            if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                emitter.emit("speechError", obj("message", describe(error)));
            }
            end();
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
        }

        @Override
        public void onBeginningOfSpeech() {
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    }

    private static String describe(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio recording error";
            case SpeechRecognizer.ERROR_CLIENT:
                return "client error";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "microphone permission denied";
            case SpeechRecognizer.ERROR_NETWORK:
                return "network error";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network timeout";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "recognizer busy";
            case SpeechRecognizer.ERROR_SERVER:
                return "recognition server error";
            case 10: // ERROR_TOO_MANY_REQUESTS
                return "too many requests";
            case 11: // ERROR_SERVER_DISCONNECTED
                return "recognition service disconnected";
            case 12: // ERROR_LANGUAGE_NOT_SUPPORTED
                return "language not supported";
            case 13: // ERROR_LANGUAGE_UNAVAILABLE
                return "language not available (download it in the speech settings)";
            default:
                return "speech error " + error;
        }
    }

    // =====================================================================================
    // Text to speech
    // =====================================================================================

    private volatile float rate = 1f;

    /** Speech speed for the following utterances (1.0 = normal). */
    void setRate(float r) {
        rate = (Float.isNaN(r) || r < 0.5f || r > 2.5f) ? 1f : r;
    }

    void speak(String text, String lang) {
        if (text == null) text = "";
        if (ttsFailed) {
            // Try to initialise again; engines can be installed later.
            ttsFailed = false;
            shutdownTts();
        }
        if (tts == null) {
            pendingText = text;
            pendingLang = lang;
            ttsReady = false;
            try {
                tts = new TextToSpeech(ctx, status -> main.post(() -> onTtsInit(status)));
            } catch (Throwable t) {
                Log.w(TAG, "TTS init failed", t);
                ttsFailed = true;
                pendingText = null;
                emitter.emit("speakEnd", obj("error", "text-to-speech unavailable"));
            }
            return;
        }
        if (!ttsReady) {
            pendingText = text;
            pendingLang = lang;
            return;
        }
        doSpeak(text, lang);
    }

    private void onTtsInit(int status) {
        if (tts == null) return;
        if (status != TextToSpeech.SUCCESS) {
            ttsFailed = true;
            pendingText = null;
            emitter.emit("speakEnd", obj("error", "text-to-speech unavailable"));
            return;
        }
        ttsReady = true;
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
            }

            @Override
            public void onDone(String utteranceId) {
                finished(utteranceId);
            }

            @Override
            public void onError(String utteranceId) {
                finished(utteranceId);
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                finished(utteranceId);
            }

            @Override
            public void onStop(String utteranceId, boolean interrupted) {
                // stopSpeaking() / a newer speak() emit speakEnd themselves.
            }
        });
        if (pendingText != null) {
            String t = pendingText, l = pendingLang;
            pendingText = null;
            pendingLang = null;
            doSpeak(t, l);
        }
    }

    /** Called on a TTS binder thread. */
    private void finished(final String utteranceId) {
        main.post(() -> {
            if (utteranceId != null && utteranceId.equals(lastUtteranceId)) {
                lastUtteranceId = null;
                emitter.emit("speakEnd", new JSONObject());
            }
        });
    }

    private void doSpeak(String text, String lang) {
        final int session = ++speakSession;
        boolean wasSpeaking = lastUtteranceId != null;
        lastUtteranceId = null;
        try {
            if (!TextUtils.isEmpty(lang)) {
                Locale loc = Locale.forLanguageTag(lang.replace('_', '-'));
                int r = tts.setLanguage(loc);
                if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                    Log.w(TAG, "TTS language not supported: " + lang);
                    // Fall back to the language without region, then to the engine default.
                    r = tts.setLanguage(new Locale(loc.getLanguage()));
                    if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                        tts.setLanguage(Locale.getDefault());
                    }
                }
            }
            List<String> chunks = split(text, Math.max(500, TextToSpeech.getMaxSpeechInputLength() - 100));
            if (wasSpeaking) emitter.emit("speakEnd", new JSONObject()); // the previous utterance was cut off
            if (chunks.isEmpty()) {
                tts.stop();
                emitter.emit("speakEnd", new JSONObject());
                return;
            }
            String lastId = null;
            for (int i = 0; i < chunks.size(); i++) {
                String id = "cb-" + session + "-" + i;
                if (i == 0) tts.setSpeechRate(rate);
                int r = tts.speak(chunks.get(i), i == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD,
                        new Bundle(), id);
                if (r != TextToSpeech.SUCCESS) break;
                lastId = id;
            }
            if (lastId == null) {
                emitter.emit("speakEnd", obj("error", "text-to-speech failed"));
            } else {
                lastUtteranceId = lastId;
            }
        } catch (Throwable t) {
            Log.w(TAG, "speak failed", t);
            lastUtteranceId = null;
            emitter.emit("speakEnd", obj("error", "text-to-speech failed"));
        }
    }

    /** Splits long text at sentence / word boundaries into chunks of at most max chars. */
    private static List<String> split(String text, int max) {
        List<String> out = new ArrayList<>();
        String rest = text.trim();
        while (rest.length() > max) {
            int cut = -1;
            for (int i = max - 1; i > max / 2; i--) {
                char ch = rest.charAt(i);
                if (ch == '.' || ch == '!' || ch == '?' || ch == '\n' || ch == ';' || ch == ':') {
                    cut = i + 1;
                    break;
                }
            }
            if (cut < 0) {
                int sp = rest.lastIndexOf(' ', max - 1);
                cut = sp > max / 2 ? sp + 1 : max;
            }
            String piece = rest.substring(0, cut).trim();
            if (!piece.isEmpty()) out.add(piece);
            rest = rest.substring(cut).trim();
        }
        if (!rest.isEmpty()) out.add(rest);
        return out;
    }

    void stopSpeaking() {
        pendingText = null;
        pendingLang = null;
        boolean wasSpeaking = lastUtteranceId != null;
        lastUtteranceId = null;
        speakSession++;
        try {
            if (tts != null && ttsReady) tts.stop();
        } catch (Throwable ignored) {
        }
        if (wasSpeaking) emitter.emit("speakEnd", new JSONObject());
    }

    private void shutdownTts() {
        try {
            if (tts != null) {
                tts.stop();
                tts.shutdown();
            }
        } catch (Throwable ignored) {
        }
        tts = null;
        ttsReady = false;
        lastUtteranceId = null;
    }

    void destroy() {
        listenSession++;
        listening = false;
        main.removeCallbacksAndMessages(null);
        try {
            if (recognizer != null) {
                recognizer.cancel();
                recognizer.destroy();
            }
        } catch (Throwable ignored) {
        }
        recognizer = null;
        pendingText = null;
        shutdownTts();
    }
}
