import { useState, useRef, useCallback, useEffect } from "react";

/**
 * Cross-platform drag-to-zoom for recharts.
 * Touch handlers use refs so they always see fresh state/values.
 */
export function useChartZoom(dataMin, dataMax) {
  const [zoomDomain, setZoomDomain] = useState(null);
  const [selectRange, setSelectRange] = useState(null);

  const containerRef = useRef(null);
  const selectStartRef = useRef(null);
  const isDraggingRef = useRef(false); // true only after drag threshold is crossed
  const dataMinRef = useRef(dataMin);
  const dataMaxRef = useRef(dataMax);
  dataMinRef.current = dataMin;
  dataMaxRef.current = dataMax;

  // Pixel X → data value
  function pixelToValue(clientX) {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const MARGIN_LEFT = 30;
    const MARGIN_RIGHT = 10;
    const plotWidth = rect.width - MARGIN_LEFT - MARGIN_RIGHT;
    const relX = clientX - rect.left - MARGIN_LEFT;
    const clamped = Math.max(0, Math.min(relX, plotWidth));
    return dataMinRef.current + (clamped / plotWidth) * (dataMaxRef.current - dataMinRef.current);
  }

  // Store handlers in refs so addEventListener always calls the latest version
  const touchStartHandler = useRef(null);
  const touchMoveHandler = useRef(null);
  const touchEndHandler = useRef(null);

  touchStartHandler.current = (e) => {
    if (e.touches.length !== 1) return;
    const val = pixelToValue(e.touches[0].clientX);
    if (val == null) return;
    selectStartRef.current = val;
    isDraggingRef.current = false;
    setSelectRange(null);
  };

  touchMoveHandler.current = (e) => {
    if (e.touches.length !== 1 || selectStartRef.current == null) return;
    const val = pixelToValue(e.touches[0].clientX);
    if (val == null) return;
    const range = dataMaxRef.current - dataMinRef.current;
    const minDelta = range * 0.03; // must drag at least 3% of data range
    if (Math.abs(val - selectStartRef.current) > minDelta) {
      e.preventDefault();
      isDraggingRef.current = true;
      setSelectRange({
        x1: Math.min(selectStartRef.current, val),
        x2: Math.max(selectStartRef.current, val),
      });
    }
  };

  touchEndHandler.current = (e) => {
    if (selectStartRef.current == null) return;
    const val = pixelToValue(e.changedTouches[0].clientX);
    if (isDraggingRef.current && val != null) {
      setZoomDomain({
        x1: Math.min(selectStartRef.current, val),
        x2: Math.max(selectStartRef.current, val),
      });
    }
    selectStartRef.current = null;
    isDraggingRef.current = false;
    setSelectRange(null);
  };

  // Callback ref — attaches stable wrappers that delegate to the ref handlers
  const attachRef = useCallback((el) => {
    if (containerRef.current) {
      containerRef.current.removeEventListener("touchstart", stableTouchStart);
      containerRef.current.removeEventListener("touchmove", stableTouchMove);
      containerRef.current.removeEventListener("touchend", stableTouchEnd);
    }
    containerRef.current = el;
    if (!el) return;
    el.addEventListener("touchstart", stableTouchStart, { passive: true });
    el.addEventListener("touchmove", stableTouchMove, { passive: false });
    el.addEventListener("touchend", stableTouchEnd, { passive: true });
  }, []); // eslint-disable-line

  // Stable wrappers — these never change identity, so add/removeEventListener works
  function stableTouchStart(e) { touchStartHandler.current(e); }
  function stableTouchMove(e) { touchMoveHandler.current(e); }
  function stableTouchEnd(e) { touchEndHandler.current(e); }

  // Mouse events (recharts synthetic)
  const onMouseDown = useCallback((e) => {
    if (e?.activeLabel == null) return;
    selectStartRef.current = Number(e.activeLabel);
    isDraggingRef.current = false;
    setSelectRange(null);

    const handleGlobalMouseUp = (nativeE) => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
      if (selectStartRef.current == null) return;
      if (isDraggingRef.current) {
        const end = pixelToValue(nativeE.clientX);
        if (end != null) {
          setZoomDomain({ x1: Math.min(selectStartRef.current, end), x2: Math.max(selectStartRef.current, end) });
        }
      }
      selectStartRef.current = null;
      isDraggingRef.current = false;
      setSelectRange(null);
    };
    window.addEventListener("mouseup", handleGlobalMouseUp);
  }, []);

  const onMouseMove = useCallback((e) => {
    if (selectStartRef.current == null || e?.activeLabel == null) return;
    const cur = Number(e.activeLabel);
    const range = dataMaxRef.current - dataMinRef.current;
    const minDelta = range * 0.03;
    if (Math.abs(cur - selectStartRef.current) > minDelta) {
      isDraggingRef.current = true;
      setSelectRange({ x1: Math.min(selectStartRef.current, cur), x2: Math.max(selectStartRef.current, cur) });
    }
  }, []);

  const resetZoom = useCallback(() => {
    setZoomDomain(null);
    setSelectRange(null);
    selectStartRef.current = null;
    isDraggingRef.current = false;
  }, []);

  const isSelecting = selectRange != null;

  const chartProps = { onMouseDown, onMouseMove };

  const wrapperProps = {
    ref: attachRef,
    style: { touchAction: "pan-y" },
  };

  return { zoomDomain, resetZoom, isSelecting, selectRange, chartProps, wrapperProps };
}