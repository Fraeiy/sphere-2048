import { useCallback, useRef } from 'react';

const MIN_DISTANCE = 28;

export function useSwipe(
  onSwipe: (direction: 'left' | 'right' | 'up' | 'down') => void,
  disabled?: boolean,
) {
  const start = useRef({ x: 0, y: 0, active: false });

  const finish = useCallback((endX: number, endY: number) => {
    const dx = endX - start.current.x;
    const dy = endY - start.current.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (Math.max(absX, absY) < MIN_DISTANCE) return;
    if (absX > absY) onSwipe(dx > 0 ? 'right' : 'left');
    else onSwipe(dy > 0 ? 'down' : 'up');
  }, [onSwipe]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled || e.touches.length !== 1) return;
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, active: true };
  }, [disabled]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!start.current.active) return;
    start.current.active = false;
    const touch = e.changedTouches[0];
    if (touch) finish(touch.clientX, touch.clientY);
  }, [finish]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled || e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, active: true };
  }, [disabled]);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!start.current.active) return;
    start.current.active = false;
    finish(e.clientX, e.clientY);
  }, [finish]);

  return {
    onTouchStart,
    onTouchEnd,
    onMouseDown,
    onMouseUp,
    onTouchMove: (e: React.TouchEvent) => {
      if (!start.current.active) return;
      const dx = Math.abs(e.touches[0].clientX - start.current.x);
      const dy = Math.abs(e.touches[0].clientY - start.current.y);
      if (dx > 8 || dy > 8) e.preventDefault();
    },
  };
}