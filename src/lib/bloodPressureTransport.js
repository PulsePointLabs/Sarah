// The native durable queue retries this same external ID until Sarah confirms it.
export async function postBloodPressureReadings(readings, { url, discover, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ readings }), signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || `BP save failed (HTTP ${response.status}).`);
        error.status = response.status;
        throw error;
      }
      if (!data.ok || !Array.isArray(data.readings) || !readings.every(input => data.readings.some(saved =>
        input.external_id ? saved.external_id === input.external_id : saved.measured_at === input.measured_at
          && saved.systolic_mm_hg === input.systolic_mm_hg && saved.diastolic_mm_hg === input.diastolic_mm_hg))) {
        throw new Error('Sarah did not confirm saving this cuff reading. It remains on the phone.');
      }
      return data;
    } catch (error) {
      if (attempt === 0 && discover && (!error.status || [502, 503, 504].includes(error.status))) {
        clearTimeout(timer);
        await discover();
        continue;
      }
      if (error.name === 'AbortError') throw new Error('Sarah did not respond. Reading kept on phone; retrying automatically.');
      throw error;
    } finally { clearTimeout(timer); }
  }
}
