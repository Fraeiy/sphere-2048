import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_MS = 5000;

export function useTimedError(timeoutMs = DEFAULT_MS) {
  const [error, setErrorState] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setError = useCallback((message: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setErrorState(message);
    if (message) {
      timerRef.current = setTimeout(() => {
        setErrorState('');
        timerRef.current = null;
      }, timeoutMs);
    }
  }, [timeoutMs]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return [error, setError] as const;
}