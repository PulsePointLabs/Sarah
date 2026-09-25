import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import LiveCaptureLaunchpad from '/src/components/LiveCaptureLaunchpad.jsx';
import '/src/index.css';

function Fixture() {
  const [attempts, setAttempts] = useState(0);
  return <main className="mx-auto max-w-4xl p-3">
    <LiveCaptureLaunchpad obsRequired={false} primaryLabel="Connect H10 and Start Session"
      readiness={{
        h10: { value: 'Waiting packet', tone: 'warn', helper: 'H10 connected · 60,628 readings saved on phone, waiting to sync',
          error: 'Live H10 upload: HTTP 400: H10 has no usable heart-rate reading. Check strap contact.',
          action: { label: 'Reconnect H10', onClick: () => setAttempts((n) => n + 1) } },
        obs: { value: 'Ready', tone: 'good' }, voice: { value: 'Disabled' }, howl: { value: 'Ready', tone: 'good' },
      }} />
    <output>Reconnect attempts: {attempts}</output>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
