import { useEffect, useRef, useState } from 'react';
import { eventsUrl } from './api';

export interface LiveEvent {
  type: string;
  [k: string]: unknown;
}

const TYPES = ['upload.started', 'upload.completed', 'upload.aborted', 'version.created', 'version.checked', 'late.attempt'];

/**
 * Subscribes to a server-sent event stream. EventSource reconnects by itself;
 * on every (re)connect we call onOpen so the page refetches and nothing
 * missed while offline is lost.
 */
export function useLive(path: string | null, onEvent: (e: LiveEvent) => void, onOpen?: () => void) {
  const handler = useRef(onEvent);
  const open = useRef(onOpen);
  handler.current = onEvent;
  open.current = onOpen;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!path) return;
    const es = new EventSource(eventsUrl(path));
    let opened = false;
    const listener = (msg: MessageEvent) => {
      try {
        handler.current(JSON.parse(msg.data));
      } catch {
        /* ignore */
      }
    };
    es.onopen = () => {
      setConnected(true);
      if (opened) open.current?.();
      opened = true;
    };
    es.onerror = () => setConnected(false);
    for (const t of TYPES) es.addEventListener(t, listener);
    return () => es.close();
  }, [path]);

  return connected;
}

/** Server clock offset, so countdowns follow the server, not the laptop. */
export function useServerClock(serverTime: string | undefined) {
  const offset = useRef(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (serverTime) offset.current = new Date(serverTime).getTime() - Date.now();
  }, [serverTime]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset.current), 250);
    return () => clearInterval(t);
  }, []);
  return now;
}
