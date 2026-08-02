const SAMPLE_RATE = 16_000;
const DURATION_SECONDS = 0.45;
const FREQUENCY_HZ = 440;

function writeWaveHeader(buffer, dataBytes) {
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
}

export function createMockWav() {
  const sampleCount = Math.floor(SAMPLE_RATE * DURATION_SECONDS);
  const dataBytes = sampleCount * 2;
  const output = Buffer.alloc(44 + dataBytes);
  writeWaveHeader(output, dataBytes);

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / sampleCount;
    const envelope = Math.sin(Math.PI * progress) ** 2;
    const sample =
      Math.sin((2 * Math.PI * FREQUENCY_HZ * index) / SAMPLE_RATE) *
      envelope *
      0.18;
    output.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }

  return output;
}
