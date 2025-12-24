
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useSaudiLanguage } from '../../hooks/useSaudiLanguage';
import { api } from '../../services/api';

interface VoiceInterfaceProps {
  onTranscript?: (text: string) => void;
  onResponse?: (response: { english: string; arabic: string }) => void;
}

type ConnectionStatus = 'idle' | 'connecting' | 'active' | 'error';

export const VoiceInterface: React.FC<VoiceInterfaceProps> = ({ 
  onTranscript,
  onResponse 
}) => {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState({ english: '', arabic: '' });
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  
  const { translateToSaudiDialect, formatArabicText } = useSaudiLanguage();

  // Cleanup audio level monitoring
  const stopAudioLevelMonitoring = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  // Start audio level monitoring
  const startAudioLevelMonitoring = useCallback(() => {
    const updateLevel = () => {
      if (!analyserRef.current) {
        return;
      }

      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);
      
      const sum = dataArray.reduce((a, b) => a + b, 0);
      const average = sum / dataArray.length;
      setAudioLevel(Math.min(average / 128, 1));
      
      animationFrameRef.current = requestAnimationFrame(updateLevel);
    };

    updateLevel();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAudioLevelMonitoring();
    };
  }, [stopAudioLevelMonitoring]);

  const handleStart = async () => {
    setErrorMessage(null);
    
    // Check for browser support
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;
    const SpeechRecognitionAPI = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      setErrorMessage('Speech recognition not supported in this browser.');
      setConnectionStatus('error');
      return;
    }

    try {
      setConnectionStatus('connecting');

      // Request microphone permission and set up audio analysis
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      mediaStreamRef.current = stream;

      // Set up audio context for level monitoring
      audioContextRef.current = new AudioContext();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      source.connect(analyserRef.current);

      const recognition = new SpeechRecognitionAPI();
      recognition.lang = 'ar-SA'; // Saudi Arabic
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setIsListening(true);
        setIsThinking(false);
        setConnectionStatus('active');
        startAudioLevelMonitoring();
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        const result = event.results[event.results.length - 1];
        const transcriptText = result[0].transcript;
        setTranscript(transcriptText);
        onTranscript?.(transcriptText);
        
        // Process final results
        if (result.isFinal) {
          processInput(transcriptText);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onerror = (event: any) => {
        console.error('Recognition error:', event.error);
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          setErrorMessage(`Speech recognition error: ${event.error}`);
          setConnectionStatus('error');
        }
      };

      recognition.onend = () => {
        // Auto-restart if still supposed to be listening
        if (isListening && connectionStatus === 'active') {
          try {
            recognition.start();
          } catch {
            // Already running, ignore
          }
        } else {
          setIsListening(false);
          setConnectionStatus('idle');
        }
      };

      recognition.start();
      recognitionRef.current = recognition;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start voice input';
      setErrorMessage(message);
      setConnectionStatus('error');
      console.error('Voice start error:', err);
    }
  };

  const handleStop = () => {
    // Stop speech recognition
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }

    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Stop audio level monitoring
    stopAudioLevelMonitoring();

    // Stop any ongoing speech
    speechSynthesis.cancel();
    
    setIsListening(false);
    setIsSpeaking(false);
    setConnectionStatus('idle');
    setAudioLevel(0);
  };

  const processInput = async (text: string) => {
    if (!text.trim()) return;
    
    setIsThinking(true);
    try {
      // Translate input to Saudi dialect for context (could be used in AI processing)
      const saudiText = translateToSaudiDialect(text);
      
      // Generate a contextual response (this would normally come from AI service)
      // The saudiText can be sent to backend for proper processing
      const responseText = {
        english: "I understand you need help. I can assist with appointments, inquiries, and support.",
        arabic: formatArabicText(`أبشر، فهمت طلبك. أقدر أساعدك في المواعيد والاستفسارات والدعم الفني.`)
      };
      
      // Log for debugging - saudiText would be sent to backend in production
      console.debug('Processed input:', { original: text, translated: saudiText });
      
      setResponse(responseText);
      onResponse?.(responseText);
      setIsThinking(false);
      
      // Speak the response
      await speakResponse(responseText.arabic, 'ar-SA');
    } catch (error) {
      console.error('Processing error:', error);
      setIsThinking(false);
      setErrorMessage('Failed to process your request. Please try again.');
    }
  };

  const speakResponse = async (text: string, lang: string) => {
    setIsSpeaking(true);
    
    try {
      // Try backend TTS first for better quality
      const audioBlob = await api.synthesizeSpeech(text, { voice: 'alloy', format: 'mp3' });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      
      audio.onended = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(audioUrl);
      };
      audio.onerror = () => {
        // Fallback to browser TTS on error
        fallbackToWebSpeech(text, lang);
      };
      
      await audio.play();
    } catch (err) {
      console.warn('Backend TTS failed, using browser fallback:', err);
      fallbackToWebSpeech(text, lang);
    }
  };

  const fallbackToWebSpeech = (text: string, lang: string) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9;
    utterance.pitch = 1;
    
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    
    speechSynthesis.speak(utterance);
  };

  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-2xl mx-auto p-8 rounded-[30px] glass-morphism relative overflow-hidden">
      {/* Visualizer Background */}
      <div className="absolute inset-0 opacity-10 pointer-events-none">
        <AudioVisualizer isActive={isListening || isSpeaking} level={audioLevel} />
      </div>

      <div className="z-10 text-center">
        <h2 className="orbitron-font text-3xl font-black mb-2 tracking-widest text-white">
          BASMA <span className="text-gold arabic-font">بسمة</span>
        </h2>
        <p className="rajdhani-font text-sm tracking-[0.2em] text-white/60 uppercase">
          Neural Voice Secretary • Saudi Edition
        </p>
      </div>

      {/* Connection Status Indicator */}
      <div className="z-10 flex items-center gap-2">
        <div 
          className={`w-2 h-2 rounded-full ${
            connectionStatus === 'active' ? 'bg-green-500 animate-pulse' :
            connectionStatus === 'connecting' ? 'bg-yellow-500 animate-pulse' :
            connectionStatus === 'error' ? 'bg-red-500' :
            'bg-gray-500'
          }`}
        />
        <span className="rajdhani-font text-xs text-white/60 uppercase tracking-wider">
          {connectionStatus === 'active' ? 'Connected' :
           connectionStatus === 'connecting' ? 'Connecting...' :
           connectionStatus === 'error' ? 'Error' :
           'Ready'}
        </span>
      </div>

      {/* Error Message */}
      {errorMessage && (
        <div className="z-10 w-full p-3 bg-red-500/20 border border-red-500/40 rounded-xl">
          <p className="text-red-300 text-sm text-center">{errorMessage}</p>
        </div>
      )}

      {/* Transcription Area */}
      <div className="z-10 w-full min-h-[120px] flex flex-col gap-4 p-6 bg-black/20 rounded-2xl border border-white/5">
        {transcript && (
          <div className="text-right slide-in">
            <p className="text-white/40 text-xs mb-1 rajdhani-font uppercase tracking-wider">User</p>
            <p className="arabic-font text-lg text-white/90">{transcript}</p>
          </div>
        )}
        
        {isThinking ? (
          <div className="text-left mt-2">
            <p className="text-gold/40 text-xs mb-1 rajdhani-font uppercase tracking-wider">Basma</p>
            <span className="thinking-dots rajdhani-font text-gold">Accessing Neural Core</span>
          </div>
        ) : response.arabic && (
          <div className="text-left mt-2 fade-in">
            <p className="text-gold/40 text-xs mb-1 rajdhani-font uppercase tracking-wider">Basma</p>
            <p className="arabic-font text-xl text-gold mb-2">{response.arabic}</p>
            <p className="rajdhani-font text-sm text-white/70 italic">{response.english}</p>
          </div>
        )}
        
        {!transcript && !response.arabic && !isThinking && (
          <div className="text-center py-4">
            <p className="text-white/30 text-sm rajdhani-font">
              {isListening ? 'Listening... speak now' : 'Press the microphone to start'}
            </p>
          </div>
        )}
      </div>

      {/* Audio Level Bar */}
      {isListening && (
        <div className="z-10 w-full h-1 bg-white/10 rounded-full overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-green-400 to-emerald-500 transition-all duration-100"
            style={{ width: `${audioLevel * 100}%` }}
          />
        </div>
      )}

      {/* Controls */}
      <div className="z-10 flex items-center gap-6">
        {connectionStatus === 'connecting' ? (
          <div className="w-20 h-20 rounded-full bg-yellow-500/20 border-2 border-yellow-500 flex items-center justify-center">
            <div className="w-8 h-8 border-4 border-yellow-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !isListening ? (
          <button 
            onClick={handleStart}
            className="w-20 h-20 rounded-full saudi-gradient flex items-center justify-center gold-shadow transition-all hover:scale-110 active:scale-95 group"
          >
            <div className="w-10 h-10 text-white group-hover:animate-pulse">
              <svg fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
            </div>
          </button>
        ) : (
          <button 
            onClick={handleStop}
            className="w-20 h-20 rounded-full bg-red-600/20 border-2 border-red-600 flex items-center justify-center transition-all hover:scale-110 active:scale-95"
          >
             <div className="w-8 h-8 bg-red-600 rounded-sm animate-pulse"></div>
          </button>
        )}
      </div>

      {/* Status Messages */}
      {isListening && (
        <div className="z-10 rajdhani-font text-xs text-saudi-green-light animate-pulse tracking-[0.3em] uppercase">
          Live Uplink Active
        </div>
      )}
      
      {isSpeaking && (
        <div className="z-10 rajdhani-font text-xs text-gold animate-pulse tracking-[0.3em] uppercase">
          Basma Speaking
        </div>
      )}
    </div>
  );
};

const AudioVisualizer: React.FC<{ isActive: boolean; level: number }> = ({ isActive, level }) => {
  // Use level to create more dynamic visualization
  const bars = 20;
  return (
    <div className="flex items-center justify-center gap-1 h-full w-full py-10">
      {[...Array(bars)].map((_, i) => {
        // Create wave pattern based on level and position
        const distanceFromCenter = Math.abs(i - bars / 2) / (bars / 2);
        const baseHeight = isActive ? 20 + (1 - distanceFromCenter) * level * 60 : 10;
        // Use index-based variation instead of random to avoid purity issues
        const indexVariation = isActive ? (Math.sin(i * 0.5) * 10 + 10) * level : 0;
        
        return (
          <div 
            key={i}
            className="w-1 bg-saudi-green-light rounded-full transition-all duration-100"
            style={{ 
              height: `${baseHeight + indexVariation}%`,
              opacity: isActive ? 0.4 + level * 0.6 : 0.2
            }}
          />
        );
      })}
    </div>
  );
};
