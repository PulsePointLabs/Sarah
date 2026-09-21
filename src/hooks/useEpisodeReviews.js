import { useEffect, useState, useCallback } from 'react';
import { apiUrl } from '../lib/mobileApiBase';

export function useEpisodeReviews(recordId, isExploration) {
  const [reviews,setReviews] = useState([]), [error,setError] = useState(''), [submitting,setSubmitting] = useState(false);
  const url = `/entities/${isExploration ? 'BodyExploration' : 'Session'}/${encodeURIComponent(recordId)}/episode-reviews`;
  const request = useCallback(async (body, signal) => {
    const response = await fetch(apiUrl(url), {signal, ...(body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Episode review request failed');
    return value;
  },[url]);
  useEffect(()=>{
    setReviews([]);setError('');
    const controller = new AbortController();let timer;
    const poll = async () => {
      try {const value = await request(null,controller.signal);if(!controller.signal.aborted){setReviews(Array.isArray(value)?value:[]);setError('');}}
      catch(err){if(!controller.signal.aborted)setError(err.message);}
      if(!controller.signal.aborted)timer=setTimeout(poll,3000);
    };
    poll();return()=>{controller.abort();clearTimeout(timer);};
  },[request]);
  const run = async body => {
    setSubmitting(true);setError('');
    try {await request(body);setReviews(await request());}
    catch(err){setError(err.message);}
    finally {setSubmitting(false);}
  };
  return {reviews,error,submitting,run};
}
