// Matches the existing A0,A1 / 115200 parser. ENV is already conditioned EMG.
export const EMG_ARDUINO_SKETCH = `// Sarah: one or two analog ENV sensors (10-bit ADC, e.g. Uno/Nano).
// Sensor 1 ENV -> A0; Sensor 2 ENV -> A1. Use the sensor maker's power/wiring instructions.
// One-sensor mode reads A0 and ignores A1. Close Serial Monitor before Sarah connects.
// This records an ENV envelope, not raw broadband EMG.
const unsigned long SAMPLE_US = 10000; // 100 envelope samples/second
unsigned long nextSample;
void setup() {
  Serial.begin(115200);
  nextSample = micros();
}
void loop() {
  unsigned long now = micros();
  if ((long)(now - nextSample) >= 0) {
    nextSample = now + SAMPLE_US;
    int sensor1 = analogRead(A0);
    int sensor2 = analogRead(A1);
    Serial.print(sensor1);
    Serial.print(',');
    Serial.println(sensor2);
  }
}
`;
