export function decideObsSessionLifecycleTransition({
  previousActive = false,
  nextActive = false,
  hasActiveSession = false,
} = {}) {
  if (nextActive && (!previousActive || !hasActiveSession)) return 'start';
  if (previousActive && !nextActive && hasActiveSession) return 'finalize';
  return 'none';
}
