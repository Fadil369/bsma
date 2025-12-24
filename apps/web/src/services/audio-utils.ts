/**
 * Audio utilities for voice processing
 */

/**
 * Decode base64 string to Uint8Array
 */
export function decode(base64: string): Uint8Array {
  try {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (error) {
    console.error('Failed to decode base64:', error);
    return new Uint8Array(0);
  }
}

/**
 * Encode Uint8Array to base64 string
 */
export function encode(bytes: Uint8Array): string {
  try {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (error) {
    console.error('Failed to encode to base64:', error);
    return '';
  }
}

/**
 * Convert Int16 PCM data to AudioBuffer for playback
 */
export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  try {
    // Validate data length for proper Int16 alignment
    if (data.byteLength % 2 !== 0) {
      throw new Error('Audio data length must be a multiple of 2 for Int16 samples');
    }
    
    const dataInt16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
    
    // Validate that we have complete frames
    if (dataInt16.length % numChannels !== 0) {
      console.warn('Audio data does not contain complete frames, truncating');
    }
    
    const frameCount = Math.floor(dataInt16.length / numChannels);
    if (frameCount === 0) {
      return ctx.createBuffer(numChannels, 1, sampleRate);
    }
    
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i++) {
        // Convert Int16 to Float32 (-1.0 to 1.0)
        channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
      }
    }
    return buffer;
  } catch (error) {
    console.error('Failed to decode audio data:', error);
    // Return empty buffer
    return ctx.createBuffer(numChannels, 1, sampleRate);
  }
}

/**
 * Convert Float32 audio buffer to Int16 PCM
 */
export function float32ToInt16(float32Array: Float32Array): Int16Array {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    // Clamp the value to prevent overflow
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16Array;
}

/**
 * Convert Int16 PCM to Float32
 */
export function int16ToFloat32(int16Array: Int16Array): Float32Array {
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    const sample = int16Array[i];
    float32Array[i] = sample < 0 ? sample / 32768.0 : sample / 32767.0;
  }
  return float32Array;
}

/**
 * Resample audio data to a different sample rate using linear interpolation
 */
export function resampleAudio(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }

  const ratio = outputSampleRate / inputSampleRate;
  const outputLength = Math.floor(input.length * ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcPosition = i / ratio;
    const srcIndex = Math.floor(srcPosition);
    const fraction = srcPosition - srcIndex;

    if (srcIndex + 1 < input.length) {
      // Linear interpolation
      output[i] = input[srcIndex] * (1 - fraction) + input[srcIndex + 1] * fraction;
    } else {
      output[i] = input[srcIndex] || 0;
    }
  }

  return output;
}

/**
 * Calculate RMS (Root Mean Square) audio level
 */
export function calculateRMSLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Detect if audio contains speech (simple VAD)
 */
export function detectSpeech(
  samples: Float32Array,
  threshold: number = 0.01
): boolean {
  const rms = calculateRMSLevel(samples);
  return rms > threshold;
}

/**
 * Create a WAV header for PCM audio data
 */
export function createWavHeader(
  dataLength: number,
  sampleRate: number,
  numChannels: number = 1,
  bitsPerSample: number = 16
): ArrayBuffer {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Sub-chunk size
  view.setUint16(20, 1, true);  // Audio format (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  return header;
}

function writeString(view: DataView, offset: number, str: string): void {
  // Validate buffer bounds
  if (offset + str.length > view.byteLength) {
    throw new Error(`String "${str}" exceeds buffer at offset ${offset}`);
  }
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Create a WAV blob from Int16 PCM data
 */
export function createWavBlob(
  pcmData: Int16Array,
  sampleRate: number,
  numChannels: number = 1
): Blob {
  const dataLength = pcmData.byteLength;
  const header = createWavHeader(dataLength, sampleRate, numChannels);
  
  // Create a combined ArrayBuffer
  const combined = new ArrayBuffer(header.byteLength + pcmData.byteLength);
  const combinedView = new Uint8Array(combined);
  combinedView.set(new Uint8Array(header), 0);
  combinedView.set(new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength), header.byteLength);
  
  return new Blob([combined], { type: 'audio/wav' });
}

/**
 * Concatenate multiple audio buffers
 */
export function concatenateAudioBuffers(
  ctx: AudioContext,
  buffers: AudioBuffer[]
): AudioBuffer | null {
  if (buffers.length === 0) return null;
  if (buffers.length === 1) return buffers[0];

  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const numChannels = buffers[0].numberOfChannels;
  const sampleRate = buffers[0].sampleRate;

  const result = ctx.createBuffer(numChannels, totalLength, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const resultData = result.getChannelData(channel);
    let offset = 0;

    for (const buffer of buffers) {
      resultData.set(buffer.getChannelData(channel), offset);
      offset += buffer.length;
    }
  }

  return result;
}
