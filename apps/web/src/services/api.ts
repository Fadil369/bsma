import { Appointment, CallLog, Visitor } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export interface STTResult {
  text: string;
  language?: string;
}

export interface TTSOptions {
  voice?: string;
  format?: 'wav' | 'mp3' | 'mulaw' | 'pcm';
}

export const api = {
  // Speech-to-Text: transcribe audio
  transcribeAudio: async (audioBase64: string, mimeType: string = 'audio/wav'): Promise<STTResult> => {
    const res = await fetch(`${API_URL}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64, mimeType }),
    });
    if (!res.ok) {
      throw new Error(`STT failed: ${res.statusText}`);
    }
    return res.json();
  },

  // Text-to-Speech: synthesize audio
  synthesizeSpeech: async (text: string, options?: TTSOptions): Promise<Blob> => {
    const res = await fetch(`${API_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: options?.voice || 'alloy',
        format: options?.format || 'mp3',
      }),
    });
    if (!res.ok) {
      throw new Error(`TTS failed: ${res.statusText}`);
    }
    return res.blob();
  },

  getAppointments: async (): Promise<Appointment[]> => {
    const res = await fetch(`${API_URL}/appointments`);
    return res.json();
  },

  createAppointment: async (apt: Partial<Appointment>): Promise<Appointment> => {
    const res = await fetch(`${API_URL}/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apt),
    });
    return res.json();
  },

  getLogs: async (): Promise<CallLog[]> => {
    const res = await fetch(`${API_URL}/logs`);
    return res.json();
  },

  createLog: async (log: Partial<CallLog>): Promise<{ id: string }> => {
    const res = await fetch(`${API_URL}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    return res.json();
  },

  getVisitors: async (): Promise<Visitor[]> => {
    const res = await fetch(`${API_URL}/visitors`);
    return res.json();
  },

  createVisitor: async (visitor: Partial<Visitor>): Promise<{ id: string }> => {
    const res = await fetch(`${API_URL}/visitors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(visitor),
    });
    return res.json();
  },

  sendMessage: async (msg: { channel: string; content: string; visitor_id?: string; recipient: string }) => {
    const res = await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    return res.json();
  },
  
  getDashboard: async () => {
     const res = await fetch(`${API_URL}/dashboard`);
     return res.json();
  }
};
