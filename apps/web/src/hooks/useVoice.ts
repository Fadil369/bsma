import { useState, useRef, useCallback, useEffect } from 'react';

export type VoiceConnectionState = 
  | 'idle' 
  | 'connecting' 
  | 'active' 
  | 'error' 
  | 'reconnecting';

export interface VoiceConfig {
  apiUrl: string;
  sampleRateIn?: number;  // Microphone sample rate
  sampleRateOut?: number; // Playback sample rate
  enableVAD?: boolean;    // Voice Activity Detection
  language?: 'en' | 'ar' | 'mixed';
}

export interface VoiceTranscript {
  text: string;
  language?: string;
  isFinal: boolean;
  timestamp: number;
}

export interface UseVoiceReturn {
  connectionState: VoiceConnectionState;
  isListening: boolean;
  isSpeaking: boolean;
  transcript: VoiceTranscript | null;
  audioLevel: number;
  error: string | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
  speak: (text: string, lang?: string) => Promise<void>;
  stopSpeaking: () => void;
  transcribeAudio: (audio: Blob) => Promise<string>;
  synthesizeSpeech: (text: string, voice?: string) => Promise<ArrayBuffer>;
}

const DEFAULT_CONFIG: Required<VoiceConfig> = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787',
  sampleRateIn: 16000,
  sampleRateOut: 24000,
  enableVAD: true,
  language: 'mixed',
};

