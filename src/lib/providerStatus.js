const API_BASE = import.meta.env.VITE_API_BASE || "/api";

export async function getProviderStatus() {
  const response = await fetch(`${API_BASE}/status/providers`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Provider status failed: ${response.status}`);
  }
  return data;
}
