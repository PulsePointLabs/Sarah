export function materializeProfileReviewBatchRequest(request = {}, sharedContext = '') {
  if (request.prompt) return request;

  const prompt = [request.promptPrefix, sharedContext, request.promptSuffix]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');

  const expanded = { ...request, prompt };
  delete expanded.promptPrefix;
  delete expanded.promptSuffix;
  return expanded;
}