export function useVoice(config?: Partial<VoiceConfig>): UseVoiceReturn {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  
  const [connectionState, setConnectionState] = useState<VoiceConnectionState>('idle');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<VoiceTranscript | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  
  // Refs to track current state for use in callbacks (avoid stale closures)
  const isListeningRef = useRef(isListening);
  const connectionStateRef = useRef(connectionState);
  
  // Keep refs in sync with state
  useEffect(() => {
    isListeningRef.current = isListening;
    connectionStateRef.current = connectionState;
  }, [isListening, connectionState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Use direct cleanup instead of calling hooks
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        mediaStreamRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      speechSynthesis.cancel();
    };
  }, []);

  // Audio level monitoring
  const updateAudioLevel = useCallback(() => {
    if (!analyserRef.current || !isListeningRef.current) {
      setAudioLevel(0);
      return;
    }

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);
    
    const sum = dataArray.reduce((a, b) => a + b, 0);
    const average = sum / dataArray.length;
    const normalizedLevel = Math.min(average / 128, 1);
    
    setAudioLevel(normalizedLevel);
    animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
  }, [isListening]);

  // STT API call - transcribe audio blob via backend
  const transcribeAudio = useCallback(async (audioBlob: Blob): Promise<string> => {
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      
      // Use chunked base64 encoding for better performance with large audio files
      // Loop approach avoids call stack issues with large arrays
      let base64 = '';
      const chunkSize = 32768; // Process 32KB at a time
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        let chunkStr = '';
        for (let j = 0; j < chunk.length; j++) {
          chunkStr += String.fromCharCode(chunk[j]);
        }
        base64 += chunkStr;
      }
      base64 = btoa(base64);

      const response = await fetch(`${mergedConfig.apiUrl}/stt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioBase64: base64,
          mimeType: audioBlob.type || 'audio/wav',
        }),
      });

      if (!response.ok) {
        throw new Error(`STT request failed: ${response.statusText}`);
      }

      const result = await response.json();
      return result.text || '';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transcription failed';
      console.error('Transcription error:', message);
      throw new Error(message);
    }
  }, [mergedConfig.apiUrl]);

  // TTS API call - synthesize speech via backend
  const synthesizeSpeech = useCallback(async (
    text: string, 
    voice?: string
  ): Promise<ArrayBuffer> => {
    try {
      const response = await fetch(`${mergedConfig.apiUrl}/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          voice: voice || 'alloy',
          format: 'mp3',
        }),
      });

      if (!response.ok) {
        throw new Error(`TTS request failed: ${response.statusText}`);
      }

      return await response.arrayBuffer();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Speech synthesis failed';
      console.error('TTS error:', message);
      throw new Error(message);
    }
  }, [mergedConfig.apiUrl]);

  // Start listening using Web Speech API
  const startListening = useCallback(async () => {
    try {
      setError(null);
      setConnectionState('connecting');

      // Check for browser support
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      const SpeechRecognitionAPI = win.SpeechRecognition || win.webkitSpeechRecognition;

      if (!SpeechRecognitionAPI) {
        throw new Error('Speech recognition not supported in this browser');
      }

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: mergedConfig.sampleRateIn,
        }
      });
      mediaStreamRef.current = stream;

      // Set up audio context for level monitoring
      audioContextRef.current = new AudioContext({ sampleRate: mergedConfig.sampleRateIn });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      source.connect(analyserRef.current);

      // Initialize speech recognition
      const recognition = new SpeechRecognitionAPI();
      recognition.lang = mergedConfig.language === 'ar' ? 'ar-SA' : 
                         mergedConfig.language === 'en' ? 'en-US' : 'ar-SA';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
        setConnectionState('active');
        updateAudioLevel();
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        const result = event.results[event.results.length - 1];
        const transcriptText = result[0].transcript;
        
        setTranscript({
          text: transcriptText,
          isFinal: result.isFinal,
          timestamp: Date.now(),
        });
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onerror = (event: any) => {
        console.error('Recognition error:', event.error);
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          setError(`Speech recognition error: ${event.error}`);
          setConnectionState('error');
        }
      };

      recognition.onend = () => {
        // Auto-restart if still listening (use refs to avoid stale closures)
        if (isListeningRef.current && connectionStateRef.current === 'active') {
          try {
            recognition.start();
          } catch {
            // Already started, ignore
          }
        }
      };

      recognition.start();
      recognitionRef.current = recognition;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start listening';
      setError(message);
      setConnectionState('error');
      setIsListening(false);
      console.error('Start listening error:', err);
    }
  }, [mergedConfig, updateAudioLevel]);

  // Stop listening
  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    setIsListening(false);
    setConnectionState('idle');
    setAudioLevel(0);
  }, []);

  // Speak text using browser TTS or backend TTS
  const speak = useCallback(async (text: string, lang: string = 'ar-SA') => {
    setIsSpeaking(true);
    
    // Try backend TTS first for better quality
    let backendSucceeded = false;
    let audioContext: AudioContext | null = null;
    
    try {
      const audioBuffer = await synthesizeSpeech(text);
      audioContext = new AudioContext();
      const decodedAudio = await audioContext.decodeAudioData(audioBuffer);
      const source = audioContext.createBufferSource();
      source.buffer = decodedAudio;
      source.connect(audioContext.destination);
      
      // Store reference for cleanup in onended callback
      const ctx = audioContext;
      source.onended = () => {
        setIsSpeaking(false);
        ctx.close().catch(() => {
          // Ignore errors during close
        });
      };
      source.start(0);
      backendSucceeded = true;
    } catch (backendError) {
      // Clean up audio context if backend TTS failed
      if (audioContext) {
        audioContext.close().catch(() => {
          // Ignore errors during cleanup
        });
      }
      console.warn('Backend TTS failed, falling back to browser TTS:', backendError);
    }

    // Only fall back to browser TTS if backend failed
    if (!backendSucceeded) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = 0.9;
      utterance.pitch = 1;
      
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = (e) => {
        console.error('Speech synthesis error:', e);
        setIsSpeaking(false);
      };
      
      synthRef.current = utterance;
      speechSynthesis.speak(utterance);
    }
  }, [synthesizeSpeech]);

  // Stop speaking
  const stopSpeaking = useCallback(() => {
    speechSynthesis.cancel();
    setIsSpeaking(false);
  }, []);

  return {
    connectionState,
    isListening,
    isSpeaking,
    transcript,
    audioLevel,
    error,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    transcribeAudio,
    synthesizeSpeech,
  };
}

export default useVoice;
